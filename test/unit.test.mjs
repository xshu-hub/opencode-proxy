import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { validateRequest, toNativeHistory, nativeToolName, usageOf, sseEvents } from '../lib/protocol.mjs';
import { OpenCodeBridge, normalizeConfig } from '../lib/bridge.mjs';
const models = { test: { output: 100 } };
const base = () => ({ model: 'test', messages: [{ role: 'user', content: 'Hello' }] });

test('reasoning_effort accepts API levels and rejects invalid values before inference', () => {
  for (const reasoning_effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) assert.equal(validateRequest({ ...base(), reasoning_effort }, models).reasoning_effort, reasoning_effort);
  for (const reasoning_effort of ['', 'HIGH', 'thinking', null, 0, {}, []]) assert.throws(() => validateRequest({ ...base(), reasoning_effort }, models), error => error.status === 400 && error.param === 'reasoning_effort');
});

test('workingDirectory resolves relative to the config file and rejects invalid path values', () => {
  const directory = path.resolve('fixture-config');
  const relative = 'workspace 中文 with spaces';
  assert.equal(normalizeConfig({ mode: 'global', workingDirectory: relative }, directory).workingDirectory, path.join(directory, relative));
  const absolute = path.resolve(relative);
  assert.equal(normalizeConfig({ mode: 'global', workingDirectory: absolute }, directory).workingDirectory, absolute);
  assert.equal(normalizeConfig({ mode: 'global' }, directory).workingDirectory, undefined);
  for (const workingDirectory of ['', '   ', '\0', null, false, 42, [], {}]) assert.throws(() => normalizeConfig({ mode: 'global', workingDirectory }, directory), /workingDirectory/);
});

