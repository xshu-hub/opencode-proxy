import { test, after } from 'node:test';
import {toolCalls} from './tool-deltas.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, readdir, cp, rm, symlink, stat, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeBridge } from '../lib/bridge.mjs';
import { ProxyRuntime } from '../lib/runtime.mjs';
import { nativeToolName, sseEvents } from '../lib/protocol.mjs';
import {toChatRequest} from '../lib/outward-protocols.mjs';
import { normalizeConfig } from '../lib/bridge.mjs';
import { createProxyServer } from '../lib/http-server.mjs';
import { spawn } from 'node:child_process';

if (!process.env.TEST_OPENCODE_COMMAND) throw new Error('Set TEST_OPENCODE_COMMAND for the real OpenCode global-state test.');
const command = JSON.parse(process.env.TEST_OPENCODE_COMMAND);
const home = await mkdtemp(path.join(os.tmpdir(), 'opencode-global-fixture-'));
const saved = { ...process.env };
const data = path.join(home, 'data', 'opencode');
const configDir = path.join(home, 'config', 'opencode');
const authFile = path.join(data, 'auth.json');
const observationsFile = path.join(home, 'worker-directories.jsonl');
const workingDirectory = path.join(home, 'workspace 中文 with spaces');
const observations = async () => {
  const raw=await readFile(observationsFile,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  return raw.trim().split('\n').filter(Boolean).map(JSON.parse);
};
const requests = [];
const advancedTools=[{type:'namespace',name:'crm',tools:[{type:'function',name:'lookup',parameters:{type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}}]},{type:'custom',name:'run_code',format:{type:'text'}}];
const advancedNames=toChatRequest('responses',{input:'hello',tools:advancedTools}).tools.map(t=>t.function.name);
const faultAttempts=new Map();
const dsmlCode='const g1 = await tools.grep({ pattern: "SessionRetry|Retry\\.policy|retryable\\(", path: "packages/opencode/src", include: "*.ts" })\nconsole.log(g1.matches.map(m=>m.path+":"+m.lineNumber+": "+m.line).join("\\n"))';
const dsmlPreface="I'll start by exploring the directory to understand what rule set files we're working with.\n\n";
const dsmlShellCommand=
  String.raw`Get-ChildItem -LiteralPath 'D:\f30079819\Downloads\规则集' -Recurse | Select-Object FullName, Length, Extension` +
  ' | Format-Table -AutoSize';
let refreshes = 0;
let parallelRequests;
let pausedStream;
let auditStream;
let instructionFetches = 0;
let skillFetches = 0;
const upstream = http.createServer(async (req, res) => {
  if (req.url === '/audit-instructions') { instructionFetches++; res.end('REMOTE_INSTRUCTION_SENTINEL'); return; }
  if (req.url === '/audit-skills/index.json') { skillFetches++; res.setHeader('content-type', 'application/json'); res.end('{"skills":[]}'); return; }
  if (req.url === '/refresh') {
    refreshes++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access: 'fixture-refreshed-access', refresh: 'fixture-refreshed-refresh', expires: Date.now() + 3600000 }));
    return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ auth: req.headers.authorization, body, url: req.url, apiKey: req.headers['x-api-key'] });
  const fault=body.messages.find(m=>typeof m.content==='string'&&m.content.startsWith('GLOBAL_FAULT_'))?.content;
  if(fault){const attempt=(faultAttempts.get(fault)??0)+1;faultAttempts.set(fault,attempt);
    // Leave time for the public native retry event to reach the proxy before
    // another attempt. A zero-delay fixture races the event transport itself.
    if((fault.startsWith('GLOBAL_FAULT_RATE_LIMIT')&&attempt<3)||fault.startsWith('GLOBAL_FAULT_PERMANENT_LIMIT')){res.writeHead(429,{'content-type':'application/json','retry-after':'1'});res.end(JSON.stringify({error:{message:'Too Many Requests: fixture rate limit',type:'rate_limit_error'}}));return;}
    if(fault==='GLOBAL_FAULT_NETWORK'&&attempt===1){req.socket.destroy();return;}
    if(fault==='GLOBAL_FAULT_PARTIAL'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'partial',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{content:'PARTIAL_BEFORE_DISCONNECT'},finish_reason:null}]})+'\n\n');setTimeout(()=>res.destroy(),200);return;}
  }
  if (req.url === '/anthropic/messages') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Native reasoning variant applied.' } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    event('message_stop', {});
    res.end(); return;
  }
  if (body.messages.some(m => m.role === 'user' && m.content === 'EARLY_UPSTREAM_REJECTION')) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Fixture provider rejected this request.', type: 'permission_error' } }));
    return;
  }
  if (body.messages.some(m => ['TIMEOUT_FIRST', 'TIMEOUT_IDLE'].includes(m.content))) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (body.messages.some(m => m.content === 'TIMEOUT_IDLE')) res.write('data: ' + JSON.stringify({id:'timing',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{content:'Before idle.'},finish_reason:null}]}) + '\n\n');
    const timer = setInterval(() => res.write(': upstream-heartbeat\n\n'), 40);
    res.once('close', () => clearInterval(timer));
    return;
  }
  const marker = body.messages.find(m => m.role === 'user' && typeof m.content === 'string' && parallelRequests?.has(m.content))?.content;
  if (marker) {
    const pending = parallelRequests.get(marker);
    pending.started.resolve();
    await pending.release.promise;
    if (res.destroyed) return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: reason }], ...(usage ? { usage } : {}) })}\n\n`);
  if(body.messages.some(m=>m.content==='GLOBAL_ADVANCED_TOOLS')){
    if(body.messages.some(m=>m.role==='tool'))emit({content:'ADVANCED_OK'});
    else for(const [index,name] of advancedNames.entries())emit({tool_calls:[{index,id:'advanced_'+index,type:'function',function:{name:nativeToolName(name),arguments:JSON.stringify(index===0?{city:'北京'}:{input:'print("北京🙂")\n'})}}]});
    emit({},body.messages.some(m=>m.role==='tool')?'stop':'tool_calls',{prompt_tokens:10,completion_tokens:20,total_tokens:30});
  } else if (
    body.messages.some((m) => ['GLOBAL_DSML_RECOVERY', 'GLOBAL_DSML_PREFIX_RECOVERY'].includes(m.content)) &&
    !body.messages.some((m) => m.role === 'tool')
  ) {
    const tool = body.tools.find((t) => t.function.name === nativeToolName('run_code'));
    const prefixed = body.messages.some((m) => m.content === 'GLOBAL_DSML_PREFIX_RECOVERY');
    const shell = prefixed
      ? '<｜｜DSML｜｜ invoke name="pwsh"><｜｜DSML｜｜ parameter name="command" string="true">' +
        dsmlShellCommand +
        '</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="description" string="true">List files in the rule set directory</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>'
      : '';
    const text =
      (prefixed ? dsmlPreface : '') +
      '<｜｜DSML｜｜ calls>' +
      shell +
      ' <｜｜DSML｜｜ invoke name="' +
      tool.function.name +
      '"> <｜｜DSML｜｜ parameter name="code" string="true">' +
      dsmlCode +
      '</｜｜DSML｜｜ parameter> <｜｜DSML｜｜ parameter name="description" string="true">Find retry policy usage sites' +
      '</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>';
    for (let i = 0; i < text.length; i += 17) {
      emit({ content: text.slice(i, i + 17) });
      await delay(2);
    }
    emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 });
  }else if(body.tools?.some(t=>['StructuredOutput','bridge_structured_output'].includes(t.function.name))){
    const forced=body.messages.some(m=>m.content==='GLOBAL_NATIVE_FORCE');
    emit({tool_calls:[{index:0,id:'structured-native',type:'function',function:{name:body.tools.find(t=>['StructuredOutput','bridge_structured_output'].includes(t.function.name)).function.name,arguments:JSON.stringify(forced?{calls:[{name:'weather',arguments:{city:'北京'}}]}:{answer:42})}}]});
    emit({},'tool_calls',{prompt_tokens:10,completion_tokens:5,total_tokens:15});
  } else if (body.messages.some(m => m.content === 'AUDIT_INCREMENTAL')) {
    for (const text of ['思', '考', '。']) { emit({ reasoning_content: text }); await delay(30); }
    for (const text of ['你好', '🙂', '\n\n```python\n']) { emit({ content: text }); await delay(30); }
    auditStream.started.resolve();
    await auditStream.release.promise;
    if (res.destroyed) return;
    for (const text of auditStream.tail) { emit({ content: text }); await delay(5); }
    emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  } else if (body.messages.some(m => m.role === 'user' && m.content === 'AUDIT_LOCAL_TOOL')) {
    emit({tool_calls:[{index:0,id:'audit_local',type:'function',function:{name:'bridge_audit_local',arguments:'{}'}}]});
    emit({},'tool_calls',{prompt_tokens:10,completion_tokens:5,total_tokens:15});
  } else if (body.messages.some(m => m.role === 'user' && ['AUDIT_FILTER', 'AUDIT_FILTER_TEXT'].includes(m.content))) {
    if (body.messages.some(m => m.content === 'AUDIT_FILTER_TEXT')) emit({ content: 'Before filtering.' });
    emit({},'content_filter',{prompt_tokens:10,completion_tokens:0,total_tokens:10});
  } else if (body.messages.some(m => m.role === 'user' && m.content === 'GLOBAL_THINKING_CLIENT')) {
    emit({reasoning_content:'原生思考🙂\n'});await delay(20);emit({reasoning_content:'检查工具结果。'});
    if(!body.messages.some(m=>m.role==='tool'))emit({tool_calls:[{index:0,id:'thinking_call',type:'function',function:{name:nativeToolName('weather'),arguments:'{"city":"北京"}'}}]});
    else emit({content:'收到工具结果。'});
    emit({},body.messages.some(m=>m.role==='tool')?'stop':'tool_calls',{prompt_tokens:100,completion_tokens:30,total_tokens:130,completion_tokens_details:{reasoning_tokens:10}});
  } else if (body.messages.some(m => m.role === 'user' && m.content === 'AUDIT_REASONING')) {
    emit({role:'assistant',reasoning_content:'思考中。'});
    emit({content:'结论。'});
    emit({},'stop',{prompt_tokens:100,completion_tokens:30,total_tokens:130,prompt_tokens_details:{cached_tokens:20},completion_tokens_details:{reasoning_tokens:10}});
  } else if (body.tools?.length && !body.messages.some(m => m.role === 'tool')) {
    for (const [i, name] of ['weather', 'clock'].entries()) emit({ tool_calls: [{ index: i, id: 'call_' + name, type: 'function', function: { name: nativeToolName(name), arguments: '{"city":"北京"}' } }] });
    emit({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  } else if (body.messages.some(m => m.role === 'user' && m.content === 'HOLD_AFTER_FIRST_OUTPUT')) {
    emit({ role: 'assistant', content: 'First streamed text.' });
    pausedStream.started.resolve();
    await pausedStream.release.promise;
    if (res.destroyed) return;
    pausedStream.finished = true;
    emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  } else if (marker) {
    emit({ role: 'assistant', content: marker });
    emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  } else {
    emit({ role: 'assistant', content: '复用' }); emit({ content: '全局 OpenCode 登录。' });
    emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  }
  res.end('data: [DONE]\n\n');
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${upstream.address().port}`;
after(async () => {
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
  Object.assign(process.env, saved);
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
await mkdir(data, { recursive: true });
await mkdir(configDir, { recursive: true });
await mkdir(workingDirectory);
await writeFile(path.join(workingDirectory, 'keep.txt'), 'user-owned workspace');
const projectConfig = '{"model":"project-must-not-load/missing"}';
await writeFile(path.join(workingDirectory, 'opencode.json'), projectConfig);
// Seed only the fixture's global SDK installation. Real user files are untouched.
const sdk = process.env.TEST_OPENCODE_PLUGIN_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@opencode-ai/plugin'))), '..');
const manifest = JSON.parse(await readFile(path.join(sdk, 'package.json'), 'utf8'));
await cp(sdk, path.join(configDir, 'node_modules', '@opencode-ai', 'plugin'), { recursive: true });
await writeFile(path.join(configDir, 'package.json'), JSON.stringify({ private: true, dependencies: { '@opencode-ai/plugin': manifest.version } }));
await writeFile(path.join(configDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { '@opencode-ai/plugin': manifest.version } }, 'node_modules/@opencode-ai/plugin': { version: manifest.version } } }));
const loginPlugin = path.join(configDir, 'fixture-auth.mjs');
await writeFile(loginPlugin, `import { appendFile } from 'node:fs/promises';
export const FixtureAuth = async ({ client, directory }) => {
  await appendFile(${JSON.stringify(observationsFile)}, JSON.stringify({ cwd: process.cwd(), directory, db: process.env.OPENCODE_DB, pid: process.pid }) + '\\n');
  return {
  auth: { provider: 'fixture-oauth', methods: [], loader: async getAuth => ({
    apiKey: 'fixture-sdk-placeholder',
    fetch: async (url, init) => {
      let auth = await getAuth();
      if (auth.expires < Date.now()) {
        const fresh = await fetch(${JSON.stringify(baseURL + '/refresh')}, { method: 'POST' }).then(r => r.json());
        auth = { type: 'oauth', ...fresh };
        await client.auth.set({ path: { id: 'fixture-oauth' }, body: auth });
      }
      const headers = new Headers(init.headers);
      headers.set('authorization', 'Bearer ' + auth.access);
      return fetch(url, { ...init, headers });
    }
  }) }
  };
};\n`);
const globalConfig = {
  $schema: 'https://opencode.ai/config.json',
  model: 'fixture-oauth/mock',
  plugin: [pathToFileURL(loginPlugin).href],
  provider: {
    'fixture-oauth': { npm: '@ai-sdk/openai-compatible', options: { baseURL: baseURL + '/v1' }, models: { mock: { name: 'Subscription fixture', temperature: true, limit: { context: 100000, output: 1000 } } } },
    'fixture-api': { npm: '@ai-sdk/openai-compatible', options: { baseURL: baseURL + '/v1' }, models: {
      mock: { name: 'Saved key fixture', attachment:true,modalities:{input:['text','image','pdf'],output:['text']},limit: { context: 100000, output: 1000 } },
      'text-only': { temperature: false, tool_call: false, limit: { context: 100000, output: 1000 } },
      'DeepSeek-V4.1-Flash-line2-maas': { name: 'DeepSeek-V4.1-Flash-line2-maas', reasoning: false, options: { reasoningEffort: 'xhigh' }, limit: { context: 100000, output: 1000 } },
      'native-variants': { reasoning: true, options: { reasoningEffort: 'xhigh', fixture_nested: { keep: 'base', choose: 'base' } }, variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high', fixture_nested: { choose: 'native-high' } }, max: { reasoningEffort: 'max' }, private: { privateVariantToken: 'must-not-enter-metadata' } }, limit: { context: 100000, output: 1000 } },
      'thinking-toggle': { reasoning: true, options: { reasoningEffort: 'none' }, variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } }, limit: { context: 100000, output: 4096 } },
    } },
    'fixture-anthropic': { npm: '@ai-sdk/anthropic', options: { baseURL: baseURL + '/anthropic' }, models: {
      'native-thinking': { reasoning: true, variants: { high: { thinking: { type: 'enabled', budgetTokens: 1024 } } }, limit: { context: 100000, output: 4096 } },
      'no-reasoning': { reasoning: false, limit: { context: 100000, output: 4096 } },
    } },
  },
  // These would be dangerous for the API worker if inherited without restrictions.
  permission: { '*': 'allow' },
  mcp: { unused: { type: 'remote', url: 'http://127.0.0.1:1', enabled: false } },
};
const originalConfig = JSON.stringify(globalConfig);
await writeFile(path.join(configDir, 'opencode.json'), originalConfig);
await writeFile(authFile, JSON.stringify({
  'fixture-oauth': { type: 'oauth', access: 'fixture-expired-access', refresh: 'fixture-refresh', expires: 0 },
  'fixture-api': { type: 'api', key: 'fixture-saved-api-key' },
  'fixture-anthropic': { type: 'api', key: 'fixture-native-api-key' },
  untouched: { type: 'api', key: 'fixture-unrelated-key' },
}));
Object.assign(process.env, {
  HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
  XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
  OPENCODE_DISABLE_MODELS_FETCH: '1',
});
for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_AUTH_CONTENT']) delete process.env[key];
let fixtureCommand = command;
if (command.length === 1) {
  const bin = path.join(home, 'global-bin');
  await mkdir(bin);
  if (process.platform === 'win32') {
    const root = path.resolve(path.dirname(command[0]), '..');
    const pkg = await readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse, () => undefined);
    if (pkg?.name === 'opencode-ai') {
      const shimPackage = path.join(bin, 'node_modules', '@opencode', 'opencode-ai');
      await mkdir(shimPackage, { recursive: true });
      await symlink(path.dirname(command[0]), path.join(shimPackage, 'bin'), 'junction');
      // PowerShell-created global manifests may contain a UTF-8 BOM. Follow the
      // package's declared bin without requiring a filename or runtime version.
      await writeFile(path.join(shimPackage, 'package.json'), '\ufeff' + JSON.stringify({ name: '@opencode/opencode-ai', version: 'unlisted', bin: { opencode: './bin/' + path.basename(command[0]) } }));
      await writeFile(path.join(bin, 'opencode.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@opencode\\opencode-ai\\bin\\' + path.basename(command[0]) + '"   %*\r\n');
      fixtureCommand = undefined;
    } else {
      await symlink(command[0], path.join(bin, 'opencode.exe'));
      fixtureCommand = undefined;
    }
  } else {
    await symlink(command[0], path.join(bin, 'opencode'));
    fixtureCommand = undefined;
  }
  process.env.PATH = bin + path.delimiter + (process.env.PATH ?? process.env.Path ?? '');
}
const options = { workerReuse: false, diagnostics: false, mode: 'global', ...(fixtureCommand ? { command: fixtureCommand } : {}), timeoutMs: 45000, startupTimeoutMs: 20000, models: { 'oc-default': { context: 100000, output: 1000 } } };
options.onFailure = async ({ phase, output, events }) => {
  console.log('Global OpenCode fixture phase:', phase, 'output:', output, 'events:', events);
  const dir = path.join(data, 'log');
  for (const name of await readdir(dir).catch(() => [])) console.log('Fixture OpenCode log:', (await readFile(path.join(dir, name), 'utf8')).slice(-18000));
};
const bridge = new OpenCodeBridge(options);
const request = (body, instance = bridge) => instance.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'oc-default', ...body }) }, 'not-the-upstream-key');

test('real global v1 loads its configured OAuth plugin, refreshes its own login and uses its default model', { timeout: 60000 }, async () => {
  const fetchOriginal = globalThis.fetch;
  let subscriptions = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/global/health')) {
      const response = await fetchOriginal(url, init);
      if (!response.ok) return response;
      return Response.json({ ...await response.json(), version: 'unlisted-test-build' });
    }
    if (String(url).endsWith('/event') && subscriptions++ === 0) {
      assert.equal(requests.length, 0, 'No inference until the event subscription works');
      return new Response('', { headers: { 'content-type': 'text/event-stream' } });
    }
    return fetchOriginal(url, init);
  };
  let response, chunks;
  try {
    response = await request({ messages: [{ role: 'system', content: 'Global system' }, { role: 'user', content: 'Hello' }], stream: true });
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    chunks = await Array.fromAsync(sseEvents(response.body));
  } finally { globalThis.fetch = fetchOriginal; }
  assert.ok(subscriptions >= 2, 'An empty event response is retried before inference');
  assert.equal(response.status, 200, JSON.stringify(chunks));
  assert.equal(response.headers.get('x-opencode-version'), 'unlisted-test-build', 'An unknown reported version must not prevent inference');
  assert.equal(chunks.some(c => c.error), false, JSON.stringify(chunks));
  assert.equal(chunks.map(c => c.choices[0]?.delta.content ?? '').join(''), '复用全局 OpenCode 登录。');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].auth, 'Bearer fixture-refreshed-access');
  assert.equal(requests[0].body.model, 'mock');
  assert.equal(refreshes, 1);
  const auth = JSON.parse(await readFile(authFile, 'utf8'));
  assert.equal(auth['fixture-oauth'].refresh, 'fixture-refreshed-refresh');
  assert.equal(auth.untouched.key, 'fixture-unrelated-key');
  assert.equal(await readFile(path.join(configDir, 'opencode.json'), 'utf8'), originalConfig);
  assert.equal((await readdir(data)).some(n => n.endsWith('.sqlite')), false, 'API sessions use a temporary database');
  const worker = (await observations()).at(-1);
  assert.equal(path.basename(worker.cwd), 'workspace');
  assert.match(path.basename(path.dirname(worker.cwd)), /^opencode-proxy-/);
  await bridge.drain();
  await assert.rejects(() => stat(worker.cwd), { code: 'ENOENT' }, 'Default workspaces are cleaned after inference');
});

test('standalone HTTP service uses global login and the chosen directory without loading project config or deleting files', { timeout: 60000 }, async t => {
  const file = path.join(home, 'custom-bridge.json');
  await writeFile(file, JSON.stringify({ ...options, workingDirectory: './' + path.basename(workingDirectory), models: undefined, onFailure: undefined }));
  const proxy = new OpenCodeBridge(normalizeConfig(JSON.parse(await readFile(file,'utf8')),path.dirname(file)));
  const before = requests.length;
  assert.ok((await proxy.loadModels())['fixture-oauth/mock']);
  assert.equal(requests.length, before, 'Discovery must not infer');
  const discovered = (await observations()).at(-1);
  assert.equal(await realpath(discovered.cwd), await realpath(workingDirectory));
  assert.equal(await realpath(discovered.directory), await realpath(workingDirectory));
  assert.match(path.basename(path.dirname(discovered.db)), /^opencode-proxy-models-/);
  await assert.rejects(() => stat(discovered.db), { code: 'ENOENT' });
  const server=createProxyServer({bridge:proxy,apiKey:'fixture-client-key'});
  t.after(()=>server.shutdown());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer fixture-client-key'},body:JSON.stringify({model:'fixture-oauth/mock',messages:[{role:'user',content:'Hello'}],stream:true})});
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
  const chunks = await Array.fromAsync(sseEvents(response.body));
  assert.equal(chunks.map(c => c.choices[0]?.delta.content ?? '').join(''), '复用全局 OpenCode 登录。');
  assert.equal(requests.length, before + 1);
  const inferred = (await observations()).at(-1);
  assert.equal(await realpath(inferred.cwd), await realpath(workingDirectory));
  assert.equal(await realpath(inferred.directory), await realpath(workingDirectory));
  assert.notEqual(inferred.db, discovered.db);
  await proxy.drain();
  await assert.rejects(() => stat(inferred.db), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(workingDirectory, 'keep.txt'), 'utf8'), 'user-owned workspace');
  assert.equal(await readFile(path.join(workingDirectory, 'opencode.json'), 'utf8'), projectConfig);
});
test('any provider SDK can return complete tool batches without local execution or a second inference', { timeout: 120000 }, async () => {
  const before = requests.length;
  const tools = ['weather', 'clock'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } }));
  const body = { model: 'oc-default', messages: [{ role: 'user', content: 'Call the tools' }], tools, stream: true, stream_options: { include_usage: true } };
  const run = await bridge.prepare(body);
  try {
    const deadline = Date.now() + 10000;
    while (requests.length === before && Date.now() < deadline) await delay(50);
    // Slow event consumption must never allow OpenCode to infer using a deferral acknowledgement.
    await delay(1000);
    assert.equal(requests.length, before + 1);
    assert.deepEqual(requests.at(-1).body.tools.map(t => t.function.name).sort(), ['weather', 'clock'].map(nativeToolName).sort(), 'No global built-in or unrelated MCP tool reaches the model');
    for (const name of ['weather', 'clock']) assert.match(requests.at(-1).body.tools.find(t => t.function.name === nativeToolName(name)).function.description, new RegExp('Client function: ' + name));
    const chunks = await Array.fromAsync(bridge.chunks(body, run, { id: 'test', created: 0, model: 'oc-default' }));
    const calls = toolCalls(chunks);
    assert.deepEqual(calls.map(c => c.function.name), ['weather', 'clock']);
    assert.equal(chunks.find(c => c.choices[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
    assert.equal(requests.length, before + 1);
    assert.equal(chunks.at(-1).usage.total_tokens, 15);
    const response = await request({ messages: [...body.messages, { role: 'assistant', content: null, tool_calls: calls.map(({ index, ...c }) => c) }, { role: 'tool', tool_call_id: 'call_clock', content: '10:00' }, { role: 'tool', tool_call_id: 'call_weather', content: '北京 23C' }], tools });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(requests.at(-1).body.messages.map(m => m.role), ['user', 'assistant', 'tool', 'tool']);
    assert.equal(requests.at(-1).body.messages.at(-1).content, '10:00');
    assert.equal(requests.length, before + 2);
  } finally { await run.cleanup(); }
});
test('explicit model selection still uses the global saved key and ignores a client authentication key', { timeout: 60000 }, async () => {
  const selected = new OpenCodeBridge({ ...options, models: { 'oc-default': { ...options.models['oc-default'], model: 'fixture-api/mock' } } });
  const response = await request({ messages: [{ role: 'user', content: 'Hello' }] }, selected);
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal(requests.at(-1).auth, 'Bearer fixture-saved-api-key');
  assert.equal(refreshes, 1, 'Refreshed credentials survive a new worker');
});

test('reasoning_effort on the reported custom DeepSeek name reaches upstream and overrides defaults only when requested', { timeout: 120000 }, async () => {
  const selected = new OpenCodeBridge({ ...options, models: { 'oc-default': { ...options.models['oc-default'], model: 'fixture-api/DeepSeek-V4.1-Flash-line2-maas' } } });
  for (const reasoning_effort of ['high', 'low', 'none', 'max', undefined]) {
    const before = requests.length;
    const response = await request({ messages: [{ role: 'user', content: 'Hello' }], ...(reasoning_effort === undefined ? {} : { reasoning_effort }), stream: reasoning_effort === 'high' }, selected);
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    if (reasoning_effort === 'high') await Array.fromAsync(sseEvents(response.body));
    else assert.equal((await response.json()).choices[0].finish_reason, 'stop');
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).body.model, 'DeepSeek-V4.1-Flash-line2-maas');
    assert.equal(requests.at(-1).body.reasoning_effort, reasoning_effort ?? 'xhigh');
  }
});

test('native OpenCode variants are applied and only public reasoning metadata is advertised', { timeout: 60000 }, async () => {
  const discovered = new OpenCodeBridge({ ...options, discoverModels: true });
  await discovered.loadModels();
  const model = discovered.config.models['native-variants'];
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.reasoningEfforts.sort(), ['high', 'low', 'max', 'medium']);
  assert.equal(JSON.stringify(discovered.config.models).includes('must-not-enter-metadata'), false);
  const response = await discovered.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'fixture-api/native-variants', reasoning_effort: 'high', messages: [{ role: 'user', content: 'Hello' }] }) });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal(requests.at(-1).body.reasoning_effort, 'high');
  assert.deepEqual(requests.at(-1).body.fixture_nested, { keep: 'base', choose: 'native-high' });

});

test('native SDK reasoning uses OpenCode thinking options and unmappable requests return 400 before inference', { timeout: 60000 }, async () => {
  const selected = new OpenCodeBridge({ ...options, onFailure: undefined, models: {
    'native-thinking': { model: 'fixture-anthropic/native-thinking', context: 100000, output: 4096 },
    'no-reasoning': { model: 'fixture-anthropic/no-reasoning', context: 100000, output: 4096 },
  } });
  const send = model => selected.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model, reasoning_effort: 'high', messages: [{ role: 'user', content: 'Hello' }], stream: true }) });
  const response = await send('native-thinking');
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
  const chunks = await Array.fromAsync(sseEvents(response.body));
  assert.equal(chunks.map(c => c.choices[0]?.delta.content ?? '').join(''), 'Native reasoning variant applied.');
  assert.deepEqual(requests.at(-1).body.thinking, { type: 'enabled', budget_tokens: 1024 });
  assert.equal(requests.at(-1).body.reasoning_effort, undefined, 'Native Anthropic must not receive an OpenAI field');
  assert.equal(requests.at(-1).apiKey, 'fixture-native-api-key');
  selected.acceptedModels['native-thinking'].reasoningVariants={high:{thinking:{type:'enabled',budgetTokens:2048}}};
  const custom=await send('native-thinking');assert.equal(custom.status,200,custom.status===200?'':await custom.text());await Array.fromAsync(sseEvents(custom.body));
  assert.deepEqual(requests.at(-1).body.thinking,{type:'enabled',budget_tokens:2048});
  const before = requests.length;
  const rejected = await send('no-reasoning');
  const error = (await rejected.json()).error;
  assert.equal(rejected.status, 400, JSON.stringify(error));
  assert.equal(error.param, 'reasoning_effort');
  assert.equal(error.code, 'unsupported_reasoning_effort');
  assert.equal(requests.length, before, 'An unmappable request must not infer with its effort silently ignored');
  assert.equal(selected.active, 0);
});

test('upstream rejection before any output returns an HTTP error instead of a successful empty SSE stream', { timeout: 60000 }, async () => {
  const before = requests.length;
  const instance = new OpenCodeBridge({ ...options, onFailure: undefined });
  const response = await request({ messages: [{ role: 'user', content: 'EARLY_UPSTREAM_REJECTION' }], stream: true }, instance);
  const result = await response.json();
  assert.equal(response.status, 403, JSON.stringify(result));
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(result.error.message, 'Fixture provider rejected this request.');
  assert.equal(result.error.code,'upstream_auth_error');
  assert.equal(requests.length, before + 1, 'A provider rejection is not retried as another model call');
  assert.equal(instance.active, 0, 'Rejected requests release their worker');
});

test('successful SSE starts at the first model output without waiting for completion', { timeout: 60000 }, async () => {
  const instance = new OpenCodeBridge({ ...options, onFailure: undefined });
  pausedStream = { started: Promise.withResolvers(), release: Promise.withResolvers(), finished: false };
  let events;
  try {
    const responsePromise = request({ messages: [{ role: 'user', content: 'HOLD_AFTER_FIRST_OUTPUT' }], stream: true, stream_options: { include_usage: true } }, instance);
    await Promise.race([pausedStream.started.promise, delay(15000).then(() => { throw new Error('Upstream did not start'); })]);
    const response = await Promise.race([responsePromise, delay(5000).then(() => { throw new Error('Response buffered until completion'); })]);
    assert.equal(response.status, 200);
    events = sseEvents(response.body);
    assert.equal((await events.next()).value.choices[0].delta.role, 'assistant');
    assert.equal((await events.next()).value.choices[0].delta.content, 'First streamed text.');
    assert.equal(pausedStream.finished, false, 'Text reaches the client while inference is still running');
    pausedStream.release.resolve();
    const rest = await Array.fromAsync(events);
    assert.equal(rest.find(c => c.choices[0]?.finish_reason)?.choices[0].finish_reason, 'stop');
    assert.equal(rest.at(-1).usage.total_tokens, 15);
    assert.equal(instance.active, 0);
  } finally { pausedStream.release.resolve(); await events?.return(); }
});

test('Cherry Studio multi-turn history with empty, null or nonempty reasoning goes through real global OpenCode', { timeout: 120000 }, async () => {
  for (const reasoning_content of ['', null, 'GLOBAL_PRIOR_REASONING_SENTINEL']) {
    const before = requests.length;
    const response = await request({ messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Previous answer', reasoning_content },
      { role: 'user', content: 'Continue' },
    ] });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.choices[0].message.content, '复用全局 OpenCode 登录。');
    assert.equal(requests.length, before + 1);
    const sent = requests.at(-1).body.messages;
    assert.deepEqual(sent.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(sent[1].content, 'Previous answer');
    assert.equal(sent[1].reasoning_content || '', reasoning_content || '');
    assert.equal(sent[2].content, 'Continue');
  }
});

test('global model discovery lists connected providers and calls the selected model without copying credentials', { timeout: 60000 }, async () => {
  const discovered = new OpenCodeBridge({ ...options, discoverModels: true });
  const before = requests.length;
  const listing = await discovered.fetch('http://bridge/v1/models');
  const models = await listing.json();
  assert.equal(listing.status, 200, JSON.stringify(models));
  for (const id of ['oc-default', 'fixture-api/mock', 'fixture-oauth/mock']) assert.ok(models.data.some(m => m.id === id), id + ' must be selectable');
  assert.equal(requests.length, before, 'Listing models must not initiate inference');
  for (const value of Object.values(discovered.config.models)) assert.deepEqual(Object.keys(value).sort().filter(k => ['apiKey', 'baseURL', 'options', 'headers'].includes(k)), []);
  const response = await discovered.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'fixture-api/mock', messages: [{ role: 'user', content: 'Hello' }] }) });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).auth, 'Bearer fixture-saved-api-key');
  assert.equal(requests.at(-1).body.model, 'mock');
});

test('default standalone configuration discovers global OpenCode models', {timeout:60000}, async()=>{
  const proxy = new OpenCodeBridge({...options,models:undefined,discoverModels:true});
  try { const models=await proxy.loadModels(); assert.ok(models['fixture-api/mock']); assert.ok(models['fixture-oauth/mock']); }
  finally { await proxy.close(); }
});

test('global workers share a configured directory while concurrent inference and cancellation remain isolated', { timeout: 90000 }, async () => {
  // The full suite already refreshed this disposable OAuth login in its first
  // test. Establish the same baseline when selecting this test on its own.
  if(refreshes===0){const warmup=await request({messages:[{role:'user',content:'Concurrent fixture login warmup'}]});assert.equal(warmup.status,200);await warmup.json();}
  const instance = new OpenCodeBridge({ ...options, workerReuse: true, workingDirectory, models: {
    ...options.models,
    'saved-api': { model: 'fixture-api/mock', context: 100000, output: 1000 },
  } });
  const labels = ['parallel-cancel', 'parallel-json', 'parallel-stream', 'parallel-oauth'];
  parallelRequests = new Map(labels.map(label => [label, { started: Promise.withResolvers(), release: Promise.withResolvers() }]));
  const controllers = labels.map(() => new AbortController());
  const before = requests.length;
  const beforeWorkers = (await observations()).length;
  const jobs = labels.map(async (label, i) => {
    const body = { model: i % 2 ? 'saved-api' : 'oc-default', messages: [{ role: 'user', content: label }], stream: i % 2 === 0, stream_options: { include_usage: true } };
    const response = await instance.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify(body), signal: controllers[i].signal }, 'not-the-upstream-key');
    if (i === 0 && controllers[0].signal.aborted) {
      assert.equal(response.status, 499, 'Cancellation before first model output is an HTTP error');
      assert.ok((await response.json()).error);
      return { cancelled: true };
    }
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    if (!body.stream) {
      const result = await response.json();
      return { content: result.choices[0].message.content, finish: result.choices[0].finish_reason, usage: result.usage };
    }
    const chunks = await Array.fromAsync(sseEvents(response.body));
    if (i === 0 && controllers[0].signal.aborted) return { cancelled: true };
    assert.equal(chunks.some(c => c.error), false, JSON.stringify(chunks));
    return { content: chunks.map(c => c.choices[0]?.delta.content ?? '').join(''), finish: chunks.find(c => c.choices[0]?.finish_reason)?.choices[0].finish_reason, usage: chunks.at(-1).usage };
  });
  const settled = Promise.allSettled(jobs);
  let deadline;
  try {
    const started = Promise.all([...parallelRequests.values()].map(p => p.started.promise));
    const earlyFailure = Promise.all(jobs).then(() => { throw new Error('Workers completed before all four upstream calls overlapped'); });
    const timedOut = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('All four global workers must reach inference concurrently')), 45000); });
    await Promise.race([started, earlyFailure, timedOut]);
    assert.equal(requests.length, before + 4, 'All four inferences start before any result is released');
    for (const [i, label] of labels.entries()) {
      const upstreamRequest = requests.slice(before).find(r => r.body.messages.some(m => m.content === label));
      assert.ok(upstreamRequest, label);
      assert.equal(upstreamRequest.auth, i % 2 ? 'Bearer fixture-saved-api-key' : 'Bearer fixture-refreshed-access');
    }
    controllers[0].abort();
    await jobs[0];
    for (const label of labels) parallelRequests.get(label).release.resolve();
    const results = await Promise.all(jobs);
    for (let i = 1; i < results.length; i++) {
      assert.equal(results[i].content, labels[i], 'Sessions must not receive another request\'s response');
      assert.equal(results[i].finish, 'stop');
      assert.equal(results[i].usage.total_tokens, 15);
    }
    assert.equal(refreshes, 1, 'Concurrent workers reuse the login already refreshed by OpenCode');
    assert.equal(await readFile(path.join(configDir, 'opencode.json'), 'utf8'), originalConfig);
    const auth = JSON.parse(await readFile(authFile, 'utf8'));
    assert.equal(auth.untouched.key, 'fixture-unrelated-key');
    assert.equal((await readdir(data)).some(n => n.endsWith('.sqlite')), false);
    await instance.close();
    const workers = (await observations()).slice(beforeWorkers);
    assert.equal(new Set(workers.map(w => w.pid)).size, 4, 'All four requests have different OpenCode processes');
    assert.equal(new Set(workers.map(w => w.db)).size, 4, 'Sharing cwd must not share session databases');
    for (const worker of workers) {
      assert.equal(await realpath(worker.cwd), await realpath(workingDirectory));
      assert.equal(await realpath(worker.directory), await realpath(workingDirectory));
      await assert.rejects(() => stat(worker.db), { code: 'ENOENT' });
    }
    assert.equal(await readFile(path.join(workingDirectory, 'keep.txt'), 'utf8'), 'user-owned workspace');
    assert.equal(await readFile(path.join(workingDirectory, 'opencode.json'), 'utf8'), projectConfig);
  } finally {
    clearTimeout(deadline);
    for (const controller of controllers) controller.abort();
    for (const pending of parallelRequests.values()) pending.release.resolve();
    await settled;
    await instance.close();
    parallelRequests = undefined;
  }
});

test('regression: stream reasoning, text and usage with nonzero reasoning/cache totals', { timeout:60000 }, async () => {
  const response=await request({messages:[{role:'user',content:'AUDIT_REASONING'}],stream:true,stream_options:{include_usage:true}});
  assert.equal(response.status,200);
  const chunks=await Array.fromAsync(sseEvents(response.body));
  assert.equal(chunks.map(x=>x.choices?.[0]?.delta?.reasoning_content??'').join(''),'思考中。');
  assert.equal(chunks.map(x=>x.choices?.[0]?.delta?.content??'').join(''),'结论。');
  assert.equal(chunks.at(-1).usage.total_tokens,130);
  assert.equal(chunks.at(-1).usage.completion_tokens,30);
});

test('regression: content_filter preserves normal JSON and SSE endings, with or without preceding text', { timeout: 60000 }, async () => {
  for (const content of ['AUDIT_FILTER', 'AUDIT_FILTER_TEXT']) for (const stream of [false, true]) {
    const response = await request({ messages: [{ role: 'user', content }], stream });
    assert.equal(response.status, 200);
    if (stream) {
      const chunks = await Array.fromAsync(sseEvents(response.body));
      assert.equal(chunks.some(c => c.error), false);
      assert.equal(chunks.at(-1).choices[0].finish_reason, 'content_filter');
      assert.equal(chunks.map(c => c.choices[0]?.delta.content ?? '').join(''), content.endsWith('_TEXT') ? 'Before filtering.' : '');
    } else {
      const result = await response.json();
      assert.equal(result.choices[0].finish_reason, 'content_filter');
    }
  }
});

test('regression: environment-only global provider discovered must remain usable for inference', {timeout:60000},async()=>{
  const old=process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCODE_CONFIG_CONTENT=JSON.stringify({provider:{'audit-env':{npm:'@ai-sdk/openai-compatible',options:{baseURL:baseURL+'/v1',apiKey:'audit-fixture-key'},models:{mock:{limit:{context:100000,output:1000}}}}}});
  try {
    const bridge=new OpenCodeBridge({mode:'global',command,timeoutMs:15000,startupTimeoutMs:10000});
    await bridge.loadModels();
    assert.ok(bridge.config.models['audit-env/mock'],'environment-only provider is discovered');
    const before=requests.length;
    const response=await bridge.fetch('http://bridge/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'audit-env/mock',messages:[{role:'user',content:'Hello'}]})});
    const result=await response.json();

    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).auth, 'Bearer audit-fixture-key');
  } finally {if(old===undefined)delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT=old;}
});

test('regression: actual output limits return named client errors for both token fields and preserve valid boundaries', { timeout: 90000 }, async () => {
  const instance = new OpenCodeBridge({ ...options, onFailure: undefined, models: { test: { model: 'fixture-api/mock', context: 100000, output: 10000 } } });
  for (const field of ['max_tokens', 'max_completion_tokens']) for (const value of [999, 1000, 1001]) {
    const before = requests.length;
    const response = await instance.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'test', [field]: value, messages: [{ role: 'user', content: 'Hello' }] }) });
    const result = await response.json();
    assert.equal(response.status, value > 1000 ? 400 : 200, JSON.stringify(result));
    if (value > 1000) {
      assert.equal(result.error.param, field);
      assert.equal(requests.length, before, 'Invalid output limits must not start upstream inference');
    } else assert.equal(requests.at(-1).body.max_tokens, value);
    assert.equal(instance.active, 0);
  }
});

test('regression: allowed-prefix global local tool must not execute for API clients', {timeout:60000},async()=>{
  const sentinel=path.join(home,'local-tool-executed.txt');
  const customPlugin=path.join(configDir,'audit-local.mjs');
  await writeFile(customPlugin,`import {writeFile} from 'node:fs/promises';
export const AuditLocal=async()=>({tool:{bridge_audit_local:{description:'Audit fixture local tool',args:{},execute:async()=>{await writeFile(${JSON.stringify(sentinel)},'executed'); return 'local operation';}}}});`);
  const modified={...globalConfig,plugin:[...globalConfig.plugin,pathToFileURL(customPlugin).href]};
  await writeFile(path.join(configDir,'opencode.json'),JSON.stringify(modified));
  try {
    const tools = ['weather', 'clock'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }));
    const instance = new OpenCodeBridge({ ...options, onFailure: undefined });
    for (const extra of [{}, { tools, tool_choice: 'none' }, { tools }]) {
      const response = await request({ messages: [{ role: 'user', content: 'AUDIT_LOCAL_TOOL' }], ...extra }, instance);
      await response.json();
      await delay(100);
      assert.equal(await stat(sentinel).then(() => true, () => false), false, 'An unregistered local function was executed');
      assert.ok(!requests.at(-1).body.tools?.some(t => t.function.name === 'bridge_audit_local'), 'Local tool must not be advertised');
    }
  } finally {await writeFile(path.join(configDir,'opencode.json'),originalConfig);}
});

test('short discovery IDs and legacy qualified IDs invoke the same real upstream', {timeout:60000}, async()=>{
  const bridge=new OpenCodeBridge({...options,discoverModels:true});
  await bridge.loadModels();
  const id='DeepSeek-V4.1-Flash-line2-maas';
  assert.ok(bridge.models().data.some(m=>m.id===id));
  assert.ok(!bridge.models().data.some(m=>m.id==='fixture-api/'+id));
  assert.ok(bridge.models().data.some(m=>m.id==='fixture-api/mock'));
  assert.ok(bridge.models().data.some(m=>m.id==='fixture-oauth/mock'));
  assert.ok(!bridge.models().data.some(m=>m.id==='mock'));
  for(const model of [id,'fixture-api/'+id]){
    const response=await bridge.fetch('http://bridge/v1/chat/completions',{method:'POST',body:JSON.stringify({model,messages:[{role:'user',content:'Hello'}]})});
    assert.equal(response.status,200,JSON.stringify(await response.json()));
    assert.equal(requests.at(-1).body.model,id);
    assert.equal(requests.at(-1).auth,'Bearer fixture-saved-api-key');
  }
});


test('audit12: client prompts replace global instructions, skills and plugin prompt edits', { timeout: 60000 }, async t => {
  const noise = path.join(configDir, 'audit-noise.mjs');
  const skillDir = path.join(configDir, 'skills', 'audit-skill');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: audit-skill\ndescription: GLOBAL_SKILL_SENTINEL\n---\nGLOBAL_SKILL_BODY');
  await writeFile(path.join(configDir, 'AGENTS.md'), 'GLOBAL_AGENTS_SENTINEL');
  await writeFile(path.join(workingDirectory, 'AGENTS.md'), 'PROJECT_AGENTS_SENTINEL');
  await writeFile(noise, `export const Noise = async () => ({
    'experimental.chat.system.transform': async (_, out) => { out.system.push('PLUGIN_SYSTEM_SENTINEL'); },
    'experimental.chat.messages.transform': async (_, out) => { out.messages[0].parts.push({ ...out.messages[0].parts[0], text: 'PLUGIN_MESSAGE_SENTINEL' }); },
    'chat.params': async (_, out) => { out.temperature = 0.37; out.topP = 0.83; out.topK = 17; }
  });`);
  await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ ...globalConfig, plugin: [...globalConfig.plugin, pathToFileURL(noise).href], instructions: [baseURL + '/audit-instructions'], skills: { urls: [baseURL + '/audit-skills'] } }));
  try {
    const instance = new OpenCodeBridge({ ...options, workingDirectory });
    const response = await request({ messages: [{ role: 'system', content: 'CLIENT_SYSTEM_ONLY' }, { role: 'developer', content: 'CLIENT_DEVELOPER_ONLY' }, { role: 'user', content: 'CLIENT_USER_ONLY' }] }, instance);
    assert.equal(response.status, 200, await response.text());
    const sent = requests.at(-1).body;
    assert.deepEqual(sent.messages.filter(m => m.role === 'system').map(m => m.content), ['CLIENT_SYSTEM_ONLY', 'CLIENT_DEVELOPER_ONLY']);
    assert.equal(sent.messages.at(-1).content, 'CLIENT_USER_ONLY');
    assert.doesNotMatch(JSON.stringify(sent), /GLOBAL_SKILL|GLOBAL_AGENTS|PROJECT_AGENTS|PLUGIN_SYSTEM|PLUGIN_MESSAGE|REMOTE_INSTRUCTION|Complete the current client request|Follow the client instructions/);
    assert.deepEqual(sent.tools ?? [], []);
    await t.test('discarded instructions do not fetch remote content', () => assert.equal(instructionFetches, 0));
    await t.test('disabled skills do not fetch remote catalogs', () => assert.equal(skillFetches, 0));
    await t.test('omitted sampling parameters preserve defaults', () => {
      assert.equal(sent.temperature, 0.37);
      assert.equal(sent.top_p, 0.83);
    });
    const override = await request({ messages: [{ role: 'user', content: 'explicit' }], temperature: 0.1, top_p: 0.6 }, instance);
    assert.equal(override.status, 200, await override.text());
    assert.equal(requests.at(-1).body.temperature, 0.1);
    assert.equal(requests.at(-1).body.top_p, 0.6);
  } finally { await writeFile(path.join(configDir, 'opencode.json'), originalConfig); }
});

test('audit12: reasoning and multiline Unicode code stream before completion without duplication', { timeout: 60000 }, async () => {
  auditStream = { started: Promise.withResolvers(), release: Promise.withResolvers(), tail: Array.from({ length: 40 }, (_, i) => 'print("第' + i + '行🙂")\n').concat('```') };
  const response = await request({ messages: [{ role: 'user', content: 'AUDIT_INCREMENTAL' }], stream: true, stream_options: { include_usage: true } });
  assert.equal(response.status, 200);
  const chunks = [];
  const firstText = Promise.withResolvers();
  const consume = (async () => { for await (const chunk of sseEvents(response.body)) { chunks.push(chunk); if (chunk.choices?.[0]?.delta?.content) firstText.resolve(); } })();
  let timer;
  try {
    await Promise.race([firstText.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Text was buffered until upstream completion')), 5000); })]);
    assert.equal(chunks.some(c => c.choices?.[0]?.finish_reason), false);
  } finally { clearTimeout(timer); auditStream.release.resolve(); }
  await consume;
  assert.equal(chunks.some(c => c.error), false, JSON.stringify(chunks));
  assert.equal(chunks.map(c => c.choices?.[0]?.delta?.reasoning_content ?? '').join(''), '思考。');
  assert.equal(chunks.map(c => c.choices?.[0]?.delta?.content ?? '').join(''), '你好🙂\n\n```python\n' + auditStream.tail.join(''));
  assert.ok(chunks.filter(c => c.choices?.[0]?.delta?.content).length > 10);
  assert.equal(chunks.filter(c => c.choices?.[0]?.finish_reason === 'stop').length, 1);
  assert.equal(chunks.at(-1).usage.total_tokens, 15);
  assert.equal(bridge.active, 0);
});

test('audit12: discovered tool and sampling capabilities match native model metadata', { timeout: 60000 }, async () => {
  const proxy = new OpenCodeBridge({...options,models:undefined,discoverModels:true});
  try {
    const models=await proxy.loadModels();
    assert.equal(models['text-only'].toolcall,false);
    assert.equal(models['text-only'].temperature,false);
  } finally { await proxy.close(); }
});


test('reuse13: exclusive worker reuse resets request hooks and histories without extra inference', { timeout: 90000 }, async () => {
  const reports = [];
  const instance = new OpenCodeBridge({ ...options, workerReuse: true, maxIdleWorkers: 1, onDiagnostics: r => reports.push(r) });
  const before = requests.length;
  try {
    for (const marker of ['REUSE_FIRST', 'REUSE_SECOND']) {
      const response = await request({ messages: [{ role: 'system', content: marker + '_SYSTEM' }, { role: 'user', content: marker }], stream: true }, instance);
      assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
      const chunks = await Array.fromAsync(sseEvents(response.body));
      assert.equal(chunks.some(c => c.error), false, JSON.stringify(chunks));
      assert.equal(requests.at(-1).body.messages[0].content, marker + '_SYSTEM');
      assert.equal(requests.at(-1).body.messages.at(-1).content, marker);
      assert.ok(response.headers.get('x-opencode-request-id'));
    }
    assert.equal(requests.length, before + 2);
    await instance.drain();
    assert.equal(reports[0].workerReused, false);
    assert.equal(new Set((await observations()).slice(-2).map(w => w.pid)).size, 1, 'Both completed requests must use the same real process');
    assert.equal(reports[0].workerRetained, true);
    assert.equal(reports[1].workerReused, true);
    assert.equal(instance.pool.workers.size, 1);
    const worker = [...instance.pool.workers][0];
    const sessions = await fetch(worker.base + '/session', { headers: worker.headers }).then(r => r.json());
    assert.deepEqual(sessions, [], 'Completed client sessions are deleted before returning the worker');
    console.log(JSON.stringify({ reuse13: reports.map(r => ({ reused: r.workerReused, elapsedMs: r.elapsedMs, timings: r.timings })) }));
  } finally { await instance.close(); }
  assert.equal(instance.pool.workers.size, 0);
});


test('reuse13: prewarm never infers and reused workers replace tool schemas, history and permissions', { timeout: 90000 }, async () => {
  const reports = [];
  const instance = new OpenCodeBridge({ ...options, workerReuse: true, warmupModels: ['oc-default'], onDiagnostics: r => reports.push(r) });
  const before = requests.length;
  const tools = ['weather', 'clock'].map(name => ({type:'function',function:{name,parameters:{type:'object',properties:{city:{type:'string'}}}}}));
  try {
    await instance.prewarm();
    assert.equal(requests.length, before, 'Prewarm must never start model inference');
    assert.equal(reports[0].status, 'warmed');
    assert.equal(instance.pool.idle.length, 1);
    const response = await request({ messages: [{role:'user',content:'TOOLS_AFTER_PREWARM'}], tools }, instance);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(result.choices[0].message.tool_calls.map(t => t.function.name), ['weather','clock']);
    await instance.drain();
    assert.equal(reports.at(-1).workerReused, true);
    const second = await request({ messages: [{role:'user',content:'NO_TOOLS_NEXT'}], tool_choice:'none', tools }, instance);
    assert.equal(second.status, 200, await second.text());
    assert.deepEqual(requests.at(-1).body.tools ?? [], []);
    await instance.drain();
    assert.equal(reports.at(-1).workerReused, true);
    assert.equal(requests.length, before + 2, 'Tool deferral must not start a hidden continuation');
    assert.equal(instance.pool.workers.size, 1);
    const pooled = [...instance.pool.workers][0];
    await assert.rejects(() => stat(pooled.requestFile), { code: 'ENOENT' });
    await assert.rejects(() => stat(pooled.hookFile), { code: 'ENOENT' });
  } finally { await instance.close(); }
});

test('reuse13: first-output and idle failures ignore vendor heartbeats and discard the worker', { timeout: 90000 }, async () => {
  for (const [marker, expected] of [['TIMEOUT_FIRST','first_output'], ['TIMEOUT_IDLE','idle']]) {
    const reports = [];
    const instance = new OpenCodeBridge({ ...options, workerReuse: true, timeoutMs: 0, firstOutputTimeoutMs: 5000, idleTimeoutMs: 400, onFailure: undefined, onDiagnostics: r => reports.push(r) });
    const before = requests.length;
    try {
      const response = await request({ messages:[{role:'user',content:marker}],stream:true }, instance);
      const result = response.status === 200 ? (await Array.fromAsync(sseEvents(response.body))).find(c=>c.error) : await response.json();
      assert.equal(response.status, expected === 'first_output' ? 504 : 200, JSON.stringify(result));
      assert.equal(result.error.code, 'opencode_timeout');
      assert.ok(result.error.message.includes(expected), result.error.message);
      assert.equal(requests.length, before + 1);
      assert.equal(reports.at(-1).timeoutKind, expected);
      assert.equal(instance.pool.workers.size, 0);
      assert.equal(instance.active, 0);
      assert.equal(JSON.stringify(reports).includes(marker), false, 'Diagnostics must not log prompt content');
      assert.equal(JSON.stringify(reports).includes('fixture-refreshed-access'), false);
    } finally { await instance.close(); }
  }
});

test('reuse13: idle expiry retires the process and removes its temporary database', { timeout: 60000 }, async () => {
  const instance = new OpenCodeBridge({ ...options, workerReuse:true, workerIdleMs:200 });
  try {
    const response = await request({ messages:[{role:'user',content:'EXPIRING'}] },instance);
    assert.equal(response.status,200,await response.text());
    const worker = [...instance.pool.workers][0];
    assert.ok(worker);
    await delay(800);
    assert.equal(instance.pool.workers.size,0);
    await assert.rejects(() => stat(worker.home),{code:'ENOENT'});
  } finally {await instance.close();}
});

test('reuse13: an idle worker that exited by signal is replaced before inference', { timeout: 60000 }, async () => {
  const reports = [];
  const instance = new OpenCodeBridge({ ...options, workerReuse: true, onDiagnostics: r => reports.push(r) });
  const before = requests.length;
  try {
    const first = await request({ messages: [{ role: 'user', content: 'BEFORE_EXIT' }] }, instance);
    assert.equal(first.status, 200, await first.text());
    await instance.drain();
    const prior = [...instance.pool.workers][0];
    prior.child.kill();
    await prior.worker.done;
    const next = await request({ messages: [{ role: 'user', content: 'AFTER_EXIT' }] }, instance);
    assert.equal(next.status, 200, await next.text());
    await instance.drain();
    assert.equal(reports.at(-1).workerReused, false);
    assert.notEqual([...instance.pool.workers][0].child.pid, prior.child.pid);
    assert.equal(requests.length, before + 2);
  } finally { await instance.close(); }
});

test('reuse13: a slow downstream reader does not idle-timeout an upstream that has completed', { timeout: 60000 }, async () => {
  const instance = new OpenCodeBridge({ ...options, workerReuse: true, timeoutMs: 0, idleTimeoutMs: 700, firstOutputTimeoutMs: 5000, onFailure: undefined });
  auditStream = { started: Promise.withResolvers(), release: Promise.withResolvers(), tail: Array.from({length:40},(_,i)=>'line '+i+'\n') };
  try {
    const response = await request({ messages:[{role:'user',content:'AUDIT_INCREMENTAL'}],stream:true },instance);
    assert.equal(response.status,200);
    await auditStream.started.promise;
    auditStream.release.resolve();
    await delay(1500); // Do not consume the body while the upstream completes.
    const chunks = await Array.fromAsync(sseEvents(response.body));
    assert.equal(chunks.some(c=>c.error),false,JSON.stringify(chunks));
    assert.equal(chunks.at(-1).choices[0].finish_reason,'stop');
    assert.equal(chunks.map(c=>c.choices[0]?.delta?.content??'').join(''),'你好🙂\n\n```python\n'+auditStream.tail.join(''));
  } finally {auditStream.release.resolve();await instance.close();}
});

test('thinking compatibility: enabled toggles and explicit budgets reach the real global OpenCode SDK', {timeout:120000}, async()=>{
  const {onFailure,...configuration}=options;
  const runtime=new ProxyRuntime({file:path.join(home,'thinking-config.json'),settings:{...configuration,workerReuse:true,maxIdleWorkers:2,host:'127.0.0.1',port:0,modelOverrides:{'fixture-api/thinking-toggle':{defaults:{reasoning_effort:'none'}}},apiKeys:[{id:'test',name:'fixture',key:'fixture-thinking-key',enabled:true}],models:{effort:{model:'fixture-api/thinking-toggle',context:100000,output:4096,reasoning:true,reasoningEfforts:['none','low','high'],reasoningAdapter:'effort'},budget:{model:'fixture-anthropic/native-thinking',context:100000,output:4096},plain:{model:'fixture-anthropic/no-reasoning',context:100000,output:4096}}}});
  try{
    await runtime.startGateway();const base=runtime.state().endpoint;
    const send=(model,thinking,stream=false,extra={})=>fetch(base+'/messages',{method:'POST',headers:{'x-api-key':'fixture-thinking-key','content-type':'application/json'},body:JSON.stringify({model,max_tokens:4096,messages:[{role:'user',content:'hello'}],thinking,stream,...extra})});
    const consume=async response=>{assert.equal(response.status,200,response.status===200?'':await response.text());if(response.headers.get('content-type')?.includes('event-stream')){const events=await Array.fromAsync(sseEvents(response.body));assert.equal(events.at(-1).type,'message_stop');assert.equal(events.some(e=>e.type==='error'),false,JSON.stringify(events));}else assert.equal((await response.json()).stop_reason,'end_turn');};
    for(const stream of [false,true]){
      await consume(await send('effort',{type:'enabled'},stream));assert.notEqual(requests.at(-1).body.reasoning_effort,'none');assert.ok(requests.at(-1).body.reasoning_effort);assert.equal(requests.at(-1).body.thinking,undefined);
      await consume(await send('budget',{type:'enabled',budget_tokens:2048},stream));assert.deepEqual(requests.at(-1).body.thinking,{type:'enabled',budget_tokens:2048});assert.equal(requests.at(-1).body.reasoning_effort,undefined);
    }
    await consume(await send('effort',{type:'disabled'}));assert.equal(requests.at(-1).body.reasoning_effort,'none');
    await consume(await send('effort',{type:'enabled'},false,{output_config:{effort:'low'}}));assert.equal(requests.at(-1).body.reasoning_effort,'low');
    await consume(await send('budget',{type:'disabled'}));assert.ok([undefined,'disabled'].includes(requests.at(-1).body.thinking?.type));
    await consume(await send('budget',{type:'enabled'}));assert.deepEqual(requests.at(-1).body.thinking,{type:'enabled',budget_tokens:1024});
    const before=requests.length;
    for(const [model,thinking,extra] of [['effort',{type:'enabled',budget_tokens:2048},{}],['plain',{type:'enabled'},{}],['budget',{type:'enabled',budget_tokens:4096},{}],['effort',{type:'enabled'},{output_config:{effort:'none'}}]]){
      const rejected=await send(model,thinking,false,extra);assert.equal(rejected.status,400);const error=await rejected.json();assert.equal(error.error.type,'invalid_request_error');if(model==='effort'&&thinking.budget_tokens)assert.match(error.error.message,/cannot preserve a numeric thinking budget/);
    }
    assert.equal(requests.length,before,'Invalid thinking controls never start supplier inference');assert.equal(runtime.current.active,0);
    const omitted=await fetch(base+'/messages',{method:'POST',headers:{'x-api-key':'fixture-thinking-key'},body:JSON.stringify({model:'effort',max_tokens:4096,messages:[{role:'user',content:'hello'}]})});await consume(omitted);assert.equal(requests.at(-1).body.reasoning_effort,'none','Thinking controls are reset when an idle worker is reused');
  }finally{await runtime.close();}
});

test('protocol compatibility: real global OpenCode preserves Responses history and buffered Anthropic tools', {timeout:120000}, async()=>{
  const {onFailure,...configuration}=options;
  const runtime=new ProxyRuntime({file:path.join(home,'protocol-config.json'),settings:{...configuration,host:'127.0.0.1',port:0,modelOverrides:{},apiKeys:[{id:'test',name:'fixture',key:'fixture-protocol-key',enabled:true}],models:{friendly:{model:'fixture-api/mock',context:100000,output:1000},native:{model:'fixture-anthropic/native-thinking',context:100000,output:4096}}}});
  try{
    await runtime.startGateway();const base=runtime.state().endpoint,headers={authorization:'Bearer fixture-protocol-key','content-type':'application/json'};
    const send=async(route,body)=>{const response=await fetch(base+'/'+route,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,200,response.status===200?'':await response.text());return response;};
    const before=requests.length,models=await fetch(base+'/models',{headers:{'x-api-key':'fixture-protocol-key','anthropic-version':'2023-06-01'}}).then(r=>r.json());assert.ok(models.data.some(m=>m.id==='friendly'&&m.type==='model'));assert.equal(requests.length,before);
    for(const stream of [false,true]){
      const first=await send('responses',{model:'friendly',input:'AUDIT_REASONING',stream,store:false,include:['reasoning.encrypted_content'],dsh_plugin_packages:{version:1,packages:[{name:'fixture',version:'1.0'}]}});let result;
      if(stream){for await(const event of sseEvents(first.body))if(event.type==='response.completed')result=event.response;}else result=await first.json();
      assert.ok(result.output.some(item=>item.type==='reasoning'));
      const follow=await send('responses',{model:'friendly',store:false,input:[{role:'user',content:'AUDIT_REASONING'},...result.output,{role:'user',content:'continue'}]});await follow.text();
      assert.ok(requests.at(-1).body.messages.some(m=>m.role==='assistant'&&m.reasoning_content==='思考中。'));
      assert.ok(requests.at(-1).body.messages.some(m=>m.role==='assistant'&&m.content==='结论。'));
      assert.equal(requests.at(-1).body.dsh_plugin_packages,undefined);
    }
    const schema={type:'object',properties:{city:{type:'string'}}};
    const tools=await send('messages',{model:'friendly',max_tokens:100,stream:true,messages:[{role:'user',content:'CALL_TOOLS'}],tools:['weather','clock'].map(name=>({type:'custom',name,input_schema:schema,eager_input_streaming:true}))});
    const events=await Array.fromAsync(sseEvents(tools.body));assert.equal(events.at(-1).type,'message_stop');assert.equal(events.filter(e=>e.type==='content_block_start'&&e.content_block.type==='tool_use').length,2);assert.ok(events.some(e=>e.type==='message_delta'&&e.delta.stop_reason==='tool_use'));
    assert.equal(requests.at(-1).body.tools.some(t=>'eager_input_streaming' in t),false);
    const native=await send('messages',{model:'native',max_tokens:100,top_k:31,messages:[{role:'user',content:'Hello'}]});await native.text();assert.equal(requests.at(-1).body.top_k,31);
    const chat=await send('chat/completions',{model:'friendly',messages:[{role:'user',content:'hello'}],user:'sdk-user',metadata:{client:'sdk'},store:false,parallel_tool_calls:true,response_format:{type:'text'}});await chat.text();
    for(const field of ['user','metadata','store','parallel_tool_calls','response_format'])assert.equal(requests.at(-1).body[field],undefined);
    assert.equal(runtime.current.active,0);
  }finally{await runtime.close();}
});

test('proxy constraints use native OpenCode structured output and preserve strict client-tool schemas',{timeout:90000},async()=>{
 const instance=new OpenCodeBridge({...options,workerReuse:true,onFailure:undefined}),schema={type:'object',properties:{answer:{type:'integer',const:42}},required:['answer'],additionalProperties:false};
 try{
  for(const stream of [false,true]){
   const r=await request({messages:[{role:'user',content:'GLOBAL_NATIVE_JSON'}],stream,reasoning_effort:stream?'high':'none',response_format:{type:'json_schema',json_schema:{name:'answer',schema,strict:true}},...(stream?{stream_options:{include_usage:true}}:{})},instance);
   assert.equal(r.status,200);const values=stream?await Array.fromAsync(sseEvents(r.body)):[await r.json()];assert.ok(!values.some(x=>x.error),JSON.stringify(values));
   assert.equal(requests.at(-1).body.reasoning_effort,stream?'high':'none');
   if(stream)assert.notEqual(requests.at(-1).body.tool_choice,'required','Thinking mode must not use an incompatible forced provider tool choice');
   const text=stream?values.map(x=>x.choices?.[0]?.delta?.content??'').join(''):values[0].choices[0].message.content;assert.deepEqual(JSON.parse(text),{answer:42});
   const tool={type:'function',function:{name:'weather',strict:true,parameters:{type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}}};
   const forced=await request({messages:[{role:'user',content:'GLOBAL_NATIVE_FORCE'}],tools:[tool],tool_choice:{type:'function',function:{name:'weather'}},parallel_tool_calls:false,stream},instance);
   assert.equal(forced.status,200);const calls=stream?(await Array.fromAsync(sseEvents(forced.body))).flatMap(x=>x.choices?.[0]?.delta?.tool_calls??[]):(await forced.json()).choices[0].message.tool_calls;
   assert.equal(calls.length,1);assert.equal(calls[0].function.name,'weather');assert.deepEqual(JSON.parse(calls[0].function.arguments),{city:'北京'});
  }
 }finally{await instance.close();}
});
test('real global OpenCode retries temporary rate limits and recovers from network failures without changing user auth',{timeout:120000},async()=>{
 const instance=new OpenCodeBridge({...options,workerReuse:true,firstOutputTimeoutMs:20000,onFailure:undefined});
 try{
  for(const fault of ['GLOBAL_FAULT_RATE_LIMIT','GLOBAL_FAULT_NETWORK']){
   const r=await request({messages:[{role:'user',content:fault}]},instance);const result=await r.json();
   if(fault==='GLOBAL_FAULT_RATE_LIMIT'){assert.equal(r.status,200,JSON.stringify(result));assert.equal(faultAttempts.get(fault),3);}
   else assert.ok([200,502].includes(r.status),JSON.stringify(result));
   const recovered=await request({messages:[{role:'user',content:'hello after '+fault}]},instance);assert.equal(recovered.status,200);await recovered.json();assert.equal(instance.active,0);
  }
  const limited=await request({messages:[{role:'user',content:'GLOBAL_FAULT_PERMANENT_LIMIT'}]},instance);const error=await limited.json();assert.equal(limited.status,429,JSON.stringify(error));assert.equal(error.error.code,'upstream_rate_limit');assert.ok(limited.headers.get('retry-after'));assert.equal(faultAttempts.get('GLOBAL_FAULT_PERMANENT_LIMIT'),3);
  const interrupted=await request({messages:[{role:'user',content:'GLOBAL_FAULT_PARTIAL'}],stream:true},instance);
  assert.equal(interrupted.status,200);const chunks=await Array.fromAsync(sseEvents(interrupted.body));assert.ok(JSON.stringify(chunks).includes('PARTIAL_BEFORE_DISCONNECT'));assert.ok(chunks.some(c=>c.error));assert.ok(!chunks.some(c=>c.choices?.[0]?.finish_reason==='stop'));assert.equal(faultAttempts.get('GLOBAL_FAULT_PARTIAL'),1,'Do not replay a supplier request after partial output');
  const next=await request({messages:[{role:'user',content:'hello after partial disconnect'}]},instance);assert.equal(next.status,200);await next.json();
 }finally{await instance.close();}
});

test('fault recovery and rate-limit error contracts survive all three client protocol adapters',{timeout:120000},async()=>{
 const runtime=new ProxyRuntime({file:path.join(home,'protocol-fault-settings.json'),settings:{...options,onFailure:undefined,host:'127.0.0.1',port:0,workerReuse:true,firstOutputTimeoutMs:20000,discoverModels:false,modelOverrides:{},apiKeys:[{id:'fixture',name:'fixture',key:'fixture-proxy-key',enabled:true}]}});
 try{for(const protocol of ['chat','responses','anthropic'])for(const stream of [false,true]){
  const send=marker=>runtime.fetch('http://proxy/v1/'+({chat:'chat/completions',responses:'responses',anthropic:'messages'}[protocol]),{method:'POST',body:JSON.stringify({model:'oc-default',stream,...(protocol==='responses'?{input:marker,store:false}:{messages:[{role:'user',content:marker}],...(protocol==='anthropic'?{max_tokens:100}:{})})})});
  const good='GLOBAL_FAULT_RATE_LIMIT_'+protocol+'_'+stream,r=await send(good);assert.equal(r.status,200);const result=stream?await Array.fromAsync(sseEvents(r.body)):await r.json();assert.ok(JSON.stringify(result).includes('全局 OpenCode'));assert.equal(faultAttempts.get(good),3);
  const bad='GLOBAL_FAULT_PERMANENT_LIMIT_'+protocol+'_'+stream,limited=await send(bad),error=await limited.json();assert.equal(limited.status,429,JSON.stringify(error));assert.ok(limited.headers.get('retry-after'));assert.equal(error.error.type,'rate_limit_error');
  assert.equal(faultAttempts.get(bad),3);assert.equal(runtime.current.active,0);
 }}finally{await runtime.close();}
});

test('inline image parts cross all protocol adapters and the real OpenCode SDK without file access',{timeout:60000},async()=>{
 const runtime=new ProxyRuntime({file:path.join(home,'media-settings.json'),settings:{...options,onFailure:undefined,host:'127.0.0.1',port:0,workerReuse:true,discoverModels:false,modelOverrides:{},models:{vision:{model:'fixture-api/mock',context:100000,output:1000,inputModalities:['text','image']},plain:{model:'fixture-api/mock',context:100000,output:1000,inputModalities:['text']}},apiKeys:[{id:'fixture',name:'fixture',key:'fixture-proxy-key',enabled:true}]}});
 const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yS7cAAAAASUVORK5CYII=',url='data:image/png;base64,'+data;
 try{for(const protocol of ['chat','responses','anthropic']){
  const content=protocol==='chat'?[{type:'text',text:'Inspect this image.'},{type:'image_url',image_url:{url}}]:protocol==='responses'?[{type:'input_text',text:'Inspect this image.'},{type:'input_image',image_url:url}]:[{type:'text',text:'Inspect this image.'},{type:'image',source:{type:'base64',media_type:'image/png',data}}];
  const b={model:'vision',...(protocol==='responses'?{input:[{role:'user',content}],store:false}:{messages:[{role:'user',content}],...(protocol==='anthropic'?{max_tokens:100}:{})})};
  const route='http://proxy/v1/'+({chat:'chat/completions',responses:'responses',anthropic:'messages'}[protocol]);
  const r=await runtime.fetch(route,{method:'POST',body:JSON.stringify(b)}),result=await r.json();assert.equal(r.status,200,JSON.stringify(result));
  const sent=requests.at(-1).body.messages.find(m=>m.role==='user').content;assert.ok(Array.isArray(sent));assert.equal(sent[0].text,'Inspect this image.');assert.equal(sent[1].image_url.url,url);
  const before=requests.length,rejected=await runtime.fetch(route,{method:'POST',body:JSON.stringify({...b,model:'plain'})});assert.equal(rejected.status,400);assert.equal(requests.length,before);
 }}finally{await runtime.close();}
});

test('advanced Responses identities and parallel image tool results survive real OpenCode', {timeout:120000}, async()=>{
 const runtime=new ProxyRuntime({file:path.join(home,'advanced-tools.json'),settings:{...options,onFailure:undefined,host:'127.0.0.1',port:0,workerReuse:true,discoverModels:false,modelOverrides:{},models:{vision:{model:'fixture-api/mock',context:100000,output:1000,inputModalities:['text','image']}},apiKeys:[]}});
 const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yS7cAAAAASUVORK5CYII=',url='data:image/png;base64,'+data,route='http://proxy/v1/responses';
 try{for(const stream of [false,true]){
  const body={model:'vision',input:'GLOBAL_ADVANCED_TOOLS',tools:advancedTools,stream},response=await runtime.fetch(route,{method:'POST',body:JSON.stringify(body)});assert.equal(response.status,200);
  const first=stream?(await Array.fromAsync(sseEvents(response.body))).at(-1).response:await response.json();assert.ok(first, 'Missing terminal response');
  const calls=first.output.filter(i=>['function_call','custom_tool_call'].includes(i.type));assert.equal(calls.length,2);assert.equal(calls[0].namespace,'crm');assert.equal(calls[0].name,'lookup');assert.equal(calls[1].type,'custom_tool_call');assert.equal(calls[1].input,'print("北京🙂")\n');
  const input=[{role:'user',content:body.input},...first.output,...calls.toReversed().map(c=>({type:c.type==='custom_tool_call'?'custom_tool_call_output':'function_call_output',call_id:c.call_id,output:[{type:'input_text',text:'tool '+c.call_id},{type:'input_image',image_url:url}]}))];
  const next=await runtime.fetch(route,{method:'POST',body:JSON.stringify({...body,input})});assert.equal(next.status,200);const final=stream?(await Array.fromAsync(sseEvents(next.body))).at(-1).response:await next.json();assert.ok(JSON.stringify(final.output).includes('ADVANCED_OK'));
  const sent=requests.at(-1).body.messages;assert.equal(sent.filter(m=>m.role==='tool').length,2);const images=sent.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url');assert.equal(images.length,2);assert.ok(images.every(i=>i.image_url.url===url));assert.ok(JSON.stringify(sent).includes('call_id: advanced_1'));assert.ok(JSON.stringify(sent).includes('call_id: advanced_0'));
 }}finally{await runtime.close();}
});

test('Anthropic unsigned thinking displays and replays through real OpenCode before and after client tools', {timeout:120000}, async()=>{
 const runtime=new ProxyRuntime({file:path.join(home,'thinking-display.json'),settings:{...options,onFailure:undefined,workerReuse:true,host:'127.0.0.1',port:0,modelOverrides:{},models:{demo:{model:'fixture-api/thinking-toggle',context:100000,output:4096}},apiKeys:[]}});
 const tools=[{name:'weather',input_schema:{type:'object',properties:{city:{type:'string'}},required:['city']}}],route='http://proxy/v1/messages';
 try{for(const stream of [false,true])for(const thinking of [{type:'enabled'},{type:'adaptive',display:'summarized'},{type:'enabled',display:'omitted'}]){
  const body={model:'demo',max_tokens:4096,stream,thinking,tools,messages:[{role:'user',content:'GLOBAL_THINKING_CLIENT'}]},response=await runtime.fetch(route,{method:'POST',body:JSON.stringify(body)});assert.equal(response.status,200,response.status===200?'':await response.text());
  let content,stop;
  if(stream){const events=await Array.fromAsync(sseEvents(response.body));assert.ok(!events.some(e=>e.error),JSON.stringify(events));content=events.filter(e=>e.type==='content_block_start').map(e=>{const b={...e.content_block},d=events.filter(d=>d.type==='content_block_delta'&&d.index===e.index).map(e=>e.delta);if(b.type==='thinking')b.thinking=d.map(d=>d.thinking??'').join('');if(b.type==='tool_use')b.input=JSON.parse(d.map(d=>d.partial_json??'').join(''));return b;});stop=events.find(e=>e.type==='message_delta').delta.stop_reason;}
  else{const result=await response.json();content=result.content;stop=result.stop_reason;}
  assert.equal(stop,'tool_use');const thought=content.find(b=>b.type==='thinking');if(thinking.display==='omitted')assert.equal(thought,undefined);else{assert.equal(thought.thinking,'原生思考🙂\n检查工具结果。');assert.equal(thought.signature,'');}
  assert.equal(requests.at(-1).body.reasoning_effort,'high');
  const call=content.find(b=>b.type==='tool_use'),next={...body,stream:false,messages:[...body.messages,{role:'assistant',content},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'北京晴'}]}]};
  const final=await runtime.fetch(route,{method:'POST',body:JSON.stringify(next)}),answer=await final.json();assert.equal(final.status,200,JSON.stringify(answer));assert.equal(answer.content.find(b=>b.type==='text').text,'收到工具结果。');
  if(thought){const assistant=requests.at(-1).body.messages.find(m=>m.role==='assistant'&&m.tool_calls?.length);assert.equal(assistant.reasoning_content,thought.thinking);}
 }}finally{await runtime.close();}
});

