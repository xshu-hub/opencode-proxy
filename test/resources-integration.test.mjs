import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { OpenCodeBridge } from '../lib/bridge.mjs';
import { nativeToolName } from '../lib/protocol.mjs';
import { globalProfile } from './global-profile.mjs';

if (!process.env.TEST_OPENCODE_COMMAND) throw new Error('Set TEST_OPENCODE_COMMAND to a real OpenCode command array.');

test('shared resources preserve cross-provider signing, tool schemas, model refresh and active requests', { timeout: 180000 }, async t => {
  const release = Promise.withResolvers();
  const profile = await globalProfile({ multipleModels: true, respond: async ({ res, body }) => {
    const text = body.messages.at(-1).content;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = content => 'data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n';
    res.write(chunk(body.model + '|' + text + '|你好🌍'));
    if (text === 'HELD_DURING_REFRESH') await release.promise;
    if (!res.destroyed) res.end('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\ndata: [DONE]\n\n');
    return true;
  } });
  let bridge;
  const originalFetch = globalThis.fetch, connections = { local: 0, global: 0 };
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.pathname === '/event') connections.local++;
    if (url.pathname === '/global/event') connections.global++;
    return originalFetch(input, init);
  };
  t.after(async () => { release.resolve(); await bridge?.close(); globalThis.fetch = originalFetch; await profile.close(); });
  const auth = JSON.parse(await readFile(profile.authFile, 'utf8'));
  auth.fixture.access = 'fixture-ready'; auth.fixture.expires = Date.now() + 3600000;
  await writeFile(profile.authFile, JSON.stringify(auth));
  bridge = new OpenCodeBridge({ mode: 'global', command: JSON.parse(process.env.TEST_OPENCODE_COMMAND), workingDirectory: profile.home,
    startupTimeoutMs: 30000, firstOutputTimeoutMs: 60000, diagnostics: false });
  const models = await bridge.loadModels();
  const choices = ['mock', 'mock-alt', 'secondary', 'secondary-alt'];
  const send = (model, text, extra = {}) => bridge.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({
    model, messages: [{ role: 'system', content: 'CLIENT_SYSTEM' }, { role: 'user', content: text }], stream: true, ...extra,
  }) });
  await Promise.all(Array.from({ length: 16 }, async (_, i) => {
    const model = choices[i % choices.length], response = await send(model, 'ISOLATED_' + i + '_END', { temperature: i / 20, max_tokens: 128 + i });
    assert.equal(response.status, 200, await response.clone().text());
    const text = await response.text(); assert.ok(text.includes(model + '|ISOLATED_' + i + '_END|你好🌍'));
    for (let other = 0; other < 16; other++) if (other !== i) assert.ok(!text.includes('ISOLATED_' + other + '_END'));
  }));
  await bridge.drain();
  assert.equal(profile.requests.length, 16); assert.equal(new Set(profile.requests.map(request => request.pid)).size, 1);
  assert.deepEqual(connections, { local: 0, global: 1 });
  for (const request of profile.requests) {
    const i = Number(/ISOLATED_(\d+)_END/.exec(request.body.messages.at(-1).content)[1]);
    assert.equal(request.authorization, request.body.model.startsWith('secondary') ? 'Bearer fixture-secondary-key' : 'Bearer fixture-ready');
    assert.equal(request.body.temperature, i / 20); assert.equal(request.body.max_tokens, 128 + i);
    assert.equal(request.signature, request.expectedSignature); assert.equal(request.cookie, 'fixture-session=valid');
  }
  const oldEntry = [...bridge.shared.entries.values()][0], oldPid = profile.requests[0].pid;
  assert.equal(oldEntry.process.mcp, undefined, 'Text-only contracts must not allocate an empty MCP server');
  assert.equal(oldEntry.process.sessionEvents.stats.subscribers, 0); assert.equal(oldEntry.process.sessionEvents.stats.queuedBytes, 0);
  const held = await send('mock', 'HELD_DURING_REFRESH'); assert.equal(held.status, 200);
  const reader = held.body.getReader(); assert.equal((await reader.read()).done, false);
  const config = JSON.parse(profile.original);
  config.provider['fixture-secondary'].options.headers = { 'x-fixture-revision': 'updated' };
  auth['fixture-secondary'].key = 'fixture-secondary-updated';
  await writeFile(profile.configPath, JSON.stringify(config)); await writeFile(profile.authFile, JSON.stringify(auth));
  const refreshed = await bridge.loadModels(true);
  assert.deepEqual(Object.keys(refreshed).sort(), Object.keys(models).sort(), 'Config changes can preserve every published model ID');
  const next = await send('secondary', 'AFTER_REFRESH'); assert.equal(next.status, 200, await next.clone().text()); await next.text();
  const sent = profile.requests.at(-1);
  assert.equal(sent.authorization, 'Bearer fixture-secondary-updated'); assert.equal(sent.revision, 'updated');
  assert.notEqual(sent.pid, oldPid, 'New requests must not reuse cached provider configuration');
  release.resolve(); while (!(await reader.read()).done) {} await bridge.drain();
  assert.equal(bridge.shared.all.size, 1, 'The old generation exits after its last active request');
  const beforeTools = profile.requests.length;
  await Promise.all(['string', 'integer'].map(async type => {
    const result = await send('mock', 'SCHEMA_' + type, { tools: [{ type: 'function', function: { name: 'lookup', parameters: {
      type: 'object', properties: { city: { type } }, required: ['city'],
    } } }] });
    assert.equal(result.status, 200, await result.clone().text()); await result.text();
  }));
  await bridge.drain();
  const toolRequests = profile.requests.slice(beforeTools); assert.equal(toolRequests.length, 2);
  assert.equal(new Set(toolRequests.map(request => request.pid)).size, 2, 'Different schemas cannot share a mutable tool definition');
  for (const request of toolRequests) {
    const type = request.body.messages.at(-1).content.slice('SCHEMA_'.length);
    assert.equal(request.body.tools.find(tool => tool.function.name === nativeToolName('lookup')).function.parameters.properties.city.type, type);
  }
  for (const entry of bridge.shared.entries.values()) {
    assert.equal(entry.process.sessionEvents.stats.subscribers, 0); assert.equal(entry.process.sessionEvents.stats.queuedBytes, 0);
  }
  assert.equal(bridge.active, 0); assert.equal(bridge.controllers.size, 0);
});
