import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { OpenCodeProxyPlugin } from '../index.mjs';
import { sseEvents } from '../lib/protocol.mjs';
import { toolCalls } from './tool-deltas.mjs';
import { globalProfile } from './global-profile.mjs';

const command = process.env.TEST_OPENCODE_COMMAND;
if (!command) throw new Error('Set TEST_OPENCODE_COMMAND to a JSON command array for a real OpenCode runtime.');

test('Magpie plugin uses real OpenCode authentication, tools, refresh and shutdown in a disposable profile', { timeout: 120000 }, async t => {
  const profile = await globalProfile();
  let hooks;
  t.after(async () => { await hooks?.dispose(); await profile.close(); });
  hooks = await OpenCodeProxyPlugin({ directory: profile.home, magpie: {} }, {
    command: JSON.parse(command), startupTimeoutMs: 20000, firstOutputTimeoutMs: 20000,
  });
  const auth = { type: 'api', key: 'local' };
  const cfg = {}; await hooks.config(cfg);
  const list = () => hooks.provider.models({ models: {} }, { auth });
  const catalog = await list();
  assert.ok(catalog.mock);
  assert.equal(catalog.mock.api.npm, '@ai-sdk/openai-compatible');
  assert.equal(profile.requests.length, 0, 'Discovery must never initiate inference');
  const loader = await hooks.auth.loader(async () => auth);
  const send = body => loader.fetch(loader.baseURL + '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'mock', ...body }), headers: { authorization: 'Bearer MAGPIE_MARKER' } });
  const body = { messages: [{ role: 'system', content: 'SYSTEM_SENTINEL' }, { role: 'user', content: 'hello' }], temperature: 0.2, max_tokens: 123 };
  const response = await send(body);
  const whole = await response.json();
  assert.equal(response.status, 200, JSON.stringify(whole));
  assert.equal(whole.choices[0].message.content, '你好，Magpie。');
  assert.equal(whole.usage.total_tokens, 15);
  assert.equal(profile.requests.length, 1, 'One external turn must cause one inference');
  assert.equal(profile.requests[0].authorization, 'Bearer fixture-renewed');
  assert.equal(profile.requests[0].marker, 'real-plugin');
  assert.equal(profile.requests[0].body.messages[0].content, 'SYSTEM_SENTINEL');
  assert.equal(profile.requests[0].body.temperature, 0.2);
  assert.equal(profile.requests[0].body.max_tokens, 123);
  assert.equal(profile.refreshes(), 1);
  assert.equal(JSON.parse(await readFile(profile.authFile, 'utf8')).fixture.access, 'fixture-renewed');
  assert.equal(await readFile(profile.configPath, 'utf8'), profile.original);

  const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
  const messages = [{ role: 'user', content: 'CALL_TOOL' }];
  const stream = await send({ messages, tools, stream: true, stream_options: { include_usage: true } });
  assert.equal(stream.status, 200);
  const chunks = await Array.fromAsync(sseEvents(stream.body));
  const calls = toolCalls(chunks);
  assert.equal(calls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: '北京' });
  const continuation = await send({ messages: [...messages, { role: 'assistant', content: null, tool_calls: calls }, { role: 'tool', tool_call_id: calls[0].id, content: 'CLIENT_RESULT' }], tools });
  assert.equal((await continuation.json()).choices[0].message.content, 'Tool result received.');
  assert.equal(profile.requests.length, 3, 'The bridge cannot run the client tool or continue inference on its own');
  const rejected = await send({ messages: [{ role: 'user', content: 'REJECT' }] });
  assert.equal(rejected.status, 403);
  await rejected.text();

  const next = JSON.parse(profile.original);
  delete next.provider.fixture.models.mock;
  next.provider.fixture.models.next = { name: 'Next', limit: { context: 32000, output: 1000 } };
  await writeFile(profile.configPath, JSON.stringify(next));
  const refreshed = await list();
  assert.equal(refreshed.mock, undefined, 'Removed models cannot persist through refresh');
  assert.ok(refreshed.next);
  assert.equal((await send({ messages: [{ role: 'user', content: 'hello' }] })).status, 404);
  await hooks.dispose();
  await assert.rejects(list(), /stopped/);
});