test('global DSML leaked text becomes client tools and tool results continue through real OpenCode in all protocols', {timeout:120000}, async()=>{
  const runtime=new ProxyRuntime({file:path.join(home,'dsml-settings.json'),settings:{...options,onFailure:undefined,workerReuse:true,host:'127.0.0.1',port:0,modelOverrides:{},models:{demo:{model:'fixture-api/mock',context:100000,output:1000}},apiKeys:[]}});
  const parameters={type:'object',properties:{code:{type:'string'},description:{type:'string'}},required:['code','description'],additionalProperties:false};
  try{for(const protocol of ['chat','responses','anthropic'])for(const stream of [false,true]){
    const tools=protocol==='chat'?[{type:'function',function:{name:'run_code',parameters}}]:protocol==='responses'?[{type:'function',name:'run_code',parameters}]:[{name:'run_code',input_schema:parameters}];
    const body={model:'demo',tools,stream,...(protocol==='responses'?{input:'GLOBAL_DSML_RECOVERY',store:false}:{messages:[{role:'user',content:'GLOBAL_DSML_RECOVERY'}],...(protocol==='anthropic'?{max_tokens:500}:{})})};
    const route='http://proxy/v1/'+({chat:'chat/completions',responses:'responses',anthropic:'messages'}[protocol]);
    const first=await runtime.fetch(route,{method:'POST',body:JSON.stringify(body)});assert.equal(first.status,200,first.status===200?'':await first.text());
    const events=stream?await Array.fromAsync(sseEvents(first.body)):undefined,result=stream?undefined:await first.json();let next;
    assert.ok(!JSON.stringify(events??result).includes('DSML'));assert.ok(!events?.some(e=>e.error),JSON.stringify(events));
    if(protocol==='chat'){
      const message=stream?{role:'assistant',content:null,tool_calls:events.flatMap(e=>e.choices?.[0]?.delta.tool_calls??[]).map(({index,...c})=>c)}:result.choices[0].message;
      assert.equal(stream?events.find(e=>e.choices?.[0]?.finish_reason)?.choices[0].finish_reason:result.choices[0].finish_reason,'tool_calls');
      const call=message.tool_calls[0];assert.equal(call.function.name,'run_code');assert.equal(JSON.parse(call.function.arguments).code,dsmlCode);
      next={...body,stream:false,messages:[...body.messages,message,{role:'tool',tool_call_id:call.id,content:'retry policy found'}]};
    }else if(protocol==='responses'){
      const response=stream?events.at(-1).response:result,call=response.output.find(i=>i.type==='function_call');assert.equal(call.name,'run_code');assert.equal(JSON.parse(call.arguments).code,dsmlCode);
      next={...body,stream:false,input:[{role:'user',content:body.input},...response.output,{type:'function_call_output',call_id:call.call_id,output:'retry policy found'}]};
    }else{
      assert.equal(stream?events.find(e=>e.type==='message_delta').delta.stop_reason:result.stop_reason,'tool_use');
      const start=stream?events.find(e=>e.type==='content_block_start'&&e.content_block.type==='tool_use'):undefined;
      const call=stream?{...start.content_block,input:JSON.parse(events.filter(e=>e.type==='content_block_delta'&&e.index===start.index&&e.delta.type==='input_json_delta').map(e=>e.delta.partial_json).join(''))}:result.content.find(b=>b.type==='tool_use');
      assert.equal(call.name,'run_code');assert.equal(call.input.code,dsmlCode);
      next={...body,stream:false,messages:[...body.messages,{role:'assistant',content:[call]},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'retry policy found'}]}]};
    }
    const reply=await runtime.fetch(route,{method:'POST',body:JSON.stringify(next)}),answer=await reply.json();assert.equal(reply.status,200,JSON.stringify(answer));assert.match(JSON.stringify(answer),/全局 OpenCode/);
    const history=requests.at(-1).body.messages;assert.equal(history.find(m=>m.role==='tool').content,'retry policy found');assert.equal(JSON.parse(history.find(m=>m.tool_calls?.length).tool_calls[0].function.arguments).code,dsmlCode);
  }}finally{await runtime.close();}
});

