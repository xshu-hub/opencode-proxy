import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeBridge } from '../lib/bridge.mjs';
import { globalProfile } from './global-profile.mjs';

if (!process.env.TEST_OPENCODE_COMMAND) throw new Error('Set TEST_OPENCODE_COMMAND to a real OpenCode command array.');

test('real Session pipeline shares one process per contract with isolated signatures, cancellation and caller retry', { timeout: 180000 }, async t => {
  let cancelledClosed = false, timeoutSeen = false;
  const profile = await globalProfile({ respond: ({ res, body }) => {
    const text = JSON.stringify(body.messages);
    if (text.includes('HANG_CANCEL')) { res.once('close', () => { cancelledClosed = true; }); return true; }
    if (text.includes('HANG_FIRST') && !timeoutSeen) { timeoutSeen = true; return true; }
  } });
  let bridge;
  t.after(async () => { await bridge?.close(); await profile.close(); });
  // Isolate concurrency from refresh policy; OAuth refresh itself is covered by
  // the separate global-profile integration test, using only disposable keys.
  await writeFile(profile.authFile, JSON.stringify({ fixture: { type: 'oauth', access: 'fixture-ready', refresh: 'fixture-refresh', expires: Date.now() + 3600000 } }));
  bridge = new OpenCodeBridge({ mode: 'global', command: JSON.parse(process.env.TEST_OPENCODE_COMMAND),
    workingDirectory: profile.home, workerSharing: true, diagnostics: false, startupTimeoutMs: 30000, firstOutputTimeoutMs: 60000 });
  const chat = text => ({ model: 'mock', messages: [{ role: 'system', content: 'CLIENT_SYSTEM_' + text },
    { role: 'user', content: 'PRIOR_USER_' + text }, { role: 'assistant', content: 'PRIOR_ASSISTANT_' + text }, { role: 'user', content: text }] });
  const send = (body, signal) => bridge.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify(body), signal });
  await bridge.loadModels(); assert.equal(profile.requests.length, 0);
  const settle = async () => {
    const deadline = Date.now() + 15000;
    let sessions;
    do {
      const entries = [...bridge.shared.entries.values()];
      assert.equal(entries.length, 1, 'One model/tool contract must keep one shared process');
      const process = await entries[0].ready;
      const response = await fetch(process.base + '/session?directory=' + encodeURIComponent(process.directory), { headers: process.headers });
      assert.equal(response.status, 200); sessions = await response.json();
      if (!sessions.length && !bridge.active && !bridge.controllers.size) return process;
      await delay(30);
    } while (Date.now() < deadline);
    assert.fail('Session state was not released: ' + JSON.stringify({ sessions: sessions.length, active: bridge.active }));
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: 64 }, async (_, i) => {
    const response = await send(chat('ISOLATED_' + i));
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value));
    assert.equal(value.choices[0].message.content, '你好，Magpie。');
  }));
  const runtime = await settle(), elapsedMs = Math.round(performance.now() - started);
  assert.equal(profile.requests.length, 64, 'Each client turn must cause exactly one supplier inference');
  assert.equal(new Set(profile.requests.map(request => request.pid)).size, 1);
  assert.equal(new Set(profile.requests.map(request => request.affinity)).size, 64);
  for (const request of profile.requests) {
    const text = request.body.messages.at(-1).content;
    assert.deepEqual(request.body.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
    assert.equal(request.body.messages[0].content, 'CLIENT_SYSTEM_' + text);
    assert.equal(request.body.messages[1].content, 'PRIOR_USER_' + text);
    assert.equal(request.body.messages[2].content, 'PRIOR_ASSISTANT_' + text);
    assert.equal(request.authorization, 'Bearer fixture-ready');
    assert.equal(request.signature, request.expectedSignature); assert.equal(request.hook, 'from-chat-headers');
  }
  const controller = new AbortController();
  const cancelled = send(chat('HANG_CANCEL'), controller.signal); void cancelled.catch(() => {});
  const deadline = Date.now() + 10000;
  while (!profile.requests.some(request => JSON.stringify(request.body.messages).includes('HANG_CANCEL'))) {
    assert.ok(Date.now() < deadline, 'The cancelled request did not reach the supplier'); await delay(20);
  }
  const peer = send(chat('LIVE_PEER')); controller.abort();
  try { const result = await cancelled; assert.equal(result.status, 499); } catch (error) { assert.match(String(error), /abort/i); }
  const live = await peer; assert.equal(live.status, 200, await live.clone().text()); await live.text();
  await settle(); assert.equal(cancelledClosed, true);
  bridge.config.firstOutputTimeoutMs = 800;
  const timedBody = chat('HANG_FIRST'), timed = await send(timedBody);
  assert.equal(timed.status, 504, await timed.clone().text()); await timed.text();
  await settle();
  assert.equal(profile.requests.filter(request => JSON.stringify(request.body.messages).includes('HANG_FIRST')).length, 1, 'The bridge must not replay timed-out requests');
  bridge.config.firstOutputTimeoutMs = 60000;
  const retried = await send(timedBody); assert.equal(retried.status, 200, await retried.clone().text()); await retried.text();
  const final = await settle(); assert.equal(final.worker.child.pid, runtime.worker.child.pid);
  assert.equal(profile.requests.filter(request => JSON.stringify(request.body.messages).includes('HANG_FIRST')).length, 2);
  assert.equal(profile.refreshes(), 0);
  // Reading the fixture store also confirms that cleanup did not corrupt auth.
  assert.equal(JSON.parse(await readFile(profile.authFile, 'utf8')).fixture.access, 'fixture-ready');
  t.diagnostic(JSON.stringify({ runtime: runtime.version, concurrentRequests: 64, elapsedMs, inferenceProcesses: new Set(profile.requests.map(request => request.pid)).size, finalSessions: 0 }));
});
