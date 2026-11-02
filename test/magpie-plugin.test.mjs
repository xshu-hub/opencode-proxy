import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createPlugin } from '../lib/magpie-plugin.mjs';
import { ApiError } from '../lib/protocol.mjs';

const url = 'http://opencode-proxy.invalid/v1/chat/completions';
const auth = { type: 'api', key: 'local' };
const model = { model: 'vendor/coder', name: 'Coder', context: 100000, output: 8000, inputModalities: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'] };

async function fixture(t, { options, catalog = { coder: model, 'oc-default': { context: 128000, output: 16384 } } } = {}) {
  const calls = [], instances = [];
  class Bridge {
    constructor(config) { this.config = config; instances.push(this); }
    async loadModels(refresh) { calls.push({ list: refresh }); this.onList?.(); if (this.listError) throw this.listError; return this.pending ?? this.catalog ?? catalog; }
    async fetch(...args) { calls.push({ request: args }); if (this.error) throw this.error; return this.response ?? Response.json({ choices: [{ message: { content: 'hello' } }] }); }
    async close() { this.closed = (this.closed ?? 0) + 1; }
  }
  const hooks = await createPlugin(Bridge)({ directory: os.tmpdir(), magpie: {} }, options);
  t.after(() => hooks.dispose());
  return { hooks, calls, instances, list: () => hooks.provider.models({ models: {} }, { auth }), loader: () => hooks.auth.loader(async () => auth) };
}

test('Magpie discovers a single local provider without starting OpenCode or acquiring upstream credentials', async t => {
  const { hooks, instances } = await fixture(t);
  const cfg = {};
  await hooks.config(cfg);
  assert.equal(cfg.provider['opencode-proxy'].npm, '@ai-sdk/openai-compatible');
  assert.deepEqual(cfg.provider['opencode-proxy'].models, {});
  assert.equal(instances.length, 0);
  assert.equal(hooks.auth.single, true);
  assert.equal(hooks.auth.methods[0].keyless, true);
  assert.deepEqual(await hooks.auth.methods[0].authorize(), { type: 'success', key: 'local' });
  assert.deepEqual(await hooks.provider.models({ models: {} }), {});
  assert.equal(instances.length, 0);
  const own = { name: 'User-owned provider' };
  cfg.provider['opencode-proxy'] = own;
  await hooks.config(cfg);
  assert.equal(cfg.provider['opencode-proxy'], own);
});

test('the plugin rejects recursive installation and old gateway or direct-provider configuration', async () => {
  await assert.rejects(createPlugin()({}), /Install.*Magpie/);
  for (const options of [null, [], { mode: 'isolated' }, { apiKey: 'secret' }, { models: {} }, { host: '0.0.0.0' }, { maxConcurrent: 1 }]) {
    await assert.rejects(createPlugin()({ directory: os.tmpdir(), magpie: {} }, options), /options|Unsupported/);
  }
});

test('model discovery publishes capabilities and short ids, never backend credentials or recursive routes', async t => {
  const catalog = {
    coder: { ...model, apiKey: 'PRIVATE', baseURL: 'https://private.invalid', headers: { Authorization: 'PRIVATE' } },
    'oc-default': { context: 128000, output: 16384 },
    loop: { ...model, model: 'magpie/coder' },
    self: { ...model, model: 'opencode-proxy/coder' },
  };
  const f = await fixture(t, { catalog });
  const listed = await f.list();
  assert.deepEqual(Object.keys(listed), ['coder']);
  assert.equal(listed.coder.api.id, 'coder');
  assert.equal(listed.coder.api.npm, '@ai-sdk/openai-compatible');
  assert.deepEqual(listed.coder.limit, { context: 100000, output: 8000 });
  assert.equal(listed.coder.capabilities.input.image, true);
  assert.equal(listed.coder.capabilities.reasoning, true);
  assert.deepEqual(Object.keys(listed.coder.variants), ['low', 'high']);
  assert.doesNotMatch(JSON.stringify(listed), /PRIVATE|private\.invalid|vendor\/coder/);
  assert.equal(f.instances[0].config.mode, 'global');
  assert.equal(f.instances[0].config.maxConcurrent, 0);
});

test('requests reuse the bridge and preserve Chat bodies without forwarding Magpie credentials', async t => {
  const f = await fixture(t);
  const loader = await f.loader();
  const body = { model: 'coder', messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }], temperature: 0.2, reasoning_effort: 'high', stream: false };
  const first = await loader.fetch(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer MAGPIE_PRIVATE', 'x-api-key': 'OTHER_PRIVATE' } }));
  assert.equal(first.status, 200);
  await first.json();
  await (await loader.fetch(url, { method: 'POST', body: JSON.stringify(body) })).text();
  assert.equal(f.instances.length, 1);
  const args = f.calls.filter(c => c.request).map(c => c.request);
  assert.equal(args.length, 2);
  assert.deepEqual(JSON.parse(args[0][1].body), body);
  assert.equal(args[0].length, 2, 'The local marker is never used as an upstream key');
  assert.equal(args[0][1].headers, undefined);
});

