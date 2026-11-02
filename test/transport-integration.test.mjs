import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeTransport } from '../lib/transport.mjs';
import { BASE } from '../lib/transport-common.mjs';
import { globalProfile } from './global-profile.mjs';
import { executableCommand } from '../lib/command.mjs';

if (!process.env.TEST_OPENCODE_COMMAND) throw new Error('Set TEST_OPENCODE_COMMAND to a real OpenCode v1 command array.');
const command = JSON.parse(process.env.TEST_OPENCODE_COMMAND);
const reportPath = path.resolve('artifacts/native-transport.json');

test('real OpenCode v1 native transport: concurrency, auth, unchanged payloads, deadlines and lifecycle', { timeout: 120000 }, async t => {
  const profile = await globalProfile();
  const transport = new OpenCodeTransport({ command, workingDirectory: profile.home, startupTimeoutMs: 20000, firstOutputTimeoutMs: 20000 });
  t.after(async () => { await transport.close(); await profile.close(); });
  const send = (body, api = '/chat/completions', signal) => transport.fetch(BASE + api, { method: 'POST', body: JSON.stringify(body), signal });
  const chat = text => ({ model: 'mock', messages: [{ role: 'system', content: 'EXACT_SYSTEM' }, { role: 'user', content: text }] });
  const settle = async () => {
    let last;
    for (let i = 0; i < 100; i++) {
      const state = last = await transport.diagnostics();
      if (!state.active && !state.pendingClients && !state.pending && !state.refreshing && !profile.activity().active) return state;
      await delay(20);
    }
    assert.fail('Transport or upstream did not release requests: ' + JSON.stringify({ state: last, upstream: profile.activity() }));
  };
  const models = await transport.loadModels();
  assert.ok(models.mock && models['api-model'] && models['response-model'] && models['message-model']);
  assert.equal(profile.requests.length, 0);
  const first = await transport.diagnostics();

  await t.test('64 simultaneous cold requests share one bootstrap and one expired OAuth refresh', async () => {
    const results = await Promise.all(Array.from({ length: 64 }, async (_, i) => {
      const response = await send(chat('CONCURRENT_' + i));
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }));
    assert.equal(results.length, 64);
    assert.equal(profile.requests.length, 64, 'Bootstrap must never call inference');
    assert.equal(profile.refreshes(), 1, 'Concurrent expiry must not refresh the same credential 64 times');
    assert.ok(profile.activity().peak >= 8, JSON.stringify(profile.activity()));
    const state = await settle();
    assert.equal(state.pid, first.pid); assert.equal(state.starts, 1);
    assert.equal(state.bootstraps, 1); assert.equal(state.captures, 1); assert.equal(state.sessions, 0);
    for (const request of profile.requests) {
      assert.equal(request.authorization, 'Bearer fixture-renewed');
      assert.equal(request.marker, 'real-plugin');
      assert.match(request.userAgent, /^opencode\/1\./);
      assert.ok(request.session?.startsWith('ses_'));
      assert.equal(request.body.messages.length, 2);
      assert.equal(request.body.messages[0].content, 'EXACT_SYSTEM');
    }
  });

  await t.test('native APIs keep client history, tools, options and static credentials', async () => {
    const body = { ...chat('native'), tools: [{ type: 'function', function: { name: 'any_client_tool', description: 'only client executes', parameters: { type: 'object' } } }], tool_choice: 'none', temperature: 0.13, reasoning_effort: 'high', custom_provider_field: { unchanged: true } };
    const original = await send(body); assert.equal(original.status, 200); await original.text();
    assert.deepEqual(profile.requests.at(-1).body, body);
    for (const [model, api, payload, expected] of [
      ['api-model', '/chat/completions', { messages: [{ role: 'user', content: 'static' }] }, '你好，Magpie。'],
      ['response-model', '/responses', { instructions: 'EXACT_SYSTEM', input: 'hello', tools: [] }, 'RESPONSES_OK'],
      ['message-model', '/messages', { system: 'EXACT_SYSTEM', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }], tools: [] }, 'MESSAGES_OK'],
    ]) {
      const response = await send({ model, ...payload }, api);
      assert.equal(response.status, 200, await response.clone().text());
      assert.match(await response.text(), new RegExp(expected));
      const upstream = profile.requests.at(-1);
      assert.deepEqual(upstream.body, { model, ...payload });
      assert.equal(upstream.path, '/v1' + api);
      assert.equal(api === '/messages' ? upstream.apiKey : upstream.authorization, api === '/messages' ? 'fixture-key' : 'Bearer fixture-key');
      if (model === 'api-model') { assert.equal(upstream.option, 'override'); assert.equal(upstream.modelHeader, 'model'); assert.equal(upstream.userAgent, 'fixture-agent'); }
    }
    const state = await settle();
    assert.equal(state.bootstraps, 4); assert.equal(state.sessions, 0); assert.equal(state.starts, 1);
    await assert.rejects(send({ model: 'response-model', input: 'wrong path' }), /does not match/);
  });

  const rounds = [], before = await settle();
  await t.test('three more rounds of 64 calls retain no sessions or request references', async () => {
    for (let round = 0; round < 3; round++) {
      const started = performance.now();
      await Promise.all(Array.from({ length: 64 }, async (_, i) => {
        const response = await send(chat(`CONCURRENT_${round}_${i}`));
        assert.equal(response.status, 200); await response.arrayBuffer();
      }));
      const state = await settle();
      assert.equal(state.pid, before.pid); assert.equal(state.starts, 1); assert.equal(state.bootstraps, 4);
      assert.equal(state.captures, 4); assert.equal(state.sessions, 0);
      rounds.push({ requests: 64, elapsedMs: Math.round(performance.now() - started), openCodeRss: state.rss, hostRss: process.memoryUsage().rss });
    }
    assert.equal(profile.refreshes(), 1);
  });

  await t.test('compressed supplier responses are decoded while preserving payloads', async () => {
    const response = await send(chat('TRANSPORT_GZIP'));
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-encoding'), null);
    assert.equal((await response.json()).choices[0].message.content, 'GZIP_OK');
  });

  await t.test('first-byte, idle and total deadlines preserve failure semantics', async () => {
    transport.config.firstOutputTimeoutMs = 150;
    const firstTimeout = await send(chat('WAIT_FIRST'));
    assert.equal(firstTimeout.status, 504); assert.equal((await firstTimeout.json()).error.code, 'transport_timeout');
    transport.config.firstOutputTimeoutMs = 20000; transport.config.idleTimeoutMs = 150;
    const idle = await send({ ...chat('WAIT_IDLE'), stream: true });
    assert.equal(idle.status, 200);
    await assert.rejects(idle.text(), /terminated|abort|socket|fetch/i);
    transport.config.idleTimeoutMs = 180000; transport.config.timeoutMs = 150;
    const total = await send(chat('WAIT_FIRST'));
    assert.equal(total.status, 504); await total.text();
    transport.config.timeoutMs = 0; await settle();
  });

  await t.test('unknown SDKs and per-turn header hooks fail without a supplier call or fallback', async () => {
    const count = profile.requests.length;
    await assert.rejects(send({ model: 'unknown-model', messages: [] }), e => e.status === 501 && e.code === 'unsupported_sdk');
    const dynamic = await send({ model: 'dynamic-model', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(dynamic.status, 501); assert.equal((await dynamic.json()).error.code, 'unsupported_dynamic_headers');
    assert.equal(profile.requests.length, count);
    assert.equal((await settle()).sessions, 0);
  });

  await t.test('client abort, paused reader and shutdown release both sides', async () => {
    const controller = new AbortController();
    const waiting = send(chat('WAIT_FIRST'), '/chat/completions', controller.signal);
    while (!profile.activity().active) await delay(10);
    controller.abort(); await assert.rejects(waiting, /abort/i); await settle();
    const stream = await send({ ...chat('SLOW_READER'), stream: true });
    try {
      await delay(500); const earlier = profile.activity().produced;
      await delay(200); const later = profile.activity().produced;
      t.diagnostic('paused reader produced chunks: ' + JSON.stringify({ earlier, later, transport: await transport.diagnostics() }));
      assert.ok(later < 4096 && later - earlier <= 16, 'A paused client must apply backpressure to the producer');
    } finally { await stream.body.cancel(); }
    await settle();
    const stream2 = await send({ ...chat('WAIT_IDLE'), stream: true });
    const aborted = new AbortController();
    const pending = send(chat('WAIT_FIRST'), '/chat/completions', aborted.signal);
    while (profile.activity().active < 2) await delay(10);
    await assert.rejects(transport.loadModels(true), e => e.code === 'transport_busy');
    aborted.abort(); await assert.rejects(pending); await stream2.body.cancel(); await settle();
  });

  await t.test('model refresh replaces the sole process and removes stale routes', async () => {
    const config = JSON.parse(profile.original);
    delete config.provider.fixture.models.mock;
    config.provider.fixture.models.next = { limit: { context: 32000, output: 1000 } };
    await writeFile(profile.configPath, JSON.stringify(config));
    const refreshed = await transport.loadModels(true);
    assert.equal(refreshed.mock, undefined); assert.ok(refreshed.next);
    await assert.rejects(send(chat('gone')), e => e.status === 404);
    const state = await transport.diagnostics();
    assert.equal(state.starts, 2); assert.notEqual(state.pid, before.pid);
    assert.throws(() => process.kill(before.pid, 0));
    const next = await send({ model: 'next', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(next.status, 200); await next.text();
    assert.equal(profile.requests.at(-1).body.model, 'next');
  });

  const final = await settle();
  assert.equal(await profile.mcpStarted(), false, 'Global MCP entries must stay disabled during discovery and bootstrap');
  const report = { runtime: final.version, concurrentRequests: 64, peakMockConcurrency: profile.activity().peak, oauthRefreshes: profile.refreshes(), openCodeRssBeforeRounds: before.rss, rounds, finalSessions: final.sessions, totalUpstreamRequests: profile.requests.length, backpressureChunksProduced: profile.activity().produced };
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  t.diagnostic(JSON.stringify(report));
  await transport.close();
  assert.throws(() => process.kill(final.pid, 0));
  await assert.rejects(transport.loadModels(), /stopped/);
  assert.equal(JSON.parse(await readFile(profile.authFile, 'utf8')).fixture.access, 'fixture-renewed');
});

test('a JavaScript launcher and its real native OpenCode child both stop on disposal', { timeout: 45000 }, async t => {
  const profile = await globalProfile();
  const actual = await executableCommand(command);
  const launcher = path.join(profile.home, 'launcher.mjs');
  await writeFile(launcher, `import { spawn } from 'node:child_process';
    const command = ${JSON.stringify(actual)};
    const child = spawn(command[0], [...command.slice(1), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
    child.once('error', () => process.exit(1)); child.once('exit', code => process.exit(code ?? 1));
  `);
  const transport = new OpenCodeTransport({ command: [process.execPath, launcher], workingDirectory: profile.home, startupTimeoutMs: 20000 });
  t.after(async () => { await transport.close(); await profile.close(); });
  await transport.loadModels();
  const state = await transport.diagnostics(), wrapper = transport.child.pid;
  assert.notEqual(state.pid, wrapper);
  await transport.close();
  assert.throws(() => process.kill(state.pid, 0)); assert.throws(() => process.kill(wrapper, 0));
});
