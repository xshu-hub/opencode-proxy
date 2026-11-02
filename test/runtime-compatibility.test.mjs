import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlugin } from '../lib/magpie-plugin.mjs';
import { OpenCodeTransport } from '../lib/transport.mjs';
import { globalProfile } from './global-profile.mjs';

if (!process.env.TEST_OPENCODE_COMMAND) throw new Error('Set TEST_OPENCODE_COMMAND to a real OpenCode command array.');

test('unexpected bootstrap network traffic is blocked before inference and cleans up its session', { timeout: 60000 }, async t => {
  const profile = await globalProfile({ bootstrapOutbound: true });
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
    const deadline = Date.now() + 3000;
    let state;
    do { state = await transport.diagnostics(); if (!state.active && !state.pending && !state.pendingClients && !state.sessions) break; await delay(20); } while (Date.now() < deadline);
    assert.equal(state.active, 0); assert.equal(state.pending, 0); assert.equal(state.pendingClients, 0); assert.equal(state.sessions, 0);
    assert.equal(state.captures, 0, 'A failed hook probe must not publish a reusable transport');
  }
  assert.equal(profile.refreshes(), 0);
});
