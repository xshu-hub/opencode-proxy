import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { executableCommand } from '../lib/command.mjs';
import { globalProfile } from './global-profile.mjs';
import { sseEvents } from './sse.mjs';
import { toolCalls } from './tool-deltas.mjs';

if (!process.env.TEST_MAGPIE_HOST) throw new Error('Set TEST_MAGPIE_HOST to Magpie internal/plugin/host.js.');
const source = path.resolve(process.env.TEST_MAGPIE_HOST);
const root = fileURLToPath(new URL('../', import.meta.url));

test('the real Magpie Bun host loads the package, lists models and streams real OpenCode inference', { timeout: 120000 }, async t => {
  const command = JSON.parse(process.env.TEST_OPENCODE_COMMAND ?? '["opencode"]');
  const bun = await executableCommand(JSON.parse(process.env.TEST_BUN_COMMAND ?? '["bun"]'));
  const profile = await globalProfile({ respond: ({ res, body }) => {
    const id = body.metadata?.user_id;
    if (!id?.startsWith('rpc-isolation-')) return false;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-fixture-request': id });
    res.end('data: ' + JSON.stringify({ id, choices: [{ index: 0, delta: { content: id }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n'); return true;
  } });
  const child = spawn(bun[0], [...bun.slice(1), source], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env }, cwd: profile.home });
  let stderr = '', sequence = 0;
  const pending = new Map();
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const write = message => child.stdin.write(JSON.stringify(message) + '\n');
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const waiter = pending.get(value.id);
    if (!waiter) return;
    if (value.event) {
      waiter.frames.push(value);
      waiter.onFrame?.(value);
      if (value.event === 'chunk' && waiter.autoCredit) write({ method: 'credit', params: { id: value.id, n: Buffer.from(value.data, 'base64').length + 2048 } });
      return;
    }
    pending.delete(value.id); clearTimeout(waiter.timer);
    if (value.error) waiter.reject(new Error(value.error.message + '\n' + stderr));
    else waiter.resolve({ result: value.result, frames: waiter.frames });
  });
  const rpc = (method, params = {}, { autoCredit = true, onFrame } = {}) => {
    const id = ++sequence;
    const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out\n${stderr}`)); }, 45000);
    pending.set(id, { resolve, reject, frames: [], timer, autoCredit, onFrame });
    write({ id, method, params });
    });
    return Object.assign(promise, { id });
  };
  const abort = task => {
    write({ method: 'abort', params: { id: task.id } });
    const waiter = pending.get(task.id);
    if (waiter) { pending.delete(task.id); clearTimeout(waiter.timer); waiter.reject(new DOMException('Fixture caller cancelled', 'AbortError')); }
  };
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000); timer.unref();
    try {
      await exited;
      const deadline = Date.now() + 6000;
      const pids = (await readFile(profile.pidsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
      const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
      while (pids.some(alive) && Date.now() < deadline) await delay(100);
      assert.deepEqual(pids.filter(alive), [], 'OpenCode workers must stop after the Magpie host exits');
    } finally {
      clearTimeout(timer);
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      lines.close();
      await profile.close();
    }
  });
  const init = await rpc('init', {
    authPath: path.join(profile.home, 'magpie-auth.json'), directory: profile.home,
    plugins: [{ spec: root, target: root, options: { command, startupTimeoutMs: 20000, firstOutputTimeoutMs: 20000, idleTimeoutMs: 200 } }],
  });
  assert.equal(init.result.plugins.length, 1);
  assert.equal(init.result.plugins[0].error, undefined, JSON.stringify(init.result));
  const first = (await rpc('providers')).result;
  assert.equal(first[0].id, 'opencode-proxy');
  assert.equal(first[0].signedIn, false);
  assert.equal(first[0].methods[0].keyless, true);
  assert.equal((await rpc('apiKey', { provider: 'opencode-proxy', method: 0 })).result.ok, true);
  const listed = (await rpc('providers')).result[0];
  assert.equal(listed.signedIn, true);
  assert.equal(listed.fellBack, false, JSON.stringify(listed));
  assert.ok(listed.models.some(m => m.id === 'mock'), JSON.stringify(listed));
  const loaded = (await rpc('load', { provider: 'opencode-proxy' })).result;
  assert.equal(loaded.fetch, true);
  const fetched = await rpc('fetch', {
    provider: 'opencode-proxy', model: 'mock', npm: '@ai-sdk/openai-compatible',
    url: loaded.baseURL + '/chat/completions', method: 'POST',
    body: Buffer.from(JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hello' }], stream: true, stream_options: { include_usage: true } })).toString('base64'),
  });
  assert.equal(fetched.frames[0].status, 200);
  const text = Buffer.concat(fetched.frames.filter(f => f.event === 'chunk').map(f => Buffer.from(f.data, 'base64'))).toString('utf8');
  assert.match(text, /你好，Magpie/);
  assert.match(text, /\[DONE\]/);
  assert.equal(profile.requests.length, 1);
  assert.equal(profile.requests[0].authorization, 'Bearer fixture-renewed');
  assert.equal(profile.requests[0].marker, 'real-plugin');
  const rawBody = result => Buffer.concat(result.frames.filter(f => f.event === 'chunk').map(f => Buffer.from(f.data, 'base64')));
  const fetchRPC = (body, options) => rpc('fetch', { provider: 'opencode-proxy', model: 'mock', npm: '@ai-sdk/openai-compatible', url: loaded.baseURL + '/chat/completions', method: 'POST', body: Buffer.from(JSON.stringify(body)).toString('base64'), window: 128 * 1024 }, options);
  const clientTools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
  const firstTurn = { model: 'mock', messages: [{ role: 'system', content: 'HOST_SYSTEM' }, { role: 'user', content: 'CALL_TOOL' }], tools: clientTools, stream: true };
  const toolStream = await fetchRPC(firstTurn);
  const calls = toolCalls(await Array.fromAsync(sseEvents(new Response(rawBody(toolStream)).body))).map(({ index: unused, ...call }) => call);
  assert.equal(calls[0].function.name, 'lookup');
  const secondTurn = { model: 'mock', messages: [...firstTurn.messages, { role: 'assistant', content: null, tool_calls: calls }, { role: 'tool', tool_call_id: calls[0].id, content: 'HOST_CLIENT_RESULT' }], tools: clientTools };
  assert.equal(JSON.parse(rawBody(await fetchRPC(secondTurn))).choices[0].message.content, 'Tool result received.');
  assert.deepEqual(profile.requests.at(-1).body, secondTurn);
  await Promise.all(Array.from({ length: 16 }, async (_, i) => {
    const id = 'rpc-isolation-' + i, result = await fetchRPC({ model: 'mock', messages: [{ role: 'system', content: id }, { role: 'user', content: id }], metadata: { user_id: id }, stream: true });
    assert.equal(result.frames[0].headers['x-fixture-request'], id);
    const frames = await Array.fromAsync(sseEvents(new Response(rawBody(result)).body));
    assert.equal(frames[0].choices[0].delta.content, id);
  }));
  let waitingFrames = 0;
  const waiting = fetchRPC({ model: 'mock', messages: [{ role: 'user', content: 'WAIT_FIRST' }], metadata: { user_id: 'rpc-abort-before-headers' } }, { onFrame: () => waitingFrames++ });
  const waitingRejected = assert.rejects(waiting, /cancelled/); void waitingRejected.catch(() => {});
  try {
    const until = Date.now() + 3000;
    while (!profile.requests.some(r => r.body.metadata?.user_id === 'rpc-abort-before-headers') && Date.now() < until) await delay(10);
    assert.ok(profile.requests.some(r => r.body.metadata?.user_id === 'rpc-abort-before-headers'));
    assert.equal((await fetchRPC({ model: 'mock', messages: [{ role: 'user', content: 'unaffected peer' }] })).frames[0].status, 200);
    assert.equal(waitingFrames, 0);
  } finally { abort(waiting); await waitingRejected; }
  const cancelUntil = Date.now() + 3000;
  while (profile.activity().active && Date.now() < cancelUntil) await delay(10);
  assert.equal(profile.activity().active, 0);
  // Exercise Bun host backpressure and the actual RPC abort contract; a host
  // abort deliberately suppresses its reply, so the fixture settles its caller.
  const firstChunk = Promise.withResolvers();
  const paused = fetchRPC({ model: 'mock', messages: [{ role: 'user', content: 'SLOW_READER' }], stream: true }, { autoCredit: false, onFrame: frame => { if (frame.event === 'chunk') firstChunk.resolve(); } });
  const rejected = assert.rejects(paused, /cancelled/);
  void rejected.catch(() => {});
  try {
    await Promise.race([firstChunk.promise, paused.then(() => { throw new Error('Paused fetch ended before its first chunk'); })]);
    await delay(300); const earlier = profile.activity().produced;
    await delay(200); const later = profile.activity().produced;
    assert.ok(later < 4096 && later - earlier <= 16, 'A paused real host must stop its upstream producer');
    assert.equal(profile.activity().active, 1, 'Backpressure must keep the request open instead of timing it out');
  } finally { abort(paused); await rejected; }
  const until = Date.now() + 3000;
  while (profile.activity().active && Date.now() < until) await delay(10);
  assert.equal(profile.activity().active, 0, 'Host RPC abort must cancel the supplier request');
  assert.equal((await fetchRPC({ model: 'mock', messages: [{ role: 'user', content: 'after abort' }] })).frames[0].status, 200);
  for (const [model, npm, endpoint, body, answer] of [
    ['response-model', '@ai-sdk/openai', '/responses', { input: 'hello', instructions: 'HOST_SYSTEM' }, 'RESPONSES_OK'],
    ['message-model', '@ai-sdk/anthropic', '/messages', { messages: [{ role: 'user', content: 'hello' }], system: 'HOST_SYSTEM', max_tokens: 100 }, 'MESSAGES_OK'],
  ]) {
    const native = await rpc('fetch', { provider: 'opencode-proxy', model, npm, url: loaded.baseURL + endpoint, method: 'POST', body: Buffer.from(JSON.stringify({ model, ...body })).toString('base64') });
    assert.equal(native.frames[0].status, 200);
    const output = Buffer.concat(native.frames.filter(f => f.event === 'chunk').map(f => Buffer.from(f.data, 'base64'))).toString('utf8');
    assert.match(output, new RegExp(answer));
    assert.deepEqual(profile.requests.at(-1).body, { model, ...body });
  }
  await assert.rejects(rpc('fetch', { provider: 'opencode-proxy', model: 'mock', npm: '@ai-sdk/openai-compatible', url: loaded.baseURL + '/chat/completions', method: 'POST', body: Buffer.from(JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'WAIT_IDLE' }], stream: true })).toString('base64') }));
  assert.equal(await readFile(profile.configPath, 'utf8'), profile.original);
});