test('missing directories and file paths fail before OpenCode starts and cleanup preserves user files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-directory-test-'));
  const sentinel = path.join(directory, 'keep.txt');
  await writeFile(sentinel, 'user-owned');
  try {
    for (const workingDirectory of [path.join(directory, 'missing'), sentinel]) {
      let temporary;
      const bridge = new OpenCodeBridge({ mode: 'global', discoverModels: false, workingDirectory, command: [path.join(directory, 'missing-opencode.exe')], onFailure: async ({ home }) => { temporary = home; } });
      const response = await bridge.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'oc-default', messages: [{ role: 'user', content: 'Hello' }] }) });
      const result = await response.json();
      assert.equal(response.status, 503);
      assert.equal(result.error.code, 'opencode_working_directory', JSON.stringify(result));
      assert.equal(result.error.param, 'workingDirectory');
      assert.ok(result.error.message.includes(workingDirectory));
      assert.equal(bridge.active, 0);
      assert.equal(await readFile(sentinel, 'utf8'), 'user-owned');
      await assert.rejects(() => stat(temporary), { code: 'ENOENT' });
      const catalog = new OpenCodeBridge({ mode: 'global', workingDirectory, command: [path.join(directory, 'missing-opencode.exe')] });
      const listing = await catalog.fetch('http://bridge/v1/models');
      assert.equal(listing.status, 503);
      assert.equal((await listing.json()).error.code, 'opencode_working_directory');
      assert.equal(await readFile(sentinel, 'utf8'), 'user-owned');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('global mode needs no supplier configuration or upstream key and defaults to unlimited concurrency', () => {
  const config = normalizeConfig({ mode: 'global' });
  assert.deepEqual(config.command, ['opencode']);
  assert.equal(config.maxConcurrent, 0);
  assert.equal(normalizeConfig({ mode: 'global', maxConcurrent: 0 }).maxConcurrent, 0);
  assert.equal(normalizeConfig({ mode: 'global', maxConcurrent: 4 }).maxConcurrent, 4);
  for (const maxConcurrent of [-1, 1.5, '4', Infinity]) assert.throws(() => normalizeConfig({ mode: 'global', maxConcurrent }), /maxConcurrent/);
  assert.equal(config.discoverModels, true);
  assert.equal(normalizeConfig({ mode: 'global', models: { selected: { model: 'provider/model', context: 1, output: 1 } } }).discoverModels, false);
  assert.throws(() => normalizeConfig({ mode: 'global', discoverModels: 'yes' }), /discoverModels/);
  assert.deepEqual(Object.keys(config.models), ['oc-default']);
  assert.equal(config.models['oc-default'].model, undefined);
  assert.throws(() => normalizeConfig({ mode: 'global', models: { test: { baseURL: 'https://api.example/v1', context: 1, output: 1 } } }), /credentials/);
  assert.throws(() => normalizeConfig({ mode: 'global', models: { test: { model: 'missing-provider', context: 1, output: 1 } } }), /provider\/model/);
});
test('reject unsupported API semantics before inference', () => {
  for (const extra of [{ n: 2 }, { response_format: { type: 'json_object' } }, { tool_choice: 'required' }, { parallel_tool_calls: false }, { max_tokens: 101 }, { stop: ['x'] }, { stream: 'yes' }, { temperature: -1 }]) assert.throws(() => validateRequest({ ...base(), ...extra }, models));
  assert.throws(() => validateRequest({ ...base(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image' } }] }] }, models));
  assert.throws(() => validateRequest({ ...base(), tools: [{ type: 'function', function: { name: 'x', strict: true } }] }, models));
  assert.throws(() => validateRequest({ ...base(), model: '__proto__' }, models));
  assert.equal(validateRequest({ ...base(), temperature: 0, max_tokens: 100, tools: [], tool_choice: 'none' }, models).temperature, 0);
});
test('preserve role history and associate reversed parallel tool results by id', () => {
  const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{"city":"北京"}' } });
  const request = { model: 'test', messages: [{ role: 'system', content: 'Only answer in Chinese.' }, { role: 'user', content: 'Weather?' }, { role: 'assistant', content: 'Checking.', tool_calls: [call('a', 'weather'), call('b', 'time')] }, { role: 'tool', tool_call_id: 'b', content: '10:00' }, { role: 'tool', tool_call_id: 'a', content: 'Sunny' }] };
  validateRequest(request, models);
  const history = toNativeHistory(request, 'ses_test', 'upstream-model', '/sandbox');
  assert.deepEqual(history.system, ['Only answer in Chinese.']);
  assert.deepEqual(history.messages.map(m => m.info.role), ['user', 'assistant']);
  const tools = history.messages[1].parts.filter(p => p.type === 'tool');
  assert.equal(tools[0].tool, nativeToolName('weather'));
  assert.equal(tools[0].state.output, 'Sunny');
  assert.equal(tools[1].state.output, '10:00');
  assert.equal(tools[0].state.input.city, '北京');
  assert.throws(() => validateRequest({ ...request, messages: request.messages.slice(0, -1) }, models));
  assert.throws(() => validateRequest({ ...request, messages: [...request.messages, request.messages.at(-1)] }, models));
});
test('cache and reasoning tokens map to OpenAI totals', () => {
  assert.deepEqual(usageOf({ input: 10, output: 3, reasoning: 2, cache: { read: 7, write: 5 } }), { prompt_tokens: 22, completion_tokens: 5, total_tokens: 27, prompt_tokens_details: { cached_tokens: 7 }, completion_tokens_details: { reasoning_tokens: 2 } });
});
test('Cherry Studio assistant reasoning_content is valid history, with reasoning kept separate from visible text', () => {
  for (const reasoning of ['', null, 'PRIOR_REASONING_SENTINEL']) {
    const body = { model: 'test', messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Previous answer', reasoning_content: reasoning },
      { role: 'user', content: 'Continue' },
    ] };
    assert.equal(validateRequest(body, models), body);
    const history = toNativeHistory(body, 'ses_test', 'mock', '/sandbox');
    const parts = history.messages[1].parts;
    assert.deepEqual(parts.filter(p => p.type === 'text').map(p => p.text), ['Previous answer']);
    assert.deepEqual(parts.filter(p => p.type === 'reasoning').map(p => p.text), reasoning ? [reasoning] : []);
  }
  for (const reasoning_content of [0, [], {}]) {
    const body = { model: 'test', messages: [{ role: 'assistant', content: 'Answer', reasoning_content }, { role: 'user', content: 'Continue' }] };
    assert.throws(() => validateRequest(body, models), error => error.status === 400 && error.param === 'messages[0].reasoning_content');
  }
  assert.throws(() => validateRequest({ ...base(), messages: [{ role: 'user', content: 'Hello', reasoning_content: '' }] }, models), error => error.status === 400 && error.param === 'messages[0].reasoning_content');
  assert.throws(() => validateRequest({ ...base(), messages: [{ role: 'user', content: 'Hello', unexpected_extension: '' }] }, models), error => error.status === 400 && error.param === 'messages[0].unexpected_extension' && error.message.includes('unexpected_extension'));
});
test('SSE survives every UTF-8/CRLF split and rejects incomplete tails', async () => {
  const bytes = Buffer.from('data: {"text":"你好"}\r\n\r\ndata: {"text":"ok"}\n\n');
  async function* input() { for (const b of bytes) yield Buffer.from([b]); }
  assert.deepEqual(await Array.fromAsync(sseEvents(input())), [{ text: '你好' }, { text: 'ok' }]);
  async function* cut() { yield Buffer.from('data: {"text":'); }
  await assert.rejects(async () => { for await (const _ of sseEvents(cut())) {} }, /mid-frame/);
});
