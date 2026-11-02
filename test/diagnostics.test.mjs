import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FailureLogger, diagnosticText, logDirectory } from '../lib/diagnostics.mjs';
import { OpenCodeBridge } from '../lib/bridge.mjs';
import { nativeToolName, sseEvents } from '../lib/protocol.mjs';

test('diagnostics use Linux state storage and redact echoed credentials and payloads', () => {
  assert.equal(logDirectory({ XDG_STATE_HOME: '/private/state' }, 'linux'), path.join('/private/state', 'opencode-proxy', 'logs'));
  const text = diagnosticText('Invalid type: expected string\nAuthorization: Bearer secret_bearer\nCookie: session=abc; other=def\napiKey=topsecret\nhttps://user:pass@host/path?token=secret\nValue: {"private": "hello"}\nPRIVATE_PROMPT\n-----BEGIN PRIVATE KEY-----\nkeydata\n-----END PRIVATE KEY-----', ['PRIVATE_PROMPT']);
  assert.match(text, /Invalid type: expected string/);
  for (const secret of ['secret_bearer', 'session=abc', 'other=def', 'topsecret', 'user:pass', 'token=secret', 'hello', 'PRIVATE_PROMPT', 'keydata']) assert.ok(!text.includes(secret), secret);
});

test('failure log rotates, bounds pending writes and ignores unsafe callback fields', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'proxy-log-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const logger = new FailureLogger({ directory, maxBytes: 1400, maxPending: 2, stderr() {} });
  for (let i = 0; i < 8; i++) await logger.record({ requestId: String(i), phase: 'inference', error: new Error('expected object'), output: 'PRIVATE_CHILD_LOG', home: 'PRIVATE_PATH', body: 'PRIVATE_BODY' });
  await Promise.all(Array.from({ length: 40 }, () => logger.record({ error: new Error('burst') })));
  assert.ok(logger.dropped > 0); await logger.record({ error: new Error('after burst') });
  await logger.close(); assert.equal(logger.pending, 0);
  assert.deepEqual((await readdir(directory)).sort(), ['diagnostics.jsonl', 'diagnostics.jsonl.1']);
  const all = (await Promise.all(['diagnostics.jsonl', 'diagnostics.jsonl.1'].map(f => readFile(path.join(directory, f), 'utf8')))).join('');
  assert.doesNotMatch(all, /PRIVATE_/);
  assert.ok(all.trim().split('\n').map(JSON.parse).some(r => r.dropped > 0));
});

test('disabled or unwritable diagnostics cannot replace an inference failure', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'proxy-log-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const blocked = path.join(directory, 'not-directory'); await writeFile(blocked, 'keep');
  const lines = [], logger = new FailureLogger({ directory: blocked, stderr: s => lines.push(s) });
  await logger.record({ error: new Error('inference failed') }); await logger.close();
  assert.match(lines[0], /diagnostic_write_failed/); assert.equal(await readFile(blocked, 'utf8'), 'keep');
  const off = new FailureLogger({ directory: blocked, enabled: false }); await off.record({ error: new Error('off') }); await off.close();
});

for (const stream of [false, true]) test(`tool failures preserve safe native reasons and correlation (stream=${stream})`, async () => {
  const bridge = new OpenCodeBridge({ mode: 'global', discoverModels: false, diagnostics: false });
  bridge.config.onFailure = async () => {};
  const failures = [], signal = new AbortController().signal;
  bridge.prepare = async () => ({ sessionID: 's', version: 'custom-1.16.2', lifecycle: { id: 'request-123', timings: {}, clientOutput() {} }, signal,
    diagnose: async d => failures.push(d), cleanup: async () => {},
    events: (async function* () {
      yield { type: 'message.updated', properties: { info: { id: 'm', sessionID: 's', role: 'assistant' } } };
      yield { type: 'message.part.updated', properties: { part: { type: 'tool', messageID: 'm', sessionID: 's', tool: nativeToolName('lookup'), callID: 'call-1', state: { status: 'pending' } } } };
      yield { type: 'message.part.updated', properties: { part: { type: 'tool', messageID: 'm', sessionID: 's', tool: nativeToolName('lookup'), callID: 'call-1', state: {
        status: 'error', input: { city: 'PRIVATE_CITY' }, error: 'Schema expected string, got object: PRIVATE_CITY\nCookie: secret_cookie',
      } } } };
    })(),
  });
  const response = await bridge.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'oc-default', messages: [{ role: 'user', content: 'private prompt' }], tools: [{ type: 'function', function: { name: 'lookup' } }], stream }) });
  const result = stream ? (await Array.fromAsync(sseEvents(response.body))).find(c => c.error) : await response.json();
  assert.equal(result.error.code, 'opencode_tool_error'); assert.match(result.error.message, /lookup.*Schema expected string/);
  assert.doesNotMatch(result.error.message, /PRIVATE_CITY|secret_cookie/);
  assert.equal(response.headers.get('x-opencode-request-id'), 'request-123');
  assert.equal(failures[0].error.tool.name, 'lookup'); assert.equal(failures[0].error.tool.callId, 'call-1');
  assert.equal(failures[0].events.at(-1).status, 'error');
  await bridge.close();
});
