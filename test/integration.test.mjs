import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { OpenCodeBridge } from '../lib/bridge.mjs';
import { nativeToolName, sseEvents } from '../lib/protocol.mjs';

const command = process.env.TEST_OPENCODE_COMMAND;
if (!command) throw new Error('Set TEST_OPENCODE_COMMAND to a JSON executable/argument array for OpenCode.');
const requests = [];
const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  requests.push({ url: req.url, auth: req.headers.authorization, body });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: reason }], ...(usage ? { usage } : {}) })}\n\n`);
  const text = body.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(' ');
  if (text.includes('UPSTREAM_ERROR')) { res.end('data: {"error":{"message":"synthetic upstream failure"}}\n\n'); return; }
  if (text.includes('HANG_FOREVER')) { emit({ role: 'assistant', content: 'Waiting' }); return; }
  if (body.messages.some(m => m.role === 'tool')) {
    emit({ role: 'assistant', content: 'Tool result received: 北京 23C; 10:00.' });
    emit({}, 'stop', { prompt_tokens: 22, completion_tokens: 8, total_tokens: 30 });
  } else if (text.includes('CALL_TWO_TOOLS')) {
    emit({ role: 'assistant', content: 'Checking.' });
    for (const [i, name] of ['weather', 'clock'].entries()) {
      emit({ tool_calls: [{ index: i, id: 'call_' + name, type: 'function', function: { name: nativeToolName(name), arguments: '' } }] });
      emit({ tool_calls: [{ index: i, function: { arguments: '{"city":"北京"}' } }] });
    }
    emit({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  } else {
    emit({ role: 'assistant', content: '你' }); emit({ content: '好，OpenCode v1。' });
    emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  }
  res.end('data: [DONE]\n\n');
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const config = { workerReuse: false, diagnostics: false, command: JSON.parse(command), maxConcurrent: 1, timeoutMs: 30000, startupTimeoutMs: 15000, models: { 'oc-mock': { protocol: 'openai-chat', baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, id: 'mock', context: 100000, output: 1000 } } };
config.onFailure = async ({ phase, home, output }) => {
  console.log('OpenCode fixture failure stage:', phase, 'output:', output);
  const dir = path.join(home, 'data', 'opencode', 'log');
  for (const name of await readdir(dir).catch(() => [])) console.log('OpenCode fixture log:', (await readFile(path.join(dir, name), 'utf8')).slice(-12000));
};
const bridge = new OpenCodeBridge(config);
const request = (body, signal) => bridge.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'oc-mock', ...body }), signal }, 'local-test-key');

test('real unmodified v1 initiates inference with role history, system and generation parameters', { timeout: 40000 }, async () => {
  const before = requests.length;
  const response = await request({ messages: [{ role: 'system', content: 'SYSTEM_SENTINEL' }, { role: 'user', content: 'Previous user' }, { role: 'assistant', content: 'Previous assistant', reasoning_content: 'PRIOR_REASONING_SENTINEL' }, { role: 'user', content: 'Say hello' }], temperature: 0.2, top_p: 0.9, max_tokens: 123, reasoning_effort: 'high' });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  if (process.env.TEST_OPENCODE_VERSION) assert.equal(response.headers.get('x-opencode-version'), process.env.TEST_OPENCODE_VERSION);
  assert.equal(result.choices[0].message.content, '你好，OpenCode v1。');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.usage.total_tokens, 15);
  assert.equal(requests.length, before + 1, 'One client request must cause exactly one upstream inference');
  const sent = requests.at(-1);
  assert.equal(sent.auth, 'Bearer local-test-key');
  assert.deepEqual(sent.body.messages.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(sent.body.messages[0].content, 'SYSTEM_SENTINEL');
  assert.equal(sent.body.messages[2].content, 'Previous assistant');
  assert.equal(sent.body.messages[2].reasoning_content, 'PRIOR_REASONING_SENTINEL');
  assert.equal(sent.body.messages.at(-1).content, 'Say hello');
  assert.equal(sent.body.temperature, 0.2);
  assert.equal(sent.body.top_p, 0.9);
  assert.equal(sent.body.max_tokens, 123);
  assert.equal(sent.body.reasoning_effort, 'high');
  assert.deepEqual(sent.body.tools ?? [], [], 'No built-in shell or file tools');
  assert.equal(bridge.active, 0);
});
test('parallel client tools stream as one batch and stateless results continue in a new v1 worker', { timeout: 80000 }, async () => {
  const tools = ['weather', 'clock'].map(name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } }));
  const messages = [{ role: 'user', content: 'CALL_TWO_TOOLS' }];
  const response = await request({ messages, tools, stream: true, stream_options: { include_usage: true } });
  assert.equal(response.status, 200);
  const chunks = await Array.fromAsync(sseEvents(response.body));
  assert.equal(chunks.some(c => c.error), false, JSON.stringify(chunks));
  const calls = chunks.flatMap(c => c.choices[0]?.delta.tool_calls ?? []);
  assert.deepEqual(calls.map(c => c.function.name), ['weather', 'clock']);
  assert.equal(calls[0].function.arguments, '{"city":"北京"}');
  assert.equal(chunks.find(c => c.choices[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
  assert.equal(chunks.at(-1).usage.total_tokens, 15);
  assert.equal(bridge.active, 0);
  const assistant = { role: 'assistant', content: 'Checking.', tool_calls: calls.map(({ index, ...call }) => call) };
  const continuation = await request({ messages: [...messages, assistant, { role: 'tool', tool_call_id: 'call_clock', content: '10:00' }, { role: 'tool', tool_call_id: 'call_weather', content: '北京 23C' }], tools });
  const result = await continuation.json();
  assert.equal(continuation.status, 200, JSON.stringify(result));
  assert.match(result.choices[0].message.content, /Tool result received/);
  const sent = requests.at(-1).body.messages;
  assert.deepEqual(sent.map(m => m.role), ['user', 'assistant', 'tool', 'tool']);
  assert.equal(sent[1].tool_calls.length, 2);
  assert.equal(sent[2].tool_call_id, 'call_weather');
  assert.equal(sent[2].content, '北京 23C');
  assert.equal(sent[3].content, '10:00');
});
test('cancelled stream kills real worker and releases concurrency for next request', { timeout: 60000 }, async () => {
  const ctl = new AbortController();
  const response = await request({ messages: [{ role: 'user', content: 'HANG_FOREVER' }], stream: true }, ctl.signal);
  const reader = response.body.getReader();
  await reader.read();
  const busy = await request({ messages: [{ role: 'user', content: 'Another client' }] });
  assert.equal(busy.status, 429);
  ctl.abort();
  await reader.cancel();
  assert.equal(bridge.active, 0);
  const next = await request({ messages: [{ role: 'user', content: 'New request' }] });
  assert.equal(next.status, 200, JSON.stringify(await next.json()));
  assert.equal(bridge.active, 0);
});
test('invalid parameter cannot reach the upstream', async () => {
  const before = requests.length;
  const response = await request({ messages: [{ role: 'user', content: 'Hello' }], n: 2 });
  assert.equal(response.status, 400);
  assert.equal(requests.length, before);
});
test('reused isolated workers keep different upstream credentials in separate processes', { timeout: 60000 }, async () => {
  const reports = [];
  const selected = new OpenCodeBridge({ ...config, workerReuse: true, onDiagnostics: r => reports.push(r) });
  try {
    for (const key of ['fixture-key-a', 'fixture-key-a', 'fixture-key-b']) {
      const response = await selected.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'oc-mock', messages: [{ role: 'user', content: 'Hello' }] }) }, key);
      assert.equal(response.status, 200, await response.text());
      assert.equal(requests.at(-1).auth, 'Bearer ' + key);
    }
    assert.deepEqual(reports.map(r => r.workerReused), [false, true, false]);
    assert.equal(selected.pool.workers.size, 2);
  } finally { await selected.close(); }
});

test('cleanup fixture server', async () => { upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); });