test('streaming responses and upstream errors pass through without buffering or protocol conversion', async t => {
  const f = await fixture(t);
  await f.list();
  const loader = await f.loader();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  f.instances[0].response = response;
  const result = await loader.fetch(url, { method: 'POST', body: JSON.stringify({ model: 'coder', messages: [] }) });
  assert.equal(result, response);
  await result.body.cancel();
  assert.equal(cancelled, true);
  const upstream = Response.json({ error: { message: 'rate limited' } }, { status: 429, headers: { 'retry-after': '3' } });
  f.instances[0].response = upstream;
  assert.equal(await loader.fetch(url, { method: 'POST', body: '{"model":"coder","messages":[]}' }), upstream);
});

test('authentication revocation and malformed or non-Chat calls never reach the bridge', async t => {
  const f = await fixture(t);
  await assert.rejects(f.hooks.auth.loader(async () => null), /Enable local/);
  let signedIn = auth;
  const loader = await f.hooks.auth.loader(async () => signedIn);
  for (const [input, init, status] of [
    [url.replace('chat/completions', 'responses'), { method: 'POST', body: '{}' }, 404],
    ['https://unrelated.invalid/v1/chat/completions', { method: 'POST', body: '{}' }, 404],
    [url, { method: 'GET' }, 404],
    [url, { method: 'POST', body: '{' }, 400],
    [url, { method: 'POST', body: '[]' }, 400],
    [url, { method: 'POST', body: '{"model":"magpie/coder"}' }, 404],
  ]) {
    const response = await loader.fetch(input, init);
    assert.equal(response.status, status, await response.text());
  }
  signedIn = null;
  assert.equal((await loader.fetch(url, { method: 'POST', body: '{"model":"coder"}' })).status, 401);
  assert.equal(f.calls.filter(c => c.request).length, 0);
});

test('cancelled requests do not start inference, including while shared model discovery is pending', async t => {
  const f = await fixture(t);
  const loader = await f.loader();
  const pending = Promise.withResolvers();
  await f.list();
  f.instances[0].catalog = {};
  await f.list();
  f.instances[0].pending = pending.promise;
  const started = Promise.withResolvers();
  f.instances[0].onList = started.resolve;
  const controller = new AbortController();
  const task = loader.fetch(url, { method: 'POST', body: '{"model":"coder"}', signal: controller.signal });
  await started.promise;
  controller.abort(new Error('client cancelled'));
  await assert.rejects(task, /client cancelled/);
  pending.resolve({ coder: model });
  assert.equal(f.calls.filter(c => c.request).length, 0);
});

test('a model refresh removes disappeared models and discovery errors are reported to Magpie', async t => {
  const f = await fixture(t);
  await f.list();
  f.instances[0].catalog = { next: { ...model, model: 'vendor/next' } };
  assert.deepEqual(Object.keys(await f.list()), ['next']);
  const loader = await f.loader();
  assert.equal((await loader.fetch(url, { method: 'POST', body: '{"model":"coder"}' })).status, 404);
  f.instances[0].listError = new Error('discovery failed');
  await assert.rejects(f.list(), /discovery failed/);
  assert.ok(f.calls.filter(c => c.list !== undefined).every(c => c.list === true));
});

test('disposal closes the bridge once and subsequent requests cannot create another process', async t => {
  const f = await fixture(t);
  const loader = await f.loader();
  await f.list();
  await f.hooks.dispose();
  await f.hooks.dispose();
  const response = await loader.fetch(url, { method: 'POST', body: '{"model":"coder"}' });
  assert.equal(response.status, 503);
  assert.equal(f.instances[0].closed, 1);
  assert.equal(f.instances.length, 1);
  assert.equal(f.calls.filter(c => c.request).length, 0);
});

test('bridge exceptions expose only public ApiError messages and keep private details out of responses', async t => {
  const f = await fixture(t);
  await f.list();
  const loader = await f.loader();
  f.instances[0].error = new Error('PRIVATE_PROVIDER_CREDENTIAL');
  const response = await loader.fetch(url, { method: 'POST', body: '{"model":"coder"}' });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /PRIVATE_PROVIDER/);
  f.instances[0].error = new ApiError('public failure', 429);
  assert.equal((await loader.fetch(url, { method: 'POST', body: '{"model":"coder"}' })).status, 429);
});
