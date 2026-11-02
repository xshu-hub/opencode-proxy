import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeTransport } from '../lib/transport.mjs';
import { BASE } from '../lib/transport-common.mjs';
import { globalProfile } from './global-profile.mjs';
import { sseEvents } from './sse.mjs';
import { toolCalls } from './tool-deltas.mjs';

if (!process.env.TEST_OPENCODE_COMMAND) throw new Error('Set TEST_OPENCODE_COMMAND to a real OpenCode command array.');

test('per-request header hooks: fresh signatures, concurrent probes, native payloads and cancellation isolation', { timeout: 180000 }, async t => {
  const nonces = new Set();
  const profile = await globalProfile({ dynamicHeaders: true, respond: async ({ req, res }) => {
    const signature = createHmac('sha256', 'fixture-signing-key').update(req.headers['x-session-affinity'] + ':' + req.headers['x-fixture-message'] + ':' + req.headers['x-fixture-nonce']).digest('hex');
    if (signature !== req.headers['x-dynamic-auth'] || nonces.has(req.headers['x-fixture-nonce'])) {
      res.writeHead(403).end('Invalid or replayed fixture signature'); return true;
    }
    nonces.add(req.headers['x-fixture-nonce']);
  } });
  const cfg = JSON.parse(profile.original);
  cfg.provider.fixture.models.mock.headers = { 'x-dynamic-auth': 'stale-static-signature' };
  await writeFile(profile.configPath, JSON.stringify(cfg));
  const transport = new OpenCodeTransport({ command: JSON.parse(process.env.TEST_OPENCODE_COMMAND), workingDirectory: profile.home,
    headerHooks: 'per-request', startupTimeoutMs: 30000, firstOutputTimeoutMs: 60000 });
  t.after(async () => { await profile.releaseBootstrap(); await transport.close(); await profile.close(); });
  const chat = text => ({ model: 'mock', messages: [{ role: 'system', content: 'CLIENT_SYSTEM' }, { role: 'user', content: text }] });
  const send = (body, api = '/chat/completions', signal) => transport.fetch(BASE + api, { method: 'POST', body: JSON.stringify(body), signal });
  const settle = async () => {
    const deadline = Date.now() + 10000;
    let state;
    do {
      state = await transport.diagnostics();
      if (!state.active && !state.pending && !state.sessions && !state.pendingClients && !state.refreshing && !profile.activity().active) return state;
      await delay(20);
    } while (Date.now() < deadline);
    assert.fail('Probe or business request did not settle: ' + JSON.stringify(state));
  };
  await transport.loadModels();
  const initial = await settle();
  assert.equal(profile.requests.length, 0);
  let coldMs;
  await t.test('64 cold calls each execute fresh hooks without extra inference or cached signatures', async () => {
    const started = performance.now();
    await Promise.all(Array.from({ length: 64 }, async (_, i) => {
      const body = chat('CONCURRENT_DYNAMIC_' + i), response = await send(body);
      assert.equal(response.status, 200, await response.clone().text()); await response.text();
      assert.ok(profile.requests.some(request => JSON.stringify(request.body) === JSON.stringify(body)));
    }));
    coldMs = Math.round(performance.now() - started);
    const state = await settle();
    assert.equal(state.bootstraps, 64); assert.equal(state.headerProbes, 64); assert.equal(state.captures, 0);
    assert.equal(profile.requests.length, 64); assert.equal(nonces.size, 64); assert.equal(profile.refreshes(), 1);
    assert.equal(state.pid, initial.pid); assert.equal(state.starts, 1);
    assert.equal(new Set(profile.requests.map(request => request.session)).size, 64);
    for (const request of profile.requests) assert.equal(request.authorization, 'Bearer fixture-renewed');
  });
  await t.test('Chat tools, continuation and all native APIs keep bodies while recomputing signatures', async () => {
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    const messages = [{ role: 'user', content: 'CALL_TOOL' }];
    const body = { model: 'mock', messages, tools, stream: true };
    const response = await send(body); assert.equal(response.status, 200);
    const calls = toolCalls(await Array.fromAsync(sseEvents(response.body)));
    assert.equal(calls[0].function.name, 'lookup');
    const continuation = { model: 'mock', messages: [...messages, { role: 'assistant', content: null, tool_calls: calls },
      { role: 'tool', tool_call_id: calls[0].id, content: 'CLIENT_RESULT' }], tools };
    const next = await send(continuation); assert.equal(next.status, 200);
    assert.equal((await next.json()).choices[0].message.content, 'Tool result received.');
    assert.deepEqual(profile.requests.at(-1).body, continuation);
    for (const [model, api, payload] of [
      ['dynamic-model', '/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }],
      ['response-model', '/responses', { input: [{ role: 'user', content: 'hello' }], instructions: 'CLIENT_SYSTEM', tools: [] }],
      ['message-model', '/messages', { messages: [{ role: 'user', content: 'hello' }], system: 'CLIENT_SYSTEM', max_tokens: 100, tools: [] }],
    ]) {
      const request = { model, ...payload }, result = await send(request, api);
      assert.equal(result.status, 200, await result.clone().text()); await result.text();
      assert.deepEqual(profile.requests.at(-1).body, request);
      if (model === 'dynamic-model') assert.equal(profile.requests.at(-1).authorization, 'Bearer fixture-hook-' + profile.requests.at(-1).nonce);
    }
    await settle();
  });
  await t.test('probes run concurrently; cancelling one does not consume or cancel another signature', async () => {
    await profile.holdBootstrap();
    const before = profile.requests.length, controllers = Array.from({ length: 8 }, () => new AbortController());
    const tasks = controllers.map((controller, i) => send(chat('CONCURRENT_PROBE_' + i), '/chat/completions', controller.signal));
    tasks.forEach(task => void task.catch(() => {}));
    try {
      const deadline = Date.now() + 10000;
      let state;
      do { state = await transport.diagnostics(); if (state.sessions === 8) break; await delay(20); } while (Date.now() < deadline);
      assert.equal(state.sessions, 8, 'A serial probe queue would prevent concurrent authentication');
      controllers[0].abort(); await assert.rejects(tasks[0], /abort/i);
    } finally { await profile.releaseBootstrap(); }
    for (const task of tasks.slice(1)) { const result = await task; assert.equal(result.status, 200, await result.clone().text()); await result.text(); }
    assert.equal(profile.requests.length, before + 7); await settle();
  });
  await t.test('a probe timeout never infers; caller retry, live stream abort and idle deadline release state', async () => {
    await profile.holdBootstrap();
    const before = profile.requests.length;
    transport.config.firstOutputTimeoutMs = 150;
    try {
      const timed = await send(chat('caller retry'));
      assert.equal(timed.status, 504); assert.equal((await timed.json()).error.code, 'transport_timeout');
      assert.equal(profile.requests.length, before);
    } finally { await profile.releaseBootstrap(); transport.config.firstOutputTimeoutMs = 60000; }
    await settle();
    const retried = await send(chat('caller retry')); assert.equal(retried.status, 200); await retried.text();
    assert.equal(profile.requests.length, before + 1);
    const controller = new AbortController();
    const stream = await send({ ...chat('WAIT_IDLE'), stream: true }, '/chat/completions', controller.signal);
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader(); assert.equal((await reader.read()).done, false);
    const peer = send(chat('CONCURRENT_LIVE_PEER'));
    controller.abort(); await assert.rejects(reader.read(), /abort|terminated/i);
    const live = await peer; assert.equal(live.status, 200); await live.text(); await settle();
    transport.config.idleTimeoutMs = 100;
    const idle = await send({ ...chat('WAIT_IDLE'), stream: true });
    assert.equal(idle.status, 200); await assert.rejects(idle.text(), /abort|terminated|socket|fetch/i);
    transport.config.idleTimeoutMs = 180000; await settle();
  });
  const state = await settle();
  const records = (await readFile(profile.headersFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const signatures = new Map(records.map(record => [record.nonce, record]));
  for (const request of profile.requests) {
    const record = signatures.get(request.nonce);
    assert.equal(request.signature, record?.signature); assert.equal(request.session, record?.sessionID);
    assert.equal(request.affinity, record?.sessionID); assert.equal(request.messageID, record?.messageID);
  }
  assert.equal(nonces.size, profile.requests.length); assert.equal(state.captures, 0); assert.equal(state.starts, 1);
  assert.equal(await profile.mcpStarted(), false);
  const report = { runtime: state.version, requests: profile.requests.length, headerProbes: state.headerProbes,
    cold64ElapsedMs: coldMs, peakUpstreamConcurrency: profile.activity().peak, rssBefore: initial.rss, rssAfter: state.rss, finalSessions: state.sessions };
  await mkdir('artifacts', { recursive: true });
  await writeFile(path.join('artifacts', 'header-hooks-' + String(state.version).replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json'), JSON.stringify(report, null, 2));
  t.diagnostic(JSON.stringify(report));
});
