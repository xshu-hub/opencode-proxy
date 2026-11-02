import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { authFetchScope } from '../lib/auth-fetch.mjs';
import { gzipSync } from 'node:zlib';

test('scoped fetch preserves unrelated calls, isolates concurrent auth headers and restores the original fetch', async t => {
  const server = http.createServer((req, res) => { req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ marker: req.headers['x-fixture-auth'] ?? 'outside' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const original = globalThis.fetch;
  let unrelated = 0;
  const prior = (...args) => { unrelated++; return original(...args); };
  globalThis.fetch = prior;
  const scope = authFetchScope();
  t.after(async () => { await scope.dispose(); globalThis.fetch = original; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  assert.equal((await (await fetch(url)).json()).marker, 'outside');
  const values = await Promise.all(Array.from({ length: 32 }, async (_, i) => {
    const response = await scope.run(async (input, init) => {
      await Promise.resolve();
      return fetch(input, { ...init, headers: { 'x-fixture-auth': String(i) } });
    }, url, { method: 'POST', body: '{}' });
    return (await response.json()).marker;
  }));
  assert.deepEqual(values, Array.from({ length: 32 }, (_, i) => String(i)));
  assert.equal(unrelated, 1);
  await assert.rejects(scope.run(async () => new Response('wrapped'), url, { method: 'POST', body: '{}' }), e => e.code === 'unsupported_auth_fetch');
  await assert.rejects(scope.run(undefined, url, { method: 'POST', body: '{}', tls: {} }), e => e.code === 'unsupported_auth_fetch');
  await scope.dispose(); assert.equal(globalThis.fetch, prior);
});

test('wire streaming delivers bytes before EOF and handles redirect, compression and cancellation', async t => {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/redirect') { res.writeHead(307, { location: '/gzip' }); res.end(); }
    else if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync('compressed fixture')); }
    else if (req.url === '/empty') { res.writeHead(204).end(); }
    else { res.writeHead(200); res.write('first byte'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const scope = authFetchScope(), url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await scope.dispose(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const request = (endpoint, init = {}) => scope.run(undefined, url + endpoint, { method: 'POST', body: '{}', ...init });
  const compressed = await request('/redirect');
  assert.equal(compressed.status, 200); assert.equal(await compressed.text(), 'compressed fixture'); assert.equal(compressed.headers.get('content-encoding'), null);
  const manual = await request('/redirect', { redirect: 'manual' }); assert.equal(manual.status, 307); await manual.text();
  await assert.rejects(request('/redirect', { redirect: 'error' }), /redirect disallowed/);
  assert.equal((await request('/empty')).status, 204);
  const controller = new AbortController(), streamed = await request('/stream', { signal: controller.signal });
  const reader = streamed.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first byte');
  controller.abort(); await assert.rejects(reader.read());
});

test('bootstrap guard blocks native inference while allowing provider preparation and concurrent authorized calls', async t => {
  const paths = [];
  const server = http.createServer((req, res) => { paths.push(req.url); req.resume(); res.end('fixture'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port, scope = authFetchScope(), rejected = [];
  t.after(async () => { await scope.dispose(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const release = scope.protectBootstrap(error => rejected.push(error));
  const blocked = [base + '/v1/chat/completions', new URL(base + '/v1/responses/?key=fixture-private'),
    new Request(base + '/v1/messages', { method: 'POST', body: '{}' }),
    'https://fixture-private@provider.invalid/openai/deployments/model/completions?api_key=fixture-private'];
  for (const input of blocked) await assert.rejects(fetch(input), error => error.code === 'bootstrap_hook_order' && !error.message.includes('fixture-private'));
  assert.deepEqual(paths, []); assert.equal(rejected.length, blocked.length);
  await (await fetch(base + '/global/health')).text();
  await (await fetch(new URL(base + '/models'))).text();
  await (await fetch(new Request(base + '/custom-auth/preflight', { method: 'POST', body: JSON.stringify({ model: 'fixture' }) }))).text();
  await (await fetch(base + '/oauth/token', { method: 'POST', body: 'grant_type=refresh_token' })).text();
  await (await scope.run(undefined, base + '/v1/chat/completions', { method: 'POST', body: '{}' })).text();
  assert.deepEqual(paths, ['/global/health', '/models', '/custom-auth/preflight', '/oauth/token', '/v1/chat/completions']);
  release(); await (await fetch(base + '/v1/chat/completions')).text();
  assert.equal(paths.length, 6); assert.equal(rejected.length, blocked.length);
});
