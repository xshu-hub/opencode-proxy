import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlugin } from '../lib/magpie-plugin.mjs';
import { OpenCodeTransport } from '../lib/transport.mjs';
import { globalProfile } from './global-profile.mjs';
import { sseEvents } from './sse.mjs';
import { toolCalls } from './tool-deltas.mjs';

if (!process.env.TEST_OPENCODE_COMMAND) throw new Error('Set TEST_OPENCODE_COMMAND to a real OpenCode command array.');
const command = JSON.parse(process.env.TEST_OPENCODE_COMMAND);
const reportFile = path.resolve('artifacts/behavior-verification.json');
const chat = (id, messages = [{ role: 'system', content: 'SYSTEM:' + id }, { role: 'user', content: 'USER:' + id }]) => ({ model: 'mock', metadata: { user_id: id }, messages });
const json = (res, value, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
const answer = (id, content = id) => ({ id: 'chat_' + id, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
const chunk = (id, delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta, finish_reason }] });
const sse = value => 'data: ' + JSON.stringify(value) + '\n\n';
const waitUntil = async (predicate, why, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!await predicate()) { if (Date.now() > deadline) assert.fail(why); await delay(10); }
};

test('real OpenCode: streaming boundaries, parallel tools, conversation isolation, cancellation and caller retries', { timeout: 120000 }, async t => {
  const plans = new Map(), checks = [];
  const profile = await globalProfile({ respond: async args => {
    const plan = plans.get(args.body.metadata?.user_id);
    if (!plan) return false;
    await plan(args); return true;
  } });
  let transport;
  class Tracked extends OpenCodeTransport { constructor(config) { super(config); transport = this; } }
  const hooks = await createPlugin(Tracked)({ directory: profile.home, magpie: {} }, { command, startupTimeoutMs: 20000, firstOutputTimeoutMs: 20000, idleTimeoutMs: 20000 });
  t.after(async () => { await hooks.dispose(); await profile.close(); });
  const auth = { type: 'api', key: 'local' };
  await hooks.provider.models({}, { auth });
  const loader = await hooks.auth.loader(async () => auth);
  const send = (body, endpoint = '/chat/completions', signal) => loader.fetch(loader.baseURL + endpoint, { method: 'POST', body: JSON.stringify(body), signal, headers: { authorization: 'Bearer CLIENT_ONLY', 'x-api-key': 'CLIENT_ONLY' } });
  const record = id => profile.requests.filter(r => r.body.metadata?.user_id === id);
  const settle = async () => waitUntil(async () => {
    const state = await transport.diagnostics();
    return !state.active && !state.pendingClients && !state.pending && !state.refreshing && !profile.activity().active;
  }, 'Request resources were not released');
  const check = async (name, action) => t.test(name, async () => { await action(); checks.push(name); });
  // Initialize all four captures before testing short deadlines and failures.
  for (const [body, api] of [[chat('warm-chat'), '/chat/completions'], [{ ...chat('warm-api'), model: 'api-model' }, '/chat/completions'], [{ model: 'response-model', input: 'warm' }, '/responses'], [{ model: 'message-model', max_tokens: 100, messages: [{ role: 'user', content: 'warm' }] }, '/messages']]) await (await send(body, api)).arrayBuffer();
  await settle();
  const initial = await transport.diagnostics();

  await check('all three APIs deliver first bytes before EOF and preserve split UTF-8, SSE events and usage exactly', async () => {
    for (const [kind, model, api, payload, wire] of [
      ['chat', 'mock', '/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }, ': heartbeat\r\n\r\n' + sse(chunk('chat', { content: '中文🙂' })) + sse({ ...chunk('chat', {}, 'stop'), usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + 'data: [DONE]\n\n'],
      ['responses', 'response-model', '/responses', { input: 'hello', store: false }, 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"中文🙂","sequence_number":1}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_wire","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n'],
      ['messages', 'message-model', '/messages', { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 }, 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"中文🙂"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'],
    ]) {
      const id = 'wire-' + kind, released = Promise.withResolvers(), bytes = Buffer.from(wire);
      plans.set(id, async ({ res }) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-fixture-request': id }); res.write(bytes.subarray(0, 1));
        await released.promise;
        const unicode = bytes.indexOf(Buffer.from('中文'));
        for (const part of [bytes.subarray(1, unicode + 1), bytes.subarray(unicode + 1, unicode + 2), bytes.subarray(unicode + 2)]) { if (!res.destroyed) res.write(part); await delay(5); }
        res.end();
      });
      const body = { model, metadata: { user_id: id }, stream: true, ...payload };
      try {
        const response = await send(body, api, AbortSignal.timeout(5000));
        assert.equal(response.status, 200); assert.equal(response.headers.get('x-fixture-request'), id);
        const reader = response.body.getReader(), first = await reader.read();
        assert.equal(first.done, false); assert.deepEqual(Buffer.from(first.value), bytes.subarray(0, 1));
        released.resolve(); const received = [first.value];
        for (;;) { const next = await reader.read(); if (next.done) break; received.push(next.value); }
        assert.deepEqual(Buffer.concat(received), bytes);
        assert.deepEqual(record(id)[0].body, body);
      } finally { released.resolve(); }
    }
    await settle();
  });

  await check('eight concurrent four-turn conversations keep interleaved tool arguments, repeated call IDs and histories isolated', async () => {
    const expected = new Map();
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const client = 'client-' + index;
      const tools = ['lookup', 'calculate'].map(name => ({ type: 'function', function: { name: name + '_' + index, parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }));
      const id = client + ':1', first = { ...chat(id), tools, parallel_tool_calls: true, stream: true, tool_choice: 'auto' };
      expected.set(id, first);
      plans.set(id, async ({ res }) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const delta of [
          { tool_calls: [{ index: 1, id: 'same-calculate-id', type: 'function', function: { name: 'calculate_' + index, arguments: '{"value":' } }] },
          { tool_calls: [{ index: 0, id: 'same-lookup-id', type: 'function', function: { name: 'lookup_' + index, arguments: '{"value":"北' } }] },
          { tool_calls: [{ index: 1, function: { arguments: '"' + client + '"}' } }] },
          { tool_calls: [{ index: 0, function: { arguments: '京🙂-' + client + '"}' } }] },
        ]) { res.write(sse(chunk(client, delta))); await delay(8); }
        res.end(sse({ ...chunk(client, {}, 'tool_calls'), usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + 'data: [DONE]\n\n');
      });
      const response = await send(first), frames = await Array.fromAsync(sseEvents(response.body));
      const calls = toolCalls(frames).map(({ index: unused, ...call }) => call);
      assert.equal(calls.length, 2); assert.equal(calls[0].function.name, 'lookup_' + index); assert.equal(calls[1].function.name, 'calculate_' + index);
      assert.deepEqual(JSON.parse(calls[0].function.arguments), { value: '北京🙂-' + client });
      assert.deepEqual(JSON.parse(calls[1].function.arguments), { value: client });
      const history = [...first.messages, { role: 'assistant', content: null, tool_calls: calls }, { role: 'tool', tool_call_id: calls[1].id, content: 'CALC_RESULT:' + client }, { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify({ error: 'CLIENT_TOOL_ERROR:' + client }) }];
      const secondID = client + ':2', second = { ...chat(secondID, history), tools, stream: false };
      expected.set(secondID, second); plans.set(secondID, ({ res }) => json(res, answer(secondID)));
      const secondReply = await (await send(second)).json();
      assert.equal(secondReply.choices[0].message.content, secondID);
      const thirdID = client + ':3', third = { ...chat(thirdID, [...history, secondReply.choices[0].message, { role: 'user', content: 'CORRECTION:' + client }]), tools: [], tool_choice: 'none' };
      expected.set(thirdID, third); plans.set(thirdID, ({ res }) => json(res, answer(thirdID)));
      assert.equal((await (await send(third)).json()).choices[0].message.content, thirdID);
      const resetID = client + ':reset', reset = chat(resetID);
      expected.set(resetID, reset); plans.set(resetID, ({ res }) => json(res, answer(resetID)));
      assert.equal((await (await send(reset)).json()).choices[0].message.content, resetID);
    }));
    for (const [id, body] of expected) { assert.equal(record(id).length, 1, 'No local tool execution, automatic inference or retry'); assert.deepEqual(record(id)[0].body, body); }
    await settle();
  });

  await check('Responses and Messages preserve native tool results, signed thinking, encrypted reasoning and three-turn history', async () => {
    const responseCall = { id: 'fc_same', type: 'function_call', call_id: 'same-call-id', name: 'lookup', arguments: '{"city":"上海"}' };
    const reasoning = { type: 'reasoning', id: 'reason_same', encrypted_content: 'fixture-opaque-encrypted', summary: [{ type: 'summary_text', text: 'fixture summary' }] };
    let input = [{ role: 'user', content: [{ type: 'input_text', text: 'RESPONSE_USER' }] }];
    const tools = [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }, strict: true }];
    for (let turn = 1; turn <= 3; turn++) {
      const id = 'responses-turn-' + turn, output = turn === 1 ? [reasoning, responseCall] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: id, annotations: [] }] }];
      plans.set(id, ({ res }) => json(res, { id: 'resp_same', object: 'response', status: 'completed', output }));
      const body = { model: 'response-model', instructions: 'RESPONSE_SYSTEM', input, tools, store: false, reasoning: { effort: 'high' }, include: ['reasoning.encrypted_content'], metadata: { user_id: id } };
      const reply = await (await send(body, '/responses')).json();
      assert.deepEqual(reply.output, output); assert.deepEqual(record(id)[0].body, body);
      input = [...input, ...reply.output, turn === 1 ? { type: 'function_call_output', call_id: 'same-call-id', output: 'CLIENT_RESPONSE_RESULT' } : { role: 'user', content: 'RESPONSE_CORRECTION' }];
    }
    const toolUse = { type: 'tool_use', id: 'same-call-id', name: 'lookup', input: { city: '上海' } };
    const thinking = { type: 'thinking', thinking: 'fixture reasoning', signature: 'fixture-opaque-signature' };
    let messages = [{ role: 'user', content: [{ type: 'text', text: 'MESSAGES_USER' }] }];
    for (let turn = 1; turn <= 3; turn++) {
      const id = 'messages-turn-' + turn, content = turn === 1 ? [thinking, toolUse] : [{ type: 'text', text: id }];
      plans.set(id, ({ res }) => json(res, { id: 'msg_same', type: 'message', role: 'assistant', content, stop_reason: turn === 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }));
      const body = { model: 'message-model', system: [{ type: 'text', text: 'MESSAGES_SYSTEM' }], max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 1024 }, messages, tools: [{ name: 'lookup', input_schema: tools[0].parameters }], metadata: { user_id: id } };
      const reply = await (await send(body, '/messages')).json();
      assert.deepEqual(reply.content, content); assert.deepEqual(record(id)[0].body, body);
      messages = [...messages, { role: 'assistant', content: reply.content }, { role: 'user', content: turn === 1 ? [{ type: 'tool_result', tool_use_id: 'same-call-id', content: 'CLIENT_TOOL_ERROR', is_error: true }] : [{ type: 'text', text: 'MESSAGES_CORRECTION' }] }];
    }
    await settle();
  });

  await check('32 mixed-provider streams correlate their own body, credentials, result and headers', async () => {
    await Promise.all(Array.from({ length: 32 }, async (_, i) => {
      const id = 'isolation-' + i, body = { ...chat(id), model: i % 2 ? 'mock' : 'api-model', stream: true };
      plans.set(id, async ({ res }) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'x-fixture-request': id }); res.write(sse(chunk(id, { content: id }))); await delay(40); res.end(sse(chunk(id, {}, 'stop')) + 'data: [DONE]\n\n'); });
      const response = await send(body); assert.equal(response.headers.get('x-fixture-request'), id);
      const frames = await Array.fromAsync(sseEvents(response.body));
      assert.equal(frames[0].choices[0].delta.content, id); assert.ok(frames.every(frame => frame.id === id));
      const entry = record(id)[0]; assert.deepEqual(entry.body, body);
      assert.equal(entry.authorization, i % 2 ? 'Bearer fixture-renewed' : 'Bearer fixture-key');
      assert.equal(entry.marker, i % 2 ? 'real-plugin' : undefined);
    }));
    await settle();
  });

  await check('one cancellation never cancels peers: before headers, after output, body.cancel and reader.cancel', async () => {
    const healthy = Array.from({ length: 8 }, (_, i) => {
      const id = 'healthy-peer-' + i; plans.set(id, async ({ res }) => { await delay(150); json(res, answer(id)); });
      return send(chat(id)).then(async r => { assert.equal(r.status, 200); assert.equal((await r.json()).choices[0].message.content, id); });
    });
    await Promise.all(Array.from({ length: 16 }, async (_, i) => {
      const id = 'cancel-' + i, started = Promise.withResolvers(), controller = new AbortController();
      plans.set(id, ({ res }) => { if (i % 4) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse(chunk(id, { content: id }))); } started.resolve(); });
      const pending = send({ ...chat(id), stream: true }, '/chat/completions', controller.signal);
      await started.promise;
      if (i % 4 === 0) { controller.abort(); await assert.rejects(pending); }
      else {
        const response = await pending;
        if (i % 4 === 1) { controller.abort(); await assert.rejects(response.text()); }
        else if (i % 4 === 2) await response.body.cancel();
        else { const reader = response.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel(); }
      }
      assert.equal(record(id).length, 1);
    }));
    await Promise.all(healthy); await settle();
    const untouched = 'after-aborts'; plans.set(untouched, ({ res }) => json(res, answer(untouched)));
    assert.equal((await (await send(chat(untouched))).json()).choices[0].message.content, untouched);
    const cancelled = AbortSignal.abort(new Error('already-cancelled'));
    await assert.rejects(send(chat('never-sent'), '/chat/completions', cancelled), /already-cancelled/);
    assert.equal(record('never-sent').length, 0); await settle();
  });

  await check('upstream truncation is an error, total deadline interrupts continuous output, neither is replayed', async () => {
    const id = 'truncated-stream', cut = Promise.withResolvers();
    plans.set(id, async ({ res }) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse(chunk(id, { content: 'partial' }))); await cut.promise; res.destroy(); });
    try {
      const response = await send({ ...chat(id), stream: true }), reader = response.body.getReader();
      const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /partial/);
      cut.resolve(); await assert.rejects(reader.read());
      assert.equal(record(id).length, 1);
    } finally { cut.resolve(); }
    await settle();
    const continuous = 'continuous-until-total';
    plans.set(continuous, ({ res }) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': heartbeat\n\n'); const timer = setInterval(() => res.write(': heartbeat\n\n'), 15); res.once('close', () => clearInterval(timer)); });
    transport.config.timeoutMs = 150; transport.config.idleTimeoutMs = 1000;
    try { const response = await send({ ...chat(continuous), stream: true }); assert.equal(response.status, 200); await assert.rejects(response.text()); }
    finally { transport.config.timeoutMs = 0; transport.config.idleTimeoutMs = 20000; }
    assert.equal(record(continuous).length, 1); await settle();
  });

  await check('late cancellation and another request timeout leave a live peer and its deadline untouched', async () => {
    const completedID = 'completed-before-abort', controller = new AbortController();
    plans.set(completedID, ({ res }) => json(res, answer(completedID)));
    await (await send(chat(completedID), '/chat/completions', controller.signal)).json();
    const peerID = 'live-peer-during-timeout', release = Promise.withResolvers();
    plans.set(peerID, async ({ res }) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse(chunk(peerID, { content: peerID }))); await release.promise; res.end(sse(chunk(peerID, {}, 'stop')) + 'data: [DONE]\n\n'); });
    const peer = await send({ ...chat(peerID), stream: true }), reader = peer.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /live-peer-during-timeout/);
    controller.abort();
    const timeoutID = 'isolated-first-timeout'; plans.set(timeoutID, () => {});
    transport.config.firstOutputTimeoutMs = 120;
    try { const timed = await send(chat(timeoutID)); assert.equal(timed.status, 504); await timed.json(); }
    finally { transport.config.firstOutputTimeoutMs = 20000; release.resolve(); }
    let rest = ''; for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    assert.match(rest, /\[DONE\]/); assert.equal(record(peerID).length, 1); await settle();
  });

  await check('pre-output timeout releases the first attempt and the caller can explicitly retry the same tool history', async () => {
    const id = 'caller-timeout-retry'; let attempts = 0;
    plans.set(id, ({ res }) => { if (++attempts === 2) json(res, answer(id)); });
    const body = chat(id, [{ role: 'system', content: 'RETRY_SYSTEM' }, { role: 'assistant', tool_calls: [{ id: 'retry-call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'retry-call', content: 'RETRY_TOOL_RESULT' }, { role: 'user', content: 'continue' }]);
    transport.config.firstOutputTimeoutMs = 120;
    try {
      const timed = await send(body); assert.equal(timed.status, 504); assert.equal((await timed.json()).error.code, 'transport_timeout');
      await settle(); assert.equal(record(id).length, 1, 'The plugin does not perform an implicit retry');
      const retried = await send(body); assert.equal(retried.status, 200); assert.equal((await retried.json()).choices[0].message.content, id);
      assert.equal(record(id).length, 2); for (const entry of record(id)) assert.deepEqual(entry.body, body);
    } finally { transport.config.firstOutputTimeoutMs = 20000; }
    for (const status of [429, 503]) {
      const errorID = 'caller-status-retry-' + status; let count = 0;
      plans.set(errorID, ({ res }) => ++count === 1 ? json(res, { error: { message: 'fixture temporary', code: 'fixture_' + status } }, status, { 'retry-after': '1' }) : json(res, answer(errorID)));
      const request = chat(errorID), refused = await send(request);
      assert.equal(refused.status, status); assert.equal(refused.headers.get('retry-after'), '1'); await refused.json();
      assert.equal(record(errorID).length, 1);
      assert.equal((await (await send(request)).json()).choices[0].message.content, errorID); assert.equal(record(errorID).length, 2);
    }
    const networkID = 'caller-network-retry'; let networkAttempts = 0;
    plans.set(networkID, ({ res }) => ++networkAttempts === 1 ? res.destroy() : json(res, answer(networkID)));
    const networkBody = chat(networkID), failed = await send(networkBody);
    assert.equal(failed.status, 503); await failed.json(); assert.equal(record(networkID).length, 1);
    assert.equal((await (await send(networkBody)).json()).choices[0].message.content, networkID); assert.equal(record(networkID).length, 2);
    await settle();
  });

  const state = await transport.diagnostics();
  assert.equal(state.pid, initial.pid); assert.equal(state.starts, 1); assert.equal(state.bootstraps, initial.bootstraps); assert.equal(state.sessions, 0);
  assert.equal(await profile.mcpStarted(), false); assert.equal(await readFile(profile.configPath, 'utf8'), profile.original);
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, JSON.stringify({ runtime: state.version, checks, requests: profile.requests.length, peakMockConcurrency: profile.activity().peak, processes: state.starts, sessions: state.sessions, active: state.active, pendingClients: state.pendingClients, pending: state.pending, refreshing: state.refreshing, retryPolicy: 'caller-owned; never replay cancelled or partially emitted requests' }, null, 2) + '\n');
});

test('cold bootstrap survives one cancelled waiter and cleans up after all waiters cancel or time out', { timeout: 60000 }, async t => {
  const profile = await globalProfile({ respond: ({ body, res }) => { const id = body.metadata?.user_id; if (!id) return false; json(res, answer(id)); return true; } });
  let transport;
  class Tracked extends OpenCodeTransport { constructor(config) { super(config); transport = this; } }
  const hooks = await createPlugin(Tracked)({ directory: profile.home, magpie: {} }, { command, startupTimeoutMs: 20000, firstOutputTimeoutMs: 20000 });
  t.after(async () => { await profile.releaseBootstrap(); await hooks.dispose(); await profile.close(); });
  const auth = { type: 'api', key: 'local' }; await hooks.provider.models({}, { auth });
  const loader = await hooks.auth.loader(async () => auth);
  const send = (body, signal, api = '/chat/completions') => loader.fetch(loader.baseURL + api, { method: 'POST', body: JSON.stringify(body), signal });
  const idle = async () => waitUntil(async () => { const s = await transport.diagnostics(); return !s.pending && !s.active && !s.pendingClients && !s.sessions; }, 'Cold bootstrap did not release its session and waiters');
  await profile.holdBootstrap();
  const cancelled = new AbortController(), first = send(chat('cold-cancelled'), cancelled.signal);
  const rejected = assert.rejects(first); void rejected.catch(() => {});
  const peer = send(chat('cold-survivor'));
  await waitUntil(async () => { const s = await transport.diagnostics(); return s.pending > 0 && s.active === 2; }, 'Cold requests did not share initialization');
  assert.equal(profile.requests.length, 0);
  cancelled.abort(); await rejected; await profile.releaseBootstrap();
  assert.equal((await (await peer).json()).choices[0].message.content, 'cold-survivor');
  await idle(); assert.equal(profile.requests.length, 1);
  assert.equal((await transport.diagnostics()).bootstraps, 1);
  await profile.holdBootstrap();
  const controllers = [new AbortController(), new AbortController()];
  const abandoned = controllers.map((c, i) => send({ ...chat('cold-all-' + i), model: 'api-model' }, c.signal));
  const abandonedChecks = abandoned.map(task => assert.rejects(task)); abandonedChecks.forEach(task => void task.catch(() => {}));
  await waitUntil(async () => { const s = await transport.diagnostics(); return s.pending > 0 && s.active === 2; }, 'Second cold model did not start initialization');
  controllers.forEach(c => c.abort()); await Promise.all(abandonedChecks); await profile.releaseBootstrap(); await idle();
  assert.equal(profile.requests.length, 1, 'Abandoned bootstrap must not send an inference');
  assert.equal((await (await send({ ...chat('after-cold-cancel'), model: 'api-model' })).json()).choices[0].message.content, 'after-cold-cancel');
  await idle(); assert.equal((await transport.diagnostics()).bootstraps, 2);
  await profile.holdBootstrap(); transport.config.firstOutputTimeoutMs = 120;
  const body = { model: 'response-model', input: 'caller history', metadata: { user_id: 'cold-timeout' } };
  try {
    const timed = await send(body, undefined, '/responses'); assert.equal(timed.status, 504); await timed.json();
    assert.equal(profile.requests.length, 2, 'Timeout before capture must not initiate inference');
  } finally { transport.config.firstOutputTimeoutMs = 20000; await profile.releaseBootstrap(); }
  await idle();
  assert.equal((await (await send(body, undefined, '/responses')).json()).choices[0].message.content, 'cold-timeout');
  await idle(); const final = await transport.diagnostics();
  assert.equal(final.bootstraps, 3); assert.equal(final.starts, 1); assert.equal(final.sessions, 0); assert.equal(profile.requests.length, 3);
});
