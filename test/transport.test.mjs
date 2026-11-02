import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionsOf, waitFor, publicFailure, ApiError } from '../lib/transport-common.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeTransport } from '../lib/transport.mjs';

test('persistent runtime defaults preserve unlimited admission and saved legacy options', () => {
  const config = optionsOf();
  assert.equal(config.maxConcurrent, 0); assert.equal(config.timeoutMs, 0);
  assert.equal(config.headerHooks, 'reject');
  assert.equal(optionsOf({ headerHooks: 'per-request' }).headerHooks, 'per-request');
  assert.throws(() => optionsOf({ headerHooks: 'cache' }));
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

test('runtime management capabilities accept arbitrary private version labels without a numeric whitelist', { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'opencode-runtime-labels-'));
  const file = path.join(home, 'management-fixture.mjs');
  await writeFile(file, `import http from 'node:http';
    import { writeFile } from 'node:fs/promises';
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    const server = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/global/health') { res.end(JSON.stringify({ healthy: true, version: process.argv[2] })); return; }
      if (req.url.startsWith('/provider/auth?directory=')) { await writeFile(process.env.OPENCODE_PROXY_CONTROL_FILE, JSON.stringify({ version: 1, port, pid: process.pid })); res.end('{}'); return; }
      if (req.url === '/catalog') { res.end('{"models":{}}'); return; }
      res.writeHead(404).end('{}');
    }); server.listen(port, '127.0.0.1');
  `);
  try {
    for (const version of ['1.16.2', 'internal/custom-build', 'v1.16.2-company+patch', '1.18.0']) {
      const transport = new OpenCodeTransport({ command: [process.execPath, file, version], workingDirectory: home, startupTimeoutMs: 5000 });
      try { assert.deepEqual(await transport.loadModels(), {}); assert.equal(transport.version, version); }
      finally { await transport.close(); }
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
