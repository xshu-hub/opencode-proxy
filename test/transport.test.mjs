import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionsOf, waitFor, publicFailure, ApiError } from '../lib/transport-common.mjs';

test('persistent runtime defaults preserve unlimited admission and saved legacy options', () => {
  const config = optionsOf();
  assert.equal(config.maxConcurrent, 0); assert.equal(config.timeoutMs, 0);
  assert.deepEqual(config.command, ['opencode']);
  assert.equal(optionsOf({ workerSharing: false, maxIdleWorkers: 2, workerIdleMs: 60000 }).maxConcurrent, 0);
  for (const bad of [null, [], { workerReuse: false }, { workerSharing: 1 }, { command: 'opencode' }, { command: [] }, { workingDirectory: '' }, { timeoutMs: -1 }, { firstOutputTimeoutMs: 0 }, { idleTimeoutMs: NaN }, { startupTimeoutMs: 1.5 }, { maxConcurrent: 1 }]) assert.throws(() => optionsOf(bad));
});

test('cancelling a shared bootstrap waiter leaves the shared task usable', async () => {
  const shared = Promise.withResolvers(), cancelled = new AbortController();
  const first = waitFor(shared.promise, cancelled.signal), second = waitFor(shared.promise, new AbortController().signal);
  cancelled.abort(new Error('stop this caller')); await assert.rejects(first, /stop this caller/);
  shared.resolve('ready'); assert.equal(await second, 'ready');
  const already = AbortSignal.abort(new Error('already stopped'));
  await assert.rejects(waitFor(Promise.resolve('ready'), already), /already stopped/);
});

test('unknown transport exceptions do not disclose provider credentials', () => {
  const failure = publicFailure(new Error('private supplier endpoint and token'));
  assert.equal(failure.status, 503); assert.doesNotMatch(JSON.stringify(failure.body()), /private supplier/);
  const upstream = new ApiError('limited', 429, null, 'rate_limit');
  assert.equal(publicFailure(upstream), upstream); assert.equal(upstream.body().error.type, 'rate_limit_error');
});
