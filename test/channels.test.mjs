import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { ChannelPool, channelSession } from '../lib/channel-pool.mjs';
import { validateChannels, publicChannels, retainChannelSecrets } from '../lib/channels-config.mjs';
import { ChannelRouter } from '../lib/channel-router.mjs';
import { normalizeConfig } from '../lib/bridge.mjs';
import { validateSettings } from '../lib/settings.mjs';
import { ProxyRuntime } from '../lib/runtime.mjs';
import { createAdminServer } from '../lib/admin-server.mjs';
import { sseEvents } from '../lib/protocol.mjs';
import { channelDraft, channelPatch } from '../frontend/src/channel-data.js';

const channel = (patch = {}) =>
  validateChannels([
    {
      id: 'provider',
      name: '测试渠道',
      protocol: 'openai-chat',
      baseURL: 'http://127.0.0.1:9999/v1',
      keys: ['a', 'b', 'c'].map((id) => ({ id, name: id, key: 'fixture-' + id, enabled: true })),
      models: [{ alias: 'pooled', id: 'upstream', context: 100000, output: 4096 }],
      ...patch
    }
  ])[0];
const settings = (channels) =>
  validateSettings(
    {
      mode: 'global',
      discoverModels: false,
      diagnostics: false,
      channels,
      models: { global: { model: 'existing/global', context: 100000, output: 4096 } },
      apiKeys: [{ id: 'client', name: '测试客户端', key: 'fixture-client-key', enabled: true }],
      modelOverrides: {}
    },
    process.cwd()
  ).settings;
