import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createPlugin } from '../lib/magpie-plugin.mjs';
import { globalProfile } from './global-profile.mjs';
import { sseEvents, nativeToolName } from '../lib/protocol.mjs';

if (!process.env.TEST_OPENCODE_COMMAND) throw new Error('Set TEST_OPENCODE_COMMAND to a real command array.');

test('real OpenCode tool hook failures reach persistent diagnostics without echoed arguments', { timeout: 90000 }, async t => {
  const profile = await globalProfile({ toolFailure: 'Fixture tool rejection: SENSITIVE_CITY\nCookie: fixture-session=valid', respond: async ({ body, res }) => {
    const name = body.tools.find(t => t.function.name === nativeToolName('lookup')).function.name;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'native-error', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'bad-tool-1', type: 'function', function: {
      name, arguments: JSON.stringify({ city: 'SENSITIVE_CITY' }),
    } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 } }) + '\n\ndata: [DONE]\n\n');
    return true;
  } });
  const directory = path.join(profile.home, 'diagnostics');
  const hooks = await createPlugin()({ magpie: {}, directory: profile.home }, {
    command: JSON.parse(process.env.TEST_OPENCODE_COMMAND), logDirectory: directory,
    startupTimeoutMs: 20000, firstOutputTimeoutMs: 20000,
  });
  t.after(async () => { await hooks.dispose(); await profile.close(); });
  const auth = { type: 'api', key: 'local' };
  await hooks.provider.models({}, { auth });
  const loader = await hooks.auth.loader(async () => auth);
  const response = await loader.fetch('http://opencode-proxy.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'mock', stream: true,
    messages: [{ role: 'user', content: 'PRIVATE_PROMPT_123' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: {
      type: 'object', properties: { city: { type: 'string' } }, required: ['city'],
    } } }],
  }) });
  const frames = response.headers.get('content-type')?.includes('text/event-stream') ? await Array.fromAsync(sseEvents(response.body)) : [await response.json()];
  const failure = frames.find(frame => frame.error);
  assert.equal(failure?.error.code, 'opencode_tool_error', JSON.stringify(frames));
  assert.match(failure.error.message, /lookup/);
  await hooks.dispose();
  const text = await readFile(path.join(directory, 'diagnostics.jsonl'), 'utf8');
  const record = text.trim().split('\n').map(JSON.parse).find(r => r.error.code === 'opencode_tool_error');
  assert.ok(record); assert.equal(record.phase, 'inference'); assert.equal(record.tool.name, 'lookup');
  assert.ok(record.tool.reason); assert.equal(record.requestId, response.headers.get('x-opencode-request-id'));
  assert.ok(record.openCodeVersion); assert.ok(record.sessionId); assert.equal(profile.requests.length, 1);
  assert.doesNotMatch(text, /SENSITIVE_CITY|PRIVATE_PROMPT_123|fixture-session|fixture-renewed/);
});
