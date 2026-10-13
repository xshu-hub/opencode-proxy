import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeConfig } from '../lib/bridge.mjs';
import { RequestLifecycle } from '../lib/lifecycle.mjs';
import { WorkerPool } from '../lib/pool.mjs';
import { bufferEvents } from '../lib/events.mjs';

test('default requests have separate first-output/idle deadlines and no total or concurrency cap', () => {
  const cfg = normalizeConfig({ mode: 'global' });
  assert.equal(cfg.timeoutMs, 0);
  assert.equal(cfg.firstOutputTimeoutMs, 120000);
  assert.equal(cfg.idleTimeoutMs, 180000);
  assert.equal(cfg.maxConcurrent, 0);
  assert.equal(cfg.workerReuse, true);
  assert.equal(normalizeConfig({ mode: 'global', timeoutMs: 120000 }).timeoutMs, 120000);
  for (const key of ['firstOutputTimeoutMs', 'idleTimeoutMs', 'workerIdleMs']) for (const value of [0, -1, '10']) assert.throws(() => normalizeConfig({ mode: 'global', [key]: value }));
});

test('first output, idle and total deadlines are distinct and real progress resets only idle', async () => {
  const cfg = normalizeConfig({ mode: 'global', startupTimeoutMs: 500, firstOutputTimeoutMs: 60, idleTimeoutMs: 60 });
  const first = new RequestLifecycle(cfg);
  first.inference();
  await delay(100);
  assert.equal(first.timeoutKind, 'first_output');
  first.stop();
  const flowing = new RequestLifecycle(cfg);
  flowing.inference();
  for (let i = 0; i < 6; i++) { flowing.progress(); await delay(25); assert.equal(flowing.signal.aborted, false); }
  await delay(100);
  assert.equal(flowing.timeoutKind, 'idle');
  flowing.stop();
  const total = new RequestLifecycle({ ...cfg, timeoutMs: 80 });
  total.inference();
  for (let i = 0; i < 4; i++) { total.progress(); await delay(30); }
  assert.equal(total.timeoutKind, 'total');
  total.stop();
  const stalled = new RequestLifecycle({ ...cfg, timeoutMs: 60 });
  stalled.inference(); stalled.progress(); stalled.complete();
  await delay(100);
  assert.equal(stalled.timeoutKind, 'total', 'Explicit total deadline still bounds a stalled downstream after native completion');
  stalled.stop();
});

test('idle retention does not restrict active workers and concurrent releases keep only the configured idle count', async () => {
  const pool = new WorkerPool({ workerReuse: true, maxIdleWorkers: 2, workerIdleMs: 100 });
  const disposed = new Set();
  const stream = { ref() {}, unref() {} };
  const workers = Array.from({ length: 6 }, (_, key) => ({ key, child: { ...stream, stdout: stream, stderr: stream, kill() {} }, mcp: stream, dispose: async () => { await delay(2); disposed.add(key); } }));
  for (const worker of workers) pool.track(worker);
  assert.equal(pool.workers.size, 6);
  await Promise.all(workers.map(w => pool.put(w)));
  assert.equal(pool.idle.length, 2);
  assert.equal(disposed.size, 4);
  const deadline = Date.now() + 2000;
  while (disposed.size < 6 && Date.now() < deadline) await delay(20);
  assert.equal(pool.workers.size, 0);
  assert.equal(disposed.size, 6);
  await pool.close();
});

test('native event buffering rejects slow consumers at its byte limit without unbounded growth', async () => {
  let aborted, stopped = false;
  const source = (async function* () {
    yield {type:'message.updated',properties:{info:{id:'m',role:'assistant',sessionID:'s'}}};
    yield {type:'message.part.updated',properties:{part:{id:'p',messageID:'m',sessionID:'s',type:'text',text:'x'.repeat(1000)}}};
  })();
  const events = bufferEvents(source,{sessionID:'s',lifecycle:{progress(){},complete(){},stop(){}},abort:e=>{aborted=e;},stop:()=>{stopped=true;},limit:500});
  await assert.rejects(async()=>{for await(const event of events) {}}, e=>e.code==='slow_consumer');
  assert.equal(aborted.code,'slow_consumer');
  assert.equal(stopped,true);
});
