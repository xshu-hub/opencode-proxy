import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionEventHub } from '../lib/session-events.mjs';

const envelope = (type, properties, directory = '/project') => ({ directory, payload: { type, properties } });
const open = (hub, sessionID, limit) => {
  const controller = new AbortController();
  const lifecycle = { signal: controller.signal, progressed: 0, completed: false,
    progress() { this.progressed++; }, complete() { this.completed = true; }, stop() {} };
  let stopped = 0;
  const buffer = hub.subscribe(sessionID, { lifecycle, signal: controller.signal, limit,
    abort: error => controller.abort(error), stop: () => stopped++ });
  return { controller, lifecycle, buffer, get stopped() { return stopped; } };
};

test('one stream routes metadata, deltas and errors to the owning session and directory only', async () => {
  const hub = new SessionEventHub('/project'), a = open(hub, 'a'), b = open(hub, 'b');
  try {
    hub.publish(envelope('message.updated', { info: { id: 'ma', sessionID: 'a', role: 'assistant' } }, '/other'));
    hub.publish(envelope('server.heartbeat', {}));
    hub.publish(envelope('message.updated', { info: { id: 'unknown', sessionID: 'unowned', role: 'assistant' } }));
    assert.equal(hub.stats.delivered, 0); assert.equal(hub.stats.queuedBytes, 0);
    hub.publish(envelope('message.updated', { info: { id: 'ma', sessionID: 'a', role: 'assistant' } }));
    hub.publish(envelope('message.updated', { info: { id: 'mb', sessionID: 'b', role: 'assistant' } }));
    hub.publish(envelope('message.part.delta', { messageID: 'ma', sessionID: 'a', field: 'text', delta: '你好🌍' }));
    hub.publish(envelope('message.part.updated', { part: { id: 'pb', messageID: 'mb', sessionID: 'b', type: 'text', text: 'B' } }));
    assert.equal((await a.buffer.events.next()).value.properties.info.id, 'ma');
    assert.equal((await a.buffer.events.next()).value.properties.delta, '你好🌍');
    assert.equal((await b.buffer.events.next()).value.properties.info.id, 'mb');
    assert.equal((await b.buffer.events.next()).value.properties.part.text, 'B');
    assert.equal(a.lifecycle.progressed, 1); assert.equal(b.lifecycle.progressed, 1);
    const error = { name: 'APIError', data: { message: 'fixture failure' } };
    hub.publish(envelope('session.error', { sessionID: 'a', error }));
    assert.equal(a.buffer.errorEvent.properties.error, error); assert.equal(b.buffer.errorEvent, undefined);
  } finally { hub.close(); }
  assert.equal(hub.stats.subscribers, 0); assert.equal(hub.stats.queuedBytes, 0);
});

test('cancelling a pending subscription frees its queue without cancelling peers or leaking waiters', async () => {
  const hub = new SessionEventHub('/project'), a = open(hub, 'a'), b = open(hub, 'b');
  try {
    const pending = a.buffer.events.next(); a.controller.abort(new Error('only a'));
    await assert.rejects(pending, /only a/); assert.equal(a.stopped, 1);
    assert.equal(hub.stats.subscribers, 1); assert.equal(b.controller.signal.aborted, false);
    hub.publish(envelope('session.status', { sessionID: 'b', status: { type: 'busy' } }));
    assert.equal((await b.buffer.events.next()).value.properties.sessionID, 'b');
    const waiting = b.buffer.events.next(); await b.buffer.events.return();
    assert.equal((await waiting).done, true); assert.equal(b.stopped, 1);
  } finally { hub.close(); }
});

test('a slow consumer fails at its own byte limit while a live peer continues', async () => {
  const hub = new SessionEventHub('/project'), slow = open(hub, 'slow', 256), live = open(hub, 'live');
  try {
    const pending = slow.buffer.events.next();
    hub.publish(envelope('message.part.updated', { part: { sessionID: 'slow', text: 'x'.repeat(1024) } }));
    await assert.rejects(pending, error => error.code === 'slow_consumer');
    assert.equal(hub.stats.subscribers, 1); assert.equal(hub.stats.queuedBytes, 0);
    hub.publish(envelope('session.status', { sessionID: 'live', status: { type: 'busy' } }));
    assert.equal((await live.buffer.events.next()).value.properties.sessionID, 'live');
    assert.equal(live.controller.signal.aborted, false);
  } finally { hub.close(); }
});

test('a broken shared stream fails incomplete requests but preserves already completed output', async () => {
  const hub = new SessionEventHub('/project'), done = open(hub, 'done'), pending = open(hub, 'pending');
  try {
    hub.publish(envelope('message.updated', { info: { id: 'm', sessionID: 'done', role: 'assistant' } }));
    hub.publish(envelope('message.part.updated', { part: { sessionID: 'done', messageID: 'm', type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 2 } } }));
    const waiting = pending.buffer.events.next(); hub.fail();
    await assert.rejects(waiting, error => error.code === 'opencode_events');
    const frames = await Array.fromAsync(done.buffer.events);
    assert.equal(frames.length, 2); assert.equal(done.controller.signal.aborted, false);
    assert.equal(done.lifecycle.usage.total_tokens, 3);
    assert.throws(() => open(hub, 'later'), error => error.code === 'opencode_events');
  } finally { hub.close(); }
});
