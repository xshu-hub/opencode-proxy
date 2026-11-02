import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlugin } from '../lib/magpie-plugin.mjs';
import { OpenCodeTransport } from '../lib/transport.mjs';
import { globalProfile } from './global-profile.mjs';

if (!process.env.TEST_OPENCODE_COMMAND) throw new Error('Set TEST_OPENCODE_COMMAND to a real OpenCode command array.');

test('unexpected bootstrap network traffic is blocked before inference and cleans up its session', { timeout: 60000 }, async t => {
  const profile = await globalProfile({ bootstrapOutbound: true, bootstrapPreparation: true });
  let transport;
  class Tracked extends OpenCodeTransport { constructor(config) { super(config); transport = this; } }
  const hooks = await createPlugin(Tracked)({ directory: profile.home, magpie: {} }, { command: JSON.parse(process.env.TEST_OPENCODE_COMMAND), startupTimeoutMs: 20000, firstOutputTimeoutMs: 20000 });
  t.after(async () => { await hooks.dispose(); await profile.close(); });
  const auth = { type: 'api', key: 'local' };
  await hooks.provider.models({}, { auth });
  const loader = await hooks.auth.loader(async () => auth);
  const send = () => loader.fetch(loader.baseURL + '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hello' }] }) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await send();
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.code, 'bootstrap_hook_order');
    assert.equal(profile.requests.length, 0, 'The bootstrap guard must stop the SDK/plugin before any supplier request');
    assert.equal(profile.preparations.length, 2 * (attempt + 1), 'Provider preparation is allowed before an actual early inference attempt is rejected');
    const deadline = Date.now() + 3000;
    let state;
    do { state = await transport.diagnostics(); if (!state.active && !state.pending && !state.pendingClients && !state.sessions) break; await delay(20); } while (Date.now() < deadline);
    assert.equal(state.active, 0); assert.equal(state.pending, 0); assert.equal(state.pendingClients, 0); assert.equal(state.sessions, 0);
    assert.equal(state.captures, 0, 'A failed hook probe must not publish a reusable transport');
  }
  assert.equal(profile.refreshes(), 0);
});

test('provider metadata and custom authentication preflight can precede capture without bootstrap inference', { timeout: 60000 }, async t => {
  const profile = await globalProfile({ bootstrapPreparation: true });
  let transport;
  class Tracked extends OpenCodeTransport { constructor(config) { super(config); transport = this; } }
  const hooks = await createPlugin(Tracked)({ directory: profile.home, magpie: {} }, { command: JSON.parse(process.env.TEST_OPENCODE_COMMAND), startupTimeoutMs: 20000, firstOutputTimeoutMs: 20000 });
  t.after(async () => { await hooks.dispose(); await profile.close(); });
  const auth = { type: 'api', key: 'local' };
  await hooks.provider.models({}, { auth });
  assert.equal(profile.requests.length, 0); assert.equal(profile.preparations.length, 0);
  const loader = await hooks.auth.loader(async () => auth);
  const body = { model: 'mock', messages: [{ role: 'system', content: 'CLIENT_SYSTEM' }, { role: 'user', content: 'hello' }] };
  for (let turn = 0; turn < 2; turn++) {
    const response = await loader.fetch(loader.baseURL + '/chat/completions', { method: 'POST', body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.choices[0].message.content, '你好，Magpie。');
  }
  assert.deepEqual(profile.preparations, [{ method: 'GET', path: '/bootstrap-metadata' }, { method: 'POST', path: '/custom-auth/preflight' }]);
  assert.equal(profile.requests.length, 2, 'Only the two business turns reach model inference');
  for (const request of profile.requests) {
    assert.equal(request.preflight, 'fixture-preflight-ticket');
    assert.equal(request.authorization, 'Bearer fixture-renewed');
    assert.deepEqual(request.body, body);
  }
  assert.equal(profile.refreshes(), 1);
  const state = await transport.diagnostics();
  assert.equal(state.bootstraps, 1); assert.equal(state.captures, 1);
  assert.equal(state.sessions, 0); assert.equal(state.pending, 0); assert.equal(state.active, 0);
});