test(
  'global prefixed DSML preserves prose, raw client names and parallel results through all protocols',
  { timeout: 120000 },
  async () => {
    const runtime = new ProxyRuntime({
      file: path.join(home, 'dsml-prefix-settings.json'),
      settings: {
        ...options,
        onFailure: undefined,
        workerReuse: true,
        host: '127.0.0.1',
        port: 0,
        modelOverrides: {},
        models: { demo: { model: 'fixture-api/mock', context: 100000, output: 1000 } },
        apiKeys: []
      }
    });
    const definitions = [
      {
        name: 'pwsh',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' }, description: { type: 'string' } },
          required: ['command', 'description'],
          additionalProperties: false
        }
      },
      {
        name: 'run_code',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string' }, description: { type: 'string' } },
          required: ['code', 'description'],
          additionalProperties: false
        }
      }
    ];
    const before = requests.length;
    try {
      for (const protocol of ['chat', 'responses', 'anthropic'])
        for (const stream of [false, true]) {
          const tools = definitions.map((t) =>
            protocol === 'chat'
              ? { type: 'function', function: t }
              : protocol === 'responses'
                ? { type: 'function', ...t }
                : { name: t.name, input_schema: t.parameters }
          );
          const body = {
              model: 'demo',
              stream,
              tools,
              ...(protocol === 'responses'
                ? { input: 'GLOBAL_DSML_PREFIX_RECOVERY' }
                : {
                    messages: [{ role: 'user', content: 'GLOBAL_DSML_PREFIX_RECOVERY' }],
                    ...(protocol === 'anthropic' ? { max_tokens: 1000 } : {})
                  })
            },
            route =
              'http://proxy/v1/' +
              { chat: 'chat/completions', responses: 'responses', anthropic: 'messages' }[protocol];
          const response = await runtime.fetch(route, { method: 'POST', body: JSON.stringify(body) });
          assert.equal(response.status, 200);
          const events = stream ? await Array.fromAsync(sseEvents(response.body)) : undefined,
            result = stream ? undefined : await response.json();
          assert.ok(!JSON.stringify(events ?? result).includes('DSML'));
          let calls, text, next;
          if (protocol === 'chat') {
            const message = stream
              ? {
                  role: 'assistant',
                  content: events.map((e) => e.choices?.[0]?.delta.content ?? '').join(''),
                  tool_calls: toolCalls(events).map(({ index, ...c }) => c)
                }
              : result.choices[0].message;
            text = message.content;
            calls = message.tool_calls;
            assert.equal(
              stream
                ? events.find((e) => e.choices?.[0]?.finish_reason)?.choices[0].finish_reason
                : result.choices[0].finish_reason,
              'tool_calls'
            );
            next = {
              ...body,
              stream: false,
              messages: [
                ...body.messages,
                message,
                ...calls
                  .toReversed()
                  .map((c) => ({ role: 'tool', tool_call_id: c.id, content: 'done ' + c.function.name }))
              ]
            };
            calls = calls.map((c) => ({ name: c.function.name, input: JSON.parse(c.function.arguments) }));
          } else if (protocol === 'responses') {
            const final = stream ? events.at(-1).response : result;
            text = final.output
              .flatMap((i) => i.content ?? [])
              .map((p) => p.text ?? '')
              .join('');
            calls = final.output.filter((i) => i.type === 'function_call');
            assert.equal(final.status, 'completed');
            next = {
              ...body,
              stream: false,
              input: [
                { role: 'user', content: body.input },
                ...final.output,
                ...calls
                  .toReversed()
                  .map((c) => ({ type: 'function_call_output', call_id: c.call_id, output: 'done ' + c.name }))
              ]
            };
            calls = calls.map((c) => ({ name: c.name, input: JSON.parse(c.arguments) }));
          } else {
            const content = stream
              ? events
                  .filter((e) => e.type === 'content_block_start')
                  .map((e) => {
                    const b = { ...e.content_block },
                      d = events.filter((d) => d.index === e.index && d.type === 'content_block_delta');
                    if (b.type === 'text') b.text = d.map((d) => d.delta.text ?? '').join('');
                    if (b.type === 'tool_use') b.input = JSON.parse(d.map((d) => d.delta.partial_json ?? '').join(''));
                    return b;
                  })
              : result.content;
            text = content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('');
            calls = content.filter((b) => b.type === 'tool_use');
            assert.equal(
              stream ? events.find((e) => e.type === 'message_delta').delta.stop_reason : result.stop_reason,
              'tool_use'
            );
            next = {
              ...body,
              stream: false,
              messages: [
                ...body.messages,
                { role: 'assistant', content },
                {
                  role: 'user',
                  content: calls
                    .toReversed()
                    .map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'done ' + c.name }))
                }
              ]
            };
          }
          assert.equal(text, dsmlPreface);
          assert.deepEqual(
            calls.map((c) => c.name),
            ['pwsh', 'run_code']
          );
          assert.equal(calls[0].input.command, dsmlShellCommand);
          assert.equal(calls[1].input.code, dsmlCode);
          const final = await runtime.fetch(route, { method: 'POST', body: JSON.stringify(next) });
          assert.equal(final.status, 200);
          assert.match(JSON.stringify(await final.json()), /全局 OpenCode/);
          const sent = requests.at(-1).body.messages;
          assert.equal(sent.filter((m) => m.role === 'tool').length, 2);
          assert.deepEqual(
            sent.filter((m) => m.role === 'tool').map((m) => m.content),
            ['done pwsh', 'done run_code']
          );
          assert.equal(
            JSON.parse(sent.find((m) => m.tool_calls?.length).tool_calls[0].function.arguments).command,
            dsmlShellCommand
          );
        }
    } finally {
      await runtime.close();
    }
    assert.equal(requests.length, before + 12, 'No local tool execution or hidden OpenCode continuation inference');
  }
);