const event = (delta) => ({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] });
class FixtureBridge {
  static calls = [];
  static handler;
  constructor(config) {
    this.config = config;
    this.acceptedModels = config.models;
  }
  async loadModels() {}
  async close() {
    this.closed = true;
  }
  async fetch(url, init, key) {
    const body = JSON.parse(init.body);
    FixtureBridge.calls.push({ body, key, config: this.config, init });
    if (FixtureBridge.handler) return FixtureBridge.handler({ body, key, config: this.config, init });
    const final = {
      id: 'answer',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    };
    init.onModelOutput?.();
    if (!body.stream) return Response.json(final);
    return new Response(
      [
        'data: ' + JSON.stringify(event({ role: 'assistant' })),
        'data: ' + JSON.stringify(event({ content: 'answer' })),
        'data: ' + JSON.stringify({ ...event({}), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]'
      ].join('\n\n') + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );
  }
}
async function fixture(run, channels = [channel()]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opencode-channels-test-'));
  const runtime = new ProxyRuntime({
    file: path.join(directory, 'config.json'),
    settings: settings(channels),
    Bridge: FixtureBridge
  });
  FixtureBridge.calls = [];
  FixtureBridge.handler = undefined;
  try {
    return await run(runtime, directory);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const request = (runtime, session, extra = {}, client = 'client') =>
  runtime.fetch(
    'http://proxy/v1/chat/completions',
    {
      method: 'POST',
      headers: session === undefined ? {} : { 'x-opencode-session-id': session },
      body: JSON.stringify({ model: 'pooled', messages: [{ role: 'user', content: 'hello' }], ...extra })
    },
    undefined,
    { id: client }
  );

test('channel configuration validates credentials, limits, aliases, URLs and masked updates', () => {
  const c = channel();
  assert.equal(c.stickyTtlMs, 1800000);
  assert.equal(c.maxKeyAttempts, 2);
  for (const patch of [
    { stickyTtlMs: 0 },
    { maxBindings: 0 },
    { cooldownMs: Infinity },
    { maxKeyAttempts: 4 },
    { baseURL: 'https://user:secret@example.com/v1' },
    { baseURL: 'https://example.com/v1?key=secret' },
    { protocol: 'unknown' },
    { extra: true },
    { keys: [] },
    { models: [] },
    { keys: [{ id: 'a', name: 'a', key: 'a\nb', enabled: true }] },
    { keys: [{ id: 'a', name: 'a', key: 'secret', apiKeyEnv: 'KEY', enabled: true }] },
    {
      keys: [
        { id: 'a', name: 'a', key: 'same', enabled: true },
        { id: 'b', name: 'b', key: 'same', enabled: true }
      ]
    },
    { models: [{ ...c.models[0], alias: 'bad/name' }] }
  ])
    assert.throws(() => channel(patch));
  assert.throws(() => validateChannels([c, { ...c, id: 'other' }]));
  const masked = publicChannels([c]);
  assert.ok(!JSON.stringify(masked).includes('fixture-'));
  assert.deepEqual(validateChannels(retainChannelSecrets(masked, [c])), [c]);
  masked[0].keys[0].apiKeyEnv = 'OTHER_KEY';
  assert.equal(retainChannelSecrets(masked, [c])[0].keys[0].key, undefined);
  masked[0].id = 'different';
  assert.throws(() => validateChannels(retainChannelSecrets(masked, [c])));
});

test('session IDs support both header representations and metadata, with conflict and size rejection', () => {
  assert.equal(channelSession(new Headers({ 'x-opencode-session-id': 'chat-1' }), {}), 'chat-1');
  assert.equal(channelSession({}, { metadata: { session_id: 'chat-2' } }), 'chat-2');
  assert.equal(channelSession({}, {}, 'previous-session'), 'previous-session');
  assert.equal(channelSession({}, {}), undefined);
  for (const id of ['', 'x'.repeat(129), 'contains space', '中文', 42, null]) {
    assert.throws(
      () => channelSession({}, { metadata: { session_id: id } }),
      (e) => e.status === 400
    );
  }
  assert.throws(() => channelSession({ 'x-opencode-session-id': 'a' }, { metadata: { session_id: 'b' } }));
});

test('round robin is per channel; session and client identity provide independent sticky bindings', () => {
  const pool = new ChannelPool(),
    c = channel();
  try {
    const select = (owner, session, channel = c) => {
      const lease = pool.acquire(channel, owner, session);
      lease.release();
      return lease.id;
    };
    assert.deepEqual(
      Array.from({ length: 6 }, () => select('client')),
      ['a', 'b', 'c', 'a', 'b', 'c']
    );
    assert.equal(select('client', 'one'), 'a');
    assert.equal(select('client', 'one'), 'a');
    assert.equal(select('other-client', 'one'), 'b');
    assert.equal(select('client', 'two'), 'c');
    assert.equal(select('client', 'one', channel({ id: 'another' })), 'a');
    assert.equal(pool.channels.get('provider').bindings.size, 3);
    assert.ok(!JSON.stringify(pool.summary([c])).includes('fixture-'));
  } finally {
    pool.close();
  }
});

test('sliding expiration renews at completion, pins concurrent requests and bounds inactive LRU storage', () => {
  let now = 0;
  const pool = new ChannelPool({ now: () => now }),
    c = channel({ stickyTtlMs: 1000, maxBindings: 2 });
  try {
    const first = pool.acquire(c, 'client', 'one');
    now = 5000;
    pool.prune();
    assert.equal(pool.channels.get(c.id).bindings.size, 1);
    const parallel = pool.acquire(c, 'client', 'one');
    assert.equal(parallel.id, first.id);
    first.release();
    now = 9000;
    pool.prune();
    assert.equal(pool.channels.get(c.id).bindings.size, 1);
    parallel.release();
    parallel.release();
    now = 9999;
    pool.prune();
    assert.equal(pool.channels.get(c.id).bindings.size, 1);
    const renew = pool.acquire(c, 'client', 'one');
    assert.equal(renew.id, 'a');
    renew.release();
    now = 10500;
    pool.prune();
    assert.equal(pool.channels.get(c.id).bindings.size, 1);
    now = 11000;
    pool.prune();
    assert.equal(pool.channels.get(c.id).bindings.size, 0);
    const a = pool.acquire(c, 'client', 'a'),
      b = pool.acquire(c, 'client', 'b');
    assert.throws(
      () => pool.acquire(c, 'client', 'c'),
      (e) => e.code === 'channel_bindings_busy'
    );
    a.release();
    const third = pool.acquire(c, 'client', 'c');
    third.release();
    b.release();
    assert.equal(pool.channels.get(c.id).bindings.size, 2);
  } finally {
    pool.close();
  }
});

test('cooldown honors Retry-After, auth errors require reset, 403 does not invalidate, and rotation clears old bindings', () => {
  let now = 0;
  const pool = new ChannelPool({ now: () => now }),
    c = channel({ cooldownMs: 1000 });
  try {
    const a = pool.acquire(c, 'client', 'one');
    pool.failure(c, a, 429, { 'retry-after': '10' });
    a.release();
    assert.equal(pool.summary([c])[0].keys[0].retryAt, 10000);
    const b = pool.acquire(c, 'client', 'one');
    assert.equal(b.id, 'b');
    pool.failure(c, b, 401);
    b.release();
    const last = pool.acquire(c, 'client', 'one');
    assert.equal(last.id, 'c');
    pool.failure(c, last, 403);
    last.release();
    assert.equal(pool.summary([c])[0].keys[2].status, 'ready');
    const date = pool.acquire(c, 'client', 'one');
    pool.failure(c, date, 429, { 'retry-after': new Date(20000).toUTCString() });
    date.release();
    assert.throws(
      () => pool.acquire(c, 'client', 'new'),
      (e) => e.status === 429 && e.headers['retry-after'] === '10'
    );
    now = 10000;
    const ready = pool.acquire(c, 'client', 'one');
    assert.equal(ready.id, 'a');
    ready.release();
    pool.reset(c.id, 'b');
    assert.equal(pool.summary([c])[0].keys[1].status, 'ready');
    const replaced = channel();
    replaced.keys[0].key = 'replacement';
    pool.reconcile([replaced]);
    assert.equal(pool.channels.get(c.id).bindings.size, 0);
    pool.reconcile([]);
    assert.equal(pool.channels.size, 0);
  } finally {
    pool.close();
  }
});

test('missing or duplicate resolved environment credentials never create extra usable keys', () => {
  const env = 'OPENCODE_PROXY_CHANNEL_UNIT_FIXTURE';
  const previous = process.env[env];
  process.env[env] = 'fixture-a';
  const pool = new ChannelPool();
  try {
    const c = channel({
      keys: [
        { id: 'a', name: 'a', key: 'fixture-a', enabled: true },
        { id: 'b', name: 'b', apiKeyEnv: env, enabled: true }
      ]
    });
    assert.equal(pool.credentials(c).length, 1);
    delete process.env[env];
    c.keys.shift();
    assert.throws(
      () => pool.acquire(c, 'client', 'one'),
      (e) => e.code === 'channel_keys_unavailable'
    );
    assert.equal(pool.summary([c])[0].keys[0].status, 'missing');
  } finally {
    pool.close();
    if (previous === undefined) delete process.env[env];
    else process.env[env] = previous;
  }
});

test('runtime keeps global authentication routing, masks channel secrets and retains binding across settings saves', async () =>
  fixture(async (runtime, dir) => {
    const models = await runtime.models();
    assert.deepEqual(
      models.map((m) => m.id),
      ['global', 'pooled']
    );
    const global = await request(runtime, undefined, { model: 'global' });
    await global.text();
    assert.equal(FixtureBridge.calls.at(-1).key, undefined);
    assert.equal(FixtureBridge.calls.at(-1).config.mode, 'global');
    const first = await request(runtime, 'sticky');
    await first.text();
    assert.equal(FixtureBridge.calls.at(-1).key, 'fixture-a');
    assert.equal(FixtureBridge.calls.at(-1).config.mode, 'isolated');
    const state = runtime.state();
    assert.ok(!JSON.stringify(state).includes('fixture-a'));
    state.settings.channels[0].stickyTtlMs = 60000;
    await runtime.save(state.settings);
    await (await request(runtime, 'sticky')).text();
    assert.equal(FixtureBridge.calls.at(-1).key, 'fixture-a');
    const saved = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.channels[0].keys[0].key, 'fixture-a');
    assert.equal(saved.models.global.model, 'existing/global');
    assert.equal(saved.mode, 'global');
    await runtime.updateModel('channel:provider/pooled', { alias: 'short', defaults: { temperature: 0.4 } });
    await (await request(runtime, 'sticky', { model: 'short' })).text();
    assert.equal(FixtureBridge.calls.at(-1).body.temperature, 0.4);
    assert.equal(FixtureBridge.calls.at(-1).key, 'fixture-a');
  }));

test('runtime rejects alias collisions, key removals and disabled models without persisting invalid configuration', async () =>
  fixture(async (runtime, dir) => {
    await runtime.save(runtime.state().settings);
    const original = await readFile(path.join(dir, 'config.json'), 'utf8');
    const invalid = runtime.state().settings;
    invalid.channels[0].models[0].alias = 'global';
    await assert.rejects(
      () => runtime.save(invalid),
      (e) => e.code === 'duplicate_alias'
    );
    assert.equal(await readFile(path.join(dir, 'config.json'), 'utf8'), original);
    await runtime.updateModel('channel:provider/pooled', { enabled: false });
    assert.equal((await request(runtime, 'one')).status, 403);
    assert.equal(FixtureBridge.calls.length, 0);
    assert.equal((await runtime.models()).find((m) => m.id === 'pooled').enabled, false);
  }));

test('HTTP errors fail over only before output, respect attempt limits and retain health for future requests', async () =>
  fixture(async (runtime) => {
    FixtureBridge.handler = ({ key, body, init }) => {
      if (key === 'fixture-a')
        return Response.json(
          { error: { code: 'upstream_rate_limit' } },
          { status: 429, headers: { 'retry-after': '2' } }
        );
      init.onModelOutput?.();
      return Response.json({
        id: 'ok',
        choices: [{ message: { role: 'assistant', content: body.model }, finish_reason: 'stop' }]
      });
    };
    const response = await request(runtime, 'one');
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(
      FixtureBridge.calls.map((c) => c.key),
      ['fixture-a', 'fixture-b']
    );
    await (await request(runtime, 'one')).text();
    assert.equal(FixtureBridge.calls.at(-1).key, 'fixture-b');
    assert.equal(runtime.state().channelStatus[0].keys[0].status, 'cooling');
    FixtureBridge.calls = [];
    FixtureBridge.handler = ({ init }) => {
      init.onModelOutput?.();
      return Response.json({ error: { code: 'opencode_inference_error' } }, { status: 502 });
    };
    assert.equal((await request(runtime, 'one')).status, 502);
    assert.equal(FixtureBridge.calls.length, 1);
    FixtureBridge.calls = [];
    FixtureBridge.handler = () => Response.json({ error: { code: 'upstream_auth_error' } }, { status: 403 });
    assert.equal((await request(runtime, 'other')).status, 403);
    assert.equal(FixtureBridge.calls.length, 1);
  }));

test('stream cancellation releases a pinned lease and global admission covers channels as well', async () =>
  fixture(async (runtime) => {
    runtime.current.settings.maxConcurrent = 1;
    FixtureBridge.handler = () =>
      new Response(new ReadableStream({ pull() {}, cancel() {} }), {
        headers: { 'content-type': 'text/event-stream' }
      });
    const response = await request(runtime, 'long', { stream: true });
    assert.equal(runtime.state().channelStatus[0].keys[0].active, 1);
    assert.equal((await request(runtime, 'another', { model: 'global' })).status, 429);
    await response.body.cancel();
    assert.equal(runtime.inferenceActive, 0);
    assert.equal(runtime.state().channelStatus[0].keys[0].active, 0);
    assert.equal([...runtime.channelPool.channels.get('provider').bindings.values()][0].active, 0);
  }));

for (const protocol of ['chat', 'responses', 'anthropic'])
  for (const stream of [false, true]) {
    test(`${protocol} carries channel session IDs through HTTP, model discovery and ${stream ? 'SSE' : 'JSON'}`, async () =>
      fixture(async (runtime) => {
        await runtime.startGateway();
        const root = runtime.state().endpoint;
        const body = {
          model: 'pooled',
          stream,
          metadata: { session_id: 'shared' },
          ...(protocol === 'responses'
            ? { input: 'hello' }
            : {
                messages: [{ role: 'user', content: 'hello' }],
                ...(protocol === 'anthropic' ? { max_tokens: 200 } : {})
              })
        };
        const response = await fetch(
          root + { chat: '/chat/completions', responses: '/responses', anthropic: '/messages' }[protocol],
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-client-key' },
            body: JSON.stringify(body)
          }
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-opencode-session-id'), 'shared');
        assert.match(response.headers.get('access-control-expose-headers'), /x-opencode-session-id/);
        const data = stream ? await Array.fromAsync(sseEvents(response.body)) : await response.json();
        assert.match(JSON.stringify(data), /answer/);
        assert.ok(!JSON.stringify(data).includes('fixture-a'));
        assert.equal(FixtureBridge.calls.at(-1).body.metadata, undefined);
        await (await request(runtime, 'shared')).text();
        assert.equal(FixtureBridge.calls.at(-1).key, 'fixture-a');
        const listed = await fetch(root + '/models', { headers: { authorization: 'Bearer fixture-client-key' } });
        assert.deepEqual(
          (await listed.json()).data.map((m) => m.id),
          ['global', 'pooled']
        );
        assert.equal(runtime.inferenceActive, 0);
      }));
  }

test('stored Responses inherit channel session binding without an explicit follow-up ID', async () =>
  fixture(async (runtime) => {
    const send = (body) =>
      runtime.fetch('http://proxy/v1/responses', { method: 'POST', body: JSON.stringify(body) }, undefined, {
        id: 'client'
      });
    const response = await send({ model: 'pooled', input: 'first', store: true });
    const session = response.headers.get('x-opencode-session-id'),
      result = await response.json();
    assert.ok(session);
    await (await request(runtime, 'unrelated')).text();
    const next = await send({ previous_response_id: result.id, input: 'second', store: true });
    assert.equal(next.headers.get('x-opencode-session-id'), session);
    await next.text();
    assert.equal(FixtureBridge.calls.at(-1).key, 'fixture-a');
    assert.equal(FixtureBridge.calls.at(-1).body.messages.filter((m) => m.role === 'user').length, 2);
  }));

test('admin read/write masks credentials, preserves omitted values, resets health and rejects unauthorized changes', async () =>
  fixture(async (runtime) => {
    const { server } = createAdminServer({ runtime, token: 'fixture-admin-token' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const headers = { authorization: 'Bearer fixture-admin-token', 'content-type': 'application/json' };
    try {
      assert.equal((await fetch(base + '/admin/state')).status, 401);
      const state = await (await fetch(base + '/admin/state', { headers })).json();
      assert.ok(!JSON.stringify(state).includes('fixture-a'));
      state.settings.channels[0].name = 'renamed';
      const saved = await fetch(base + '/admin/config', {
        method: 'POST',
        headers,
        body: JSON.stringify(state.settings)
      });
      assert.equal(saved.status, 200);
      assert.ok(!(await saved.text()).includes('fixture-a'));
      assert.equal(runtime.settings.channels[0].keys[0].key, 'fixture-a');
      const lease = runtime.channelPool.acquire(runtime.settings.channels[0], 'client', 'one');
      runtime.channelPool.failure(runtime.settings.channels[0], lease, 401);
      lease.release();
      const reset = await fetch(base + '/admin/channels/reset-key', {
        method: 'POST',
        headers,
        body: JSON.stringify({ channelId: 'provider', keyId: 'a' })
      });
      assert.equal(reset.status, 200);
      assert.equal((await reset.json()).channelStatus[0].keys[0].status, 'ready');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }));

test('frontend channel drafts preserve masked secrets and reject empty, invalid or incomplete edits', () => {
  const c = publicChannels([channel()])[0],
    draft = channelDraft(c);
  draft.stickyTtlMs = '60000';
  draft.models[0].output = '1000';
  assert.equal(channelPatch(draft).stickyTtlMs, 60000);
  assert.equal(channelPatch(draft).keys[0].keyConfigured, true);
  assert.ok(!JSON.stringify(draft).includes('fixture-a'));
  assert.equal(c.models[0].output, 4096);
  for (const change of [
    (d) => {
      d.keys = [];
    },
    (d) => {
      d.models[0].output = '';
    },
    (d) => {
      d.maxBindings = 1.2;
    },
    (d) => {
      delete d.keys[0].keyConfigured;
    },
    (d) => {
      d.models[0].id = '';
    }
  ]) {
    const invalid = channelDraft(c);
    change(invalid);
    assert.throws(() => channelPatch(invalid));
  }
  const created = channelDraft();
  assert.ok(created.id);
  assert.throws(() => channelPatch(created));
});

test('channel router enforces a shared first-output deadline and never leaks an acquired lease on abort', async () => {
  const config = normalizeConfig({ ...settings([channel()]), firstOutputTimeoutMs: 20 });
  const pool = new ChannelPool(),
    router = new ChannelRouter(config, FixtureBridge, pool);
  router.configure(router.models, router.models);
  FixtureBridge.handler = ({ init }) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  try {
    await assert.rejects(
      () =>
        router.fetch(
          'http://proxy/v1/chat/completions',
          { body: JSON.stringify({ model: 'pooled', messages: [{ role: 'user', content: 'hello' }] }) },
          { owner: 'client', session: 'one' }
        ),
      (e) => e.code === 'channel_timeout'
    );
    assert.equal(pool.summary(config.channels)[0].keys[0].active, 0);
  } finally {
    FixtureBridge.handler = undefined;
    await router.close();
    pool.close();
  }
});

test('binding LRU follows completion time and expiration changes apply without resurrecting old secrets', () => {
  let now = 0;
  const pool = new ChannelPool({ now: () => now }),
    c = channel({ maxBindings: 2, stickyTtlMs: 10000 });
  try {
    const long = pool.acquire(c, 'client', 'long'),
      quick = pool.acquire(c, 'client', 'quick');
    const quickToken = quick.token;
    quick.release();
    now = 500;
    long.release();
    const fresh = pool.acquire(c, 'client', 'fresh');
    fresh.release();
    const values = [...pool.channels.get(c.id).bindings.values()];
    assert.ok(!values.some((binding) => binding.token === quickToken));
    const updated = channel({ maxBindings: 2, stickyTtlMs: 1000 });
    now = 1500;
    pool.reconcile([updated]);
    assert.equal(pool.channels.get(c.id).bindings.size, 0);
  } finally {
    pool.close();
  }
});

test('many concurrent sessions round robin fairly while the same session remains pinned across models', async () =>
  fixture(async (runtime) => {
    const c = runtime.settings.channels[0];
    const results = await Promise.all(Array.from({ length: 90 }, (_, i) => request(runtime, 'burst-' + i)));
    for (const response of results) {
      assert.equal(response.status, 200);
      await response.text();
    }
    const distribution = FixtureBridge.calls.reduce((counts, call) => {
      counts[call.key] = (counts[call.key] ?? 0) + 1;
      return counts;
    }, {});
    assert.deepEqual(Object.values(distribution), [30, 30, 30]);
    assert.equal(runtime.inferenceActive, 0);
    assert.equal(
      runtime.state().channelStatus[0].keys.reduce((n, k) => n + k.active, 0),
      0
    );
    const other = structuredClone(c.models[0]);
    other.alias = 'pooled-second';
    const next = runtime.state().settings;
    next.channels[0].models.push(other);
    await runtime.save(next);
    await (await request(runtime, 'burst-0', { model: 'pooled-second' })).text();
    assert.equal(FixtureBridge.calls.at(-1).key, 'fixture-a');
  }));

test('stream failure reports key health without replay; exhausted and cancelled requests release every lease', async () =>
  fixture(async (runtime) => {
    FixtureBridge.handler = ({ init }) => {
      init.onModelOutput?.();
      return new Response(
        new ReadableStream({
          start(out) {
            out.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event({ content: 'partial' })) + '\n\n'));
            init.onUpstreamError?.({ status: 429, headers: { 'retry-after': '3' } });
            out.enqueue(
              new TextEncoder().encode('data: {"error":{"code":"upstream_rate_limit","message":"limited"}}\n\n')
            );
            out.close();
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    };
    const response = await request(runtime, 'partial', { stream: true });
    const events = await Array.fromAsync(sseEvents(response.body));
    assert.match(JSON.stringify(events), /partial/);
    assert.equal(FixtureBridge.calls.length, 1);
    assert.equal(runtime.state().channelStatus[0].keys[0].status, 'cooling');
    FixtureBridge.calls = [];
    FixtureBridge.handler = () => Response.json({ error: { code: 'upstream_auth_error' } }, { status: 401 });
    const failed = await request(runtime, 'fail');
    assert.equal(failed.status, 401);
    await failed.text();
    assert.equal(FixtureBridge.calls.length, 2);
    assert.equal(
      runtime.state().channelStatus[0].keys.reduce((n, k) => n + k.active, 0),
      0
    );
    assert.equal((await request(runtime, 'all-failed')).status, 429);
  }));

test('configuration changes preserve active old-generation requests and route new requests with replacement credentials', async () =>
  fixture(async (runtime) => {
    const gate = Promise.withResolvers();
    FixtureBridge.handler = () =>
      new Response(
        new ReadableStream({
          async pull(out) {
            await gate.promise;
            out.close();
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    const response = await request(runtime, 'inflight', { stream: true });
    const retired = runtime.current;
    const next = runtime.state().settings;
    next.channels[0].keys[0].key = 'new-fixture-a';
    await runtime.save(next);
    assert.equal(retired.active, 1);
    assert.equal(retired.bridge.closed, undefined);
    FixtureBridge.handler = undefined;
    await (await request(runtime, 'inflight')).text();
    assert.notEqual(FixtureBridge.calls.at(-1).key, 'fixture-a');
    await (await request(runtime, 'next-one')).text();
    await (await request(runtime, 'next-two')).text();
    assert.equal(FixtureBridge.calls.at(-1).key, 'new-fixture-a');
    gate.resolve();
    await response.text();
    assert.equal(retired.active, 0);
    await retired.closing;
    assert.equal(retired.bridge.closed, true);
    assert.equal(runtime.inferenceActive, 0);
  }));

test('disabled channel overrides cannot reopen transport; invalid inference requests do not allocate bindings', async () =>
  fixture(async (runtime) => {
    await runtime.updateModel('channel:provider/pooled', { enabled: true });
    const next = runtime.state().settings;
    next.channels[0].enabled = false;
    await runtime.save(next);
    assert.equal((await runtime.models()).find((m) => m.id === 'pooled').enabled, false);
    assert.equal((await request(runtime, 'disabled')).status, 403);
    assert.equal(FixtureBridge.calls.length, 0);
    next.channels[0].enabled = true;
    await runtime.save(next);
    const invalid = await request(runtime, 'invalid', { max_tokens: -1 });
    assert.equal(invalid.status, 400);
    assert.equal(runtime.state().channelStatus[0].bindings, 0);
    assert.equal(FixtureBridge.calls.length, 0);
  }));

test('changing a channel endpoint resets health and bindings without altering the credential itself', () => {
  const pool = new ChannelPool(),
    old = channel();
  try {
    const lease = pool.acquire(old, 'client', 'one');
    pool.failure(old, lease, 401);
    lease.release();
    assert.equal(pool.summary([old])[0].keys[0].status, 'invalid');
    const next = channel({ baseURL: 'http://127.0.0.1:9998/v1' });
    pool.reconcile([next]);
    assert.equal(pool.summary([next])[0].keys[0].status, 'ready');
    assert.equal(pool.channels.get(old.id).bindings.size, 0);
    const replacement = pool.acquire(next, 'client', 'one');
    assert.equal(replacement.value, old.keys.find((k) => k.id === replacement.id).key);
    replacement.release();
  } finally {
    pool.close();
  }
});

test('a channel with only one usable key preserves 429 and its cooldown when no alternate can be tried', async () =>
  fixture(
    async (runtime) => {
      FixtureBridge.handler = () =>
        Response.json({ error: { code: 'upstream_rate_limit' } }, { status: 429, headers: { 'retry-after': '2' } });
      const response = await request(runtime, 'one');
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get('retry-after')) >= 29);
      await response.text();
      assert.equal(FixtureBridge.calls.length, 1);
      assert.equal(runtime.state().channelStatus[0].keys[0].active, 0);
    },
    [channel({ keys: [{ id: 'a', name: 'single', key: 'fixture-single', enabled: true }] })]
  ));