test('hotpath: automatic runtime warmup never infers and keeps both selected models ready', {timeout:90000}, async()=>{
 const runtime=new ProxyRuntime({file:path.join(home,'hot-runtime.json'),settings:{...options,onFailure:undefined,workerReuse:true,discoverModels:false,workerIdleMs:100,host:'127.0.0.1',port:0,models:{a:{model:'fixture-api/mock',context:100000,output:1000},b:{model:'fixture-api/native-variants',context:100000,output:1000},c:{model:'fixture-api/text-only',context:100000,output:1000}},modelOverrides:{},apiKeys:[]}}),reports=[];runtime.current.bridge.config.onDiagnostics=r=>reports.push(r);
 const before=requests.length;
 try{
  await runtime.startGateway();await runtime.warmup;await runtime.current.bridge.drain();assert.equal(requests.length,before,'No supplier inference during readiness');assert.equal(runtime.current.bridge.pool.idle.length,2);assert.equal(runtime.current.bridge.active,0);
  await delay(250);assert.equal(runtime.current.bridge.pool.idle.length,2,'Selected hot models do not expire with ordinary idle leases');const warmPids=runtime.current.bridge.pool.idle.map(w=>w.child.pid).sort();
  for(const model of ['a','b']){const r=await runtime.fetch('http://proxy/v1/chat/completions',{method:'POST',body:JSON.stringify({model,messages:[{role:'user',content:'HOT_'+model}],stream:true})});assert.equal(r.status,200);await r.text();}
  await runtime.current.bridge.drain();assert.equal(requests.length,before+2);assert.ok(reports.filter(r=>r.status==='completed').every(r=>r.workerReused));assert.equal(runtime.current.bridge.pool.idle.length,2);assert.equal(new Set(runtime.current.bridge.pool.idle.map(w=>w.key)).size,2);assert.deepEqual(runtime.current.bridge.pool.idle.map(w=>w.child.pid).sort(),warmPids,'Sequential requests reuse the hot processes without launching disposable spares');
  for(let i=0;i<2;i++){const r=await runtime.fetch('http://proxy/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'c',messages:[{role:'user',content:'ROTATED_HOT_'+i}],stream:true})});assert.equal(r.status,200);await r.text();await runtime.current.bridge.drain();}
  assert.equal(requests.length,before+4);assert.deepEqual(reports.filter(r=>r.status==='completed').slice(-2).map(r=>r.workerReused),[false,true]);assert.equal(runtime.current.bridge.pool.idle.length,2);assert.equal(runtime.current.bridge.warmTargets[0],'c');assert.ok(runtime.current.bridge.pool.idle.some(w=>w.key===runtime.current.bridge.workerKey(runtime.current.bridge.acceptedModels.c)),'A new model replaces an old hot target and can be reused');
  await runtime.stopGateway();assert.equal(runtime.current.bridge.pool.protectedKeys.size,0);assert.equal(runtime.current.bridge.warmTargets.length,0);
 }finally{await runtime.close();}assert.equal(runtime.current.bridge.pool.workers.size,0);
});

test('hotpath: protocol terminal events do not wait for reset and next requests never reuse a dirty lease', {timeout:90000}, async()=>{
 const runtime=new ProxyRuntime({file:path.join(home,'hot-cleanup.json'),settings:{...options,onFailure:undefined,workerReuse:true,discoverModels:false,host:'127.0.0.1',port:0,models:{a:{model:'fixture-api/mock',context:100000,output:1000}},modelOverrides:{},apiKeys:[]}}),originalFetch=globalThis.fetch;
 let held;
 try{
  await runtime.startGateway();await runtime.warmup;await runtime.current.bridge.drain();runtime.current.bridge.pauseWarmup();
  for(const protocol of ['chat','responses','anthropic']){
   const entered=Promise.withResolvers(),release=Promise.withResolvers();held=release;let armed=true;
   globalThis.fetch=async(url,init)=>{const result=await originalFetch(url,init);if(armed&&String(url).endsWith('/global/dispose')){armed=false;entered.resolve();await release.promise;}return result;};
   const before=requests.length,route='http://proxy/v1/'+({chat:'chat/completions',responses:'responses',anthropic:'messages'}[protocol]);
   const send=marker=>runtime.fetch(route,{method:'POST',body:JSON.stringify({model:'a',stream:true,...(protocol==='responses'?{input:marker}:{messages:[{role:'user',content:marker}],...(protocol==='anthropic'?{max_tokens:100}:{})})})});
   const first=await send('CLEAN_FIRST_'+protocol);assert.equal(first.status,200);const text=await Promise.race([first.text(),delay(3000).then(()=>{throw new Error('Terminal waited for resource cleanup');})]);assert.ok(text.includes(protocol==='chat'?'[DONE]':protocol==='responses'?'response.completed':'message_stop'));
   await Promise.race([entered.promise,delay(1000).then(()=>{throw new Error('Reset did not begin');})]);assert.equal(runtime.current.bridge.pool.idle.length,0);assert.equal(runtime.current.bridge.active,0);
   let accepted=false;const next=send('CLEAN_NEXT_'+protocol).then(r=>{accepted=true;return r;});await delay(60);assert.equal(accepted,false);assert.equal(requests.length,before+1,'A resetting process is not available for inference');release.resolve();const response=await next;assert.equal(response.status,200);assert.equal(response.headers.get('x-opencode-worker-reused'),'true');await response.text();await runtime.current.bridge.drain();assert.equal(requests.length,before+2);assert.equal(requests.at(-1).body.messages.filter(m=>m.role==='user').at(-1).content,'CLEAN_NEXT_'+protocol);globalThis.fetch=originalFetch;
  }
 }finally{held?.resolve();globalThis.fetch=originalFetch;await runtime.close();}
});

test('managed20: packaged server uses real global OpenCode, aliases, defaults and three protocols without persistent request tracking', {timeout:90000}, async t=>{
  if(!process.env.TEST_PACKAGED_PROXY){t.skip('Set TEST_PACKAGED_PROXY to validate the packaged server.');return;}
  const file=path.join(home,'managed-config.json');
  await writeFile(file,JSON.stringify({mode:'global',command,workingDirectory,host:'127.0.0.1',port:0,timeoutMs:0,workerReuse:true,diagnostics:false,apiKeys:[{id:'managed-key',name:'测试客户端',key:'fixture-client-access-key',enabled:true}],modelOverrides:{'fixture-api/mock':{alias:'desktop-model',defaults:{temperature:0.4,max_tokens:100}}}}));
  let child,exited,base;
  const launch=async()=>{
    child=spawn(process.env.TEST_PACKAGED_PROXY,['--config',file,'--admin-port','0'],{env:{...process.env,OPENCODE_PROXY_ADMIN_KEY:'fixture-admin-access-key'},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',stderr='';child.stderr.on('data',data=>{stderr+=data;});
    exited=new Promise(resolve=>child.once('exit',resolve));
    base=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Packaged server startup timed out: '+stderr)),10000);
      child.once('error',reject);child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Packaged server exited: '+stderr));});
      child.stdout.on('data',data=>{output+=data;const line=output.split(/\r?\n/).find(l=>l.startsWith('OPENCODE_PROXY_READY '));if(line){clearTimeout(timeout);resolve(JSON.parse(line.slice('OPENCODE_PROXY_READY '.length)).adminURL);}});
    });
  };
  const admin=(route,method='GET',body)=>fetch(base+route,{method,headers:{authorization:'Bearer fixture-admin-access-key','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const stop=async()=>{if(!child)return;const current=child;let timer;await admin('/admin/shutdown','POST',{}).catch(()=>{});try{await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{current.kill();resolve();},5000);})]);}finally{clearTimeout(timer);child=undefined;}};
  try{
    await launch();
    const models=await(await admin('/admin/models')).json();assert.ok(models.models.some(m=>m.id==='desktop-model'),JSON.stringify(models));
    const state=await(await admin('/admin/state')).json();assert.equal(state.running,true);
    const tools=['weather','clock'].map(name=>({type:'function',function:{name,parameters:{type:'object',properties:{city:{type:'string'}}}}}));
    const body={model:'desktop-model',messages:[{role:'system',content:'CLIENT_FULL_PROMPT_SENTINEL'},{role:'user',content:'Call tools'}],stream:true,tools};
    const response=await fetch(state.endpoint+'/chat/completions',{method:'POST',headers:{authorization:'Bearer fixture-client-access-key','content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200);const text=await response.text();assert.match(text,/tool_calls/);assert.match(text,/北京/);
    const final=await(await admin('/admin/state')).json();assert.equal('statistics' in final,false);
    assert.equal(requests.at(-1).body.temperature,0.4);assert.equal(requests.at(-1).auth,'Bearer fixture-saved-api-key');
    assert.equal(await readFile(path.join(home,'statistics.json'),'utf8').catch(()=>null),null);
    assert.equal((await admin('/admin/request/removed')).status,404);
    const thoughtReply=await fetch(state.endpoint+'/messages',{method:'POST',headers:{'x-api-key':'fixture-client-access-key','content-type':'application/json'},body:JSON.stringify({model:'desktop-model',max_tokens:100,stream:true,messages:[{role:'user',content:'AUDIT_REASONING'}]})});assert.equal(thoughtReply.status,200);const thoughtEvents=await Array.fromAsync(sseEvents(thoughtReply.body));assert.equal(thoughtEvents.filter(e=>e.delta?.type==='thinking_delta').map(e=>e.delta.thinking).join(''),'思考中。');assert.equal(thoughtEvents.find(e=>e.type==='content_block_start'&&e.content_block.type==='thinking').content_block.signature,'');
    const dsmlTools=[{name:'run_code',input_schema:{type:'object',properties:{code:{type:'string'},description:{type:'string'}},required:['code','description'],additionalProperties:false}}];
    const dsml=await fetch(state.endpoint+'/messages',{method:'POST',headers:{'x-api-key':'fixture-client-access-key','anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:'desktop-model',max_tokens:100,stream:true,tools:dsmlTools,messages:[{role:'user',content:'GLOBAL_DSML_RECOVERY'}]})});
    assert.equal(dsml.status,200);const dsmlEvents=await Array.fromAsync(sseEvents(dsml.body));assert.ok(!JSON.stringify(dsmlEvents).includes('DSML'));assert.equal(dsmlEvents.find(e=>e.type==='message_delta').delta.stop_reason,'tool_use');const dsmlCall=dsmlEvents.find(e=>e.type==='content_block_start'&&e.content_block.type==='tool_use');assert.equal(dsmlCall.content_block.name,'run_code');assert.equal(JSON.parse(dsmlEvents.filter(e=>e.index===dsmlCall.index&&e.delta?.type==='input_json_delta').map(e=>e.delta.partial_json).join('')).code,dsmlCode);
    for(const protocol of ['responses','anthropic']){
      const externalTools=tools.map(t=>protocol==='responses'?{type:'function',...t.function}:{name:t.function.name,input_schema:t.function.parameters});
      const firstBody={model:'desktop-model',stream:true,tools:externalTools,...(protocol==='responses'?{input:'Call tools',instructions:'PROTOCOL_SYSTEM_SENTINEL',store:false}:{max_tokens:100,system:'PROTOCOL_SYSTEM_SENTINEL',messages:[{role:'user',content:'Call tools'}]})};
      const route=protocol==='responses'?'/responses':'/messages';
      const headers={'content-type':'application/json',...(protocol==='responses'?{authorization:'Bearer fixture-client-access-key'}:{'x-api-key':'fixture-client-access-key','anthropic-version':'2023-06-01'})};
      const reply=await fetch(state.endpoint+route,{method:'POST',headers,body:JSON.stringify(firstBody)});assert.equal(reply.status,200,await(reply.status===200?Promise.resolve(''):reply.text()));
      const events=await Array.fromAsync(sseEvents(reply.body));assert.equal(events.some(e=>e.type==='error'),false,JSON.stringify(events));
      let continuation;
      if(protocol==='responses'){
        const completed=events.at(-1);assert.equal(completed.type,'response.completed');const calls=completed.response.output.filter(i=>i.type==='function_call');assert.equal(calls.length,2);assert.equal(JSON.parse(calls[0].arguments).city,'北京');
        continuation={model:'desktop-model',tools:externalTools,store:false,instructions:'PROTOCOL_SYSTEM_SENTINEL',input:[{role:'user',content:'Call tools'},...completed.response.output,...calls.toReversed().map(c=>({type:'function_call_output',call_id:c.call_id,output:'sunny'}))]};
      }else{
        assert.equal(events.at(-1).type,'message_stop');const calls=events.filter(e=>e.type==='content_block_start'&&e.content_block.type==='tool_use').map(e=>({...e.content_block,input:JSON.parse(events.filter(d=>d.index===e.index&&d.type==='content_block_delta').map(d=>d.delta.partial_json??'').join(''))}));assert.equal(calls.length,2);assert.equal(calls[0].input.city,'北京');
        continuation={model:'desktop-model',max_tokens:100,tools:externalTools,system:'PROTOCOL_SYSTEM_SENTINEL',messages:[{role:'user',content:'Call tools'},{role:'assistant',content:calls},{role:'user',content:calls.toReversed().map(c=>({type:'tool_result',tool_use_id:c.id,content:'sunny'}))}]};
      }
      const next=await fetch(state.endpoint+route,{method:'POST',headers,body:JSON.stringify(continuation)});assert.equal(next.status,200);const answer=await next.json();assert.match(JSON.stringify(answer),/全局 OpenCode/);assert.equal(requests.at(-1).body.messages.filter(m=>m.role==='tool').length,2);assert.ok(requests.at(-1).body.messages.some(m=>m.role==='system'&&m.content.includes('PROTOCOL_SYSTEM_SENTINEL')));
    }
    const preference=await admin('/admin/model','POST',{target:'fixture-api/native-variants',patch:{defaults:{reasoning_effort:'high'}}});assert.equal(preference.status,200);
    const advanced=await fetch(state.endpoint+'/responses',{method:'POST',headers:{authorization:'Bearer fixture-client-access-key','content-type':'application/json'},body:JSON.stringify({model:'desktop-model',input:'GLOBAL_ADVANCED_TOOLS',tools:advancedTools,stream:true})});assert.equal(advanced.status,200);
    const advancedEvents=await Array.fromAsync(sseEvents(advanced.body)),advancedOutput=advancedEvents.at(-1).response.output;assert.equal(advancedEvents.at(-1).type,'response.completed');assert.equal(advancedOutput[0].namespace,'crm');assert.equal(advancedOutput[0].name,'lookup');assert.equal(advancedOutput[1].type,'custom_tool_call');assert.equal(advancedOutput[1].input,'print("北京🙂")\n');
    const advancedImage='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yS7cAAAAASUVORK5CYII=';
    const advancedInput=[{role:'user',content:'GLOBAL_ADVANCED_TOOLS'},...advancedOutput,...advancedOutput.toReversed().map(c=>({type:c.type==='custom_tool_call'?'custom_tool_call_output':'function_call_output',call_id:c.call_id,output:[{type:'input_image',image_url:advancedImage}]}))];
    const advancedNext=await fetch(state.endpoint+'/responses',{method:'POST',headers:{authorization:'Bearer fixture-client-access-key','content-type':'application/json'},body:JSON.stringify({model:'desktop-model',input:advancedInput,tools:advancedTools})});assert.equal(advancedNext.status,200);assert.match(JSON.stringify(await advancedNext.json()),/ADVANCED_OK/);assert.equal(requests.at(-1).body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url'&&p.image_url.url===advancedImage).length,2);
    const sendEffort=async effort=>{const body={model:'native-variants',messages:[{role:'user',content:'Hello'}],...(effort?{reasoning_effort:effort}:{})};const reply=await fetch(state.endpoint+'/chat/completions',{method:'POST',headers:{authorization:'Bearer fixture-client-access-key','content-type':'application/json'},body:JSON.stringify(body)});assert.equal(reply.status,200,await(reply.status===200?Promise.resolve(''):reply.text()));await reply.text();};
    await sendEffort();assert.equal(requests.at(-1).body.reasoning_effort,'high');assert.deepEqual(requests.at(-1).body.fixture_nested,{keep:'base',choose:'native-high'});await sendEffort('low');assert.equal(requests.at(-1).body.reasoning_effort,'low');
    const customMapping={high:{reasoningEffort:'max',fixture_nested:{choose:'custom-high'}}};
    assert.equal((await admin('/admin/model','POST',{target:'fixture-api/native-variants',patch:{reasoningVariants:customMapping}})).status,200);
    for(const [route,body] of [['chat/completions',{model:'native-variants',messages:[{role:'user',content:'Custom reasoning'}]}],['responses',{model:'native-variants',input:'Custom reasoning',reasoning:{effort:'high'}}],['messages',{model:'native-variants',max_tokens:100,messages:[{role:'user',content:'Custom reasoning'}],thinking:{type:'enabled'},output_config:{effort:'high'}}]]){
      const reply=await fetch(state.endpoint+'/'+route,{method:'POST',headers:{authorization:'Bearer fixture-client-access-key','content-type':'application/json'},body:JSON.stringify(body)});assert.equal(reply.status,200,reply.status===200?'':await reply.text());await reply.text();assert.equal(requests.at(-1).body.reasoning_effort,'max');assert.deepEqual(requests.at(-1).body.fixture_nested,{keep:'base',choose:'custom-high'});
    }
    assert.equal((await admin('/admin/model','POST',{target:'fixture-api/mock',patch:{enabled:false}})).status,200);
    const apiModels=await(await fetch(state.endpoint+'/models',{headers:{authorization:'Bearer fixture-client-access-key'}})).json();assert.equal(apiModels.data.some(m=>m.id==='desktop-model'),false);const hiddenAdmin=(await(await admin('/admin/models')).json()).models.find(m=>m.target==='fixture-api/mock');assert.equal(hiddenAdmin.enabled,false);
    const callsBefore=requests.length;
    for(const [route,body] of [['chat/completions',{model:'desktop-model',messages:[{role:'user',content:'blocked'}]}],['responses',{model:'fixture-api/mock',input:'blocked'}],['messages',{model:'desktop-model',max_tokens:100,messages:[{role:'user',content:'blocked'}]}]]){const reply=await fetch(state.endpoint+'/'+route,{method:'POST',headers:{authorization:'Bearer fixture-client-access-key','content-type':'application/json'},body:JSON.stringify(body)});assert.equal(reply.status,403);await reply.text();}
    assert.equal(requests.length,callsBefore,'Disabled model requests never reach OpenCode inference');
    const selectedPreset={type:'effort',levels:['high','max']};assert.equal((await admin('/admin/model','POST',{target:'fixture-api/native-variants',patch:{reasoningPreset:selectedPreset,reasoningVariants:null,defaults:{reasoning_effort:'max'}}})).status,200);await sendEffort();assert.equal(requests.at(-1).body.reasoning_effort,'max');
    await stop();await launch();const restarted=await(await admin('/admin/state')).json();assert.equal('statistics' in restarted,false);assert.equal(restarted.settings.modelOverrides['fixture-api/mock'].enabled,false);assert.equal(restarted.settings.modelOverrides['fixture-api/native-variants'].defaults.reasoning_effort,'max');assert.deepEqual(restarted.settings.modelOverrides['fixture-api/native-variants'].reasoningPreset,selectedPreset);assert.equal(restarted.settings.modelOverrides['fixture-api/native-variants'].reasoningVariants,undefined);assert.equal((await admin('/admin/model','POST',{target:'fixture-api/mock',patch:{enabled:true}})).status,200);
  }finally{await stop();}
});
