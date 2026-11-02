import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, cp, readFile, stat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { executableCommand } from './command.mjs';
import { ApiError, validateRequest, nativeToolName, toolPermissions, usageOf, sseEvents } from './protocol.mjs';
import { publicReasoning, validateReasoningVariants } from './reasoning.mjs';
import { modelCatalog } from './models.mjs';
import { workerConfig } from './config.mjs';
import { RequestLifecycle } from './lifecycle.mjs';
import { WorkerPool } from './pool.mjs';
import { bufferEvents } from './events.mjs';
import {upstreamError,retryError} from './upstream-errors.mjs';
import {nativeGeneration,CAPTURE_TOOL} from './generation.mjs';
import {compileSchema,assertSchema} from './schema.mjs';
import {workerStartupGate} from './startup-gate.mjs';
import {ToolTextRecovery} from './dsml-tools.mjs';
import {SharedProcesses,disposalEvents} from './shared-processes.mjs';
import {sharedContract,mcpToolDefinitions,contractHash} from './shared-contract.mjs';
import {sessionPath} from './shared-sessions.mjs';

const reusedHeader = run => !!run.reused;
const timingHeader = run => {
  const t = run.lifecycle.timings;
  return Object.entries({ catalog: t.catalogMs, preparation: t.inference, first_output: t.firstModelEvent === undefined ? undefined : t.firstModelEvent - t.inference }).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => k + ';dur=' + Math.max(0, v)).join(', ');
};

const SDK = { 'openai-chat': '@ai-sdk/openai-compatible', 'openai-responses': '@ai-sdk/openai', anthropic: '@ai-sdk/anthropic' };
const delay = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

export function normalizeConfig(input, directory = process.cwd()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('Bridge configuration must be an object.', 500);
  const mode = input.mode ?? 'isolated';
  if (!['isolated', 'global'].includes(mode)) throw new ApiError('mode must be global or isolated.', 500);
  const configuredCommand = input.command ?? ['opencode'];
  if (!Array.isArray(configuredCommand) || !configuredCommand.length || configuredCommand.some(x => typeof x !== 'string' || !x)) throw new ApiError('command must be an executable and optional argument array.', 500);
  const command = [...configuredCommand];
  if (command[0].includes('/') || command[0].includes('\\')) command[0] = path.resolve(directory, command[0]);
  if (input.workingDirectory !== undefined && (typeof input.workingDirectory !== 'string' || !input.workingDirectory.trim() || input.workingDirectory.includes('\0'))) throw new ApiError('workingDirectory must be a nonempty directory path.', 500, 'workingDirectory');
  const models = input.models ?? (mode === 'global' ? { 'oc-default': { name: 'OpenCode default model', context: 128000, output: 16384 } } : undefined);
  if (!models || Array.isArray(models) || typeof models !== 'object' || !Object.keys(models).length) throw new ApiError('Configure at least one model.', 500);
  for (const [alias, model] of Object.entries(models)) {
    if (!alias || !model || typeof model !== 'object' || Array.isArray(model)) throw new ApiError('Each model must be an object.', 500);
    if(model.reasoningVariants!==undefined)validateReasoningVariants(model.reasoningVariants);
    if (mode === 'global') {
      if (['id', 'protocol', 'baseURL', 'apiKeyEnv'].some(k => model[k] !== undefined)) throw new ApiError('Global mode uses OpenCode credentials and providers; use model="provider/model" only to select a model.', 500);
      if (model.model !== undefined && (typeof model.model !== 'string' || !/^[^/\s]+\/\S+$/.test(model.model))) throw new ApiError('Global model must be provider/model, or omitted for the OpenCode default.', 500);
    } else {
      if (typeof model.id !== 'string' || !model.id || !Object.hasOwn(SDK, model.protocol)) throw new ApiError('Each isolated model needs id and protocol (openai-chat, openai-responses, anthropic).', 500);
      let url;
      try { url = new URL(model.baseURL); } catch { throw new ApiError('Each model needs an absolute upstream baseURL.', 500); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ApiError('Invalid upstream baseURL.', 500);
      if (model.apiKeyEnv !== undefined && (typeof model.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv))) throw new ApiError('apiKeyEnv must name an environment variable.', 500);
    }
    for (const key of ['context', 'output']) if (!Number.isInteger(model[key]) || model[key] <= 0) throw new ApiError('Each model needs positive integer context and output limits.', 500);
  }
  const config = { ...input, mode, command: [...command], models, discoverModels: input.discoverModels ?? (mode === 'global' && input.models === undefined), maxConcurrent: input.maxConcurrent ?? 0, timeoutMs: input.timeoutMs ?? 0, startupTimeoutMs: input.startupTimeoutMs ?? 30000, firstOutputTimeoutMs: input.firstOutputTimeoutMs ?? 120000, idleTimeoutMs: input.idleTimeoutMs ?? 180000, workerReuse: input.workerReuse ?? true, maxIdleWorkers: input.maxIdleWorkers ?? 2, workerIdleMs: input.workerIdleMs ?? 60000, diagnostics: input.diagnostics ?? true };
  if (input.workingDirectory !== undefined) config.workingDirectory = path.resolve(directory, input.workingDirectory);
  config.modelIdStyle = input.modelIdStyle ?? 'short';
  config.workerSharing = input.workerSharing ?? false;
  if (typeof config.workerSharing !== 'boolean') throw new ApiError('workerSharing must be boolean.', 500);
  if(config.workerSharing&&!config.workingDirectory)throw new ApiError('共享模式必须配置真实工作目录。',400,'workingDirectory','opencode_working_directory');
  if (!['short', 'qualified'].includes(config.modelIdStyle)) throw new ApiError('modelIdStyle must be short or qualified.', 500);
  if (typeof config.discoverModels !== 'boolean' || (config.discoverModels && mode !== 'global')) throw new ApiError('discoverModels must be a boolean and is available only in global mode.', 500);
  if (!Number.isSafeInteger(config.maxConcurrent) || config.maxConcurrent < 0) throw new ApiError('maxConcurrent must be a nonnegative integer; 0 means unlimited.', 500);
  for (const key of ['startupTimeoutMs', 'firstOutputTimeoutMs', 'idleTimeoutMs', 'workerIdleMs']) if (!Number.isInteger(config[key]) || config[key] <= 0) throw new ApiError(`${key} must be a positive integer.`, 500);
  for (const key of ['timeoutMs', 'maxIdleWorkers']) if (!Number.isSafeInteger(config[key]) || config[key] < 0) throw new ApiError(key + ' must be a nonnegative integer.', 500);
  for (const key of ['workerReuse', 'diagnostics']) if (typeof config[key] !== 'boolean') throw new ApiError(key + ' must be boolean.', 500);
  config.warmupModels = input.warmupModels ?? [];
  if (Object.hasOwn(input,'channels')) throw new ApiError('Upstream channels have been removed; configure providers in local OpenCode.',400,'channels','unsupported_configuration');
  if (!Array.isArray(config.warmupModels) || config.warmupModels.some(m => typeof m !== 'string' || !m)) throw new ApiError('warmupModels must be an array of model IDs.', 500);
  return config;
}

async function workerDirectory(config, temporary) {
  if (config.workingDirectory !== undefined) {
    const directory = config.workingDirectory;
    const info = await stat(directory).catch(error => {
      throw new ApiError(`OpenCode workingDirectory is unavailable (${error.code}): ${directory}`, 503, 'workingDirectory', 'opencode_working_directory');
    });
    if (!info.isDirectory()) throw new ApiError(`OpenCode workingDirectory is not a directory: ${directory}`, 503, 'workingDirectory', 'opencode_working_directory');
    return directory;
  }
  const directory = path.join(temporary, 'workspace');
  await mkdir(directory);
  return directory;
}

function sandboxEnv(home) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'COMSPEC', 'PATHEXT', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'OPENCODE_GIT_BASH_PATH']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
    TMP: home, TEMP: home, TMPDIR: home,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENCODE_EXPERIMENTAL_NATIVE_LLM: '0',
  });
  return env;
}

function globalEnv(home) {
  return {
    ...process.env,
    // Preserve HOME, XDG paths and authentication plugins. Isolate API sessions,
    // while refreshes remain owned by OpenCode in its genuine shared auth store.
    OPENCODE_DB: path.join(home, 'opencode.sqlite'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '0', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENCODE_EXPERIMENTAL_NATIVE_LLM: '0',
  };
}

async function seedPluginDependency(home) {
  // OpenCode installs its plugin SDK when it sees a plugin, even one with no imports.
  // Seed a genuine SDK cache. OpenCode may select its own matching SDK version;
  // this dependency's version never gates the configured executable.
  const entry = fileURLToPath(import.meta.resolve('@opencode-ai/plugin'));
  const source = process.env.TEST_OPENCODE_PLUGIN_DIR ?? path.resolve(path.dirname(entry), '..');
  const manifest = JSON.parse((await readFile(path.join(source, 'package.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const dir = path.join(home, 'config', 'opencode');
  const scoped = path.join(dir, 'node_modules', '@opencode-ai');
  await mkdir(scoped, { recursive: true });
  const target = path.join(scoped, 'plugin');
  // Copy instead of linking: another runtime can update its sandbox SDK safely.
  await cp(source, target, { recursive: true });
  const dependencies = { '@opencode-ai/plugin': manifest.version };
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies }));
  await writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies }, 'node_modules/@opencode-ai/plugin': { version: manifest.version } } }));
}

function start(command, args, options) {
  const child = spawn(command[0], [...command.slice(1), ...args], { ...options, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let error;
  let exited = false;
  let output = '';
  const collect = (c) => { output = (output + c.toString()).slice(-16000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', e => { error = e; });
  // A Bun subprocess can exit before all inherited handles close on Windows.
  // Wait for its exit, not a pipe's close, and explicitly destroy our read handles.
  const done = new Promise(resolve => {
    child.once('error', () => resolve({ code: null, error, output }));
    child.once('exit', code => { exited = true; child.stdout.destroy(); child.stderr.destroy(); resolve({ code, error, output }); });
  });
  return { child, done, get exited() { return exited; }, get error() { return error; }, get output() { return output; } };
}

async function stop(process) {
  if (!process || process.exited || process.child.exitCode !== null || process.error) return;
  process.child.kill();
  let timer;
  const ended = await Promise.race([process.done.then(() => true), new Promise(r => { timer = setTimeout(() => r(false), 2000); })]);
  clearTimeout(timer);
  if (!ended) { process.child.kill('SIGKILL'); await process.done; }
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(r => server.close(r));
  return port;
}

async function discoverGlobalModels(config, callerSignal) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'opencode-proxy-models-'));
  let worker;
  const timeout = AbortSignal.timeout(config.startupTimeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const directory = await workerDirectory(config, home);
    const command = await executableCommand(config.command);
    const port = await freePort();
    const password = randomBytes(24).toString('hex');
    const watcher = pathToFileURL(fileURLToPath(new URL('./parent-watch.mjs', import.meta.url))).href;
    const content = workerConfig(process.env.OPENCODE_CONFIG_CONTENT, { plugin: [watcher] });
    worker = start(command, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { env: {
      ...globalEnv(home), OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_PROXY_PARENT_PID: String(process.pid), OPENCODE_CONFIG_CONTENT: JSON.stringify(content),
    }, cwd: directory, signal });
    const headers = { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') };
    const base = 'http://127.0.0.1:' + port;
    while (true) {
      signal.throwIfAborted();
      if (worker.error || worker.exited || worker.child.exitCode !== null) throw new ApiError('OpenCode exited while discovering models.', 503, null, 'opencode_startup');
      try {
        const health = await fetch(base + '/global/health', { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
        if (health.ok) break;
      } catch { signal.throwIfAborted(); }
      await delay(100, signal);
    }
    const response = await fetch(base + '/provider', { headers, signal });
    if (!response.ok) throw new ApiError(`OpenCode model discovery returned HTTP ${response.status}.`, 503, null, 'opencode_models');
    const catalog = await response.json();
    if (!Array.isArray(catalog.all) || !Array.isArray(catalog.connected)) throw new ApiError('OpenCode did not return a compatible provider catalog.', 503, null, 'opencode_models');
    const connected = new Set(catalog.connected);
    const models = {};
    const limit = (value, fallback) => Number.isInteger(value) && value > 0 ? value : fallback;
    // Copy public model selection and limits only; no provider credentials,
    // endpoints, options or headers become gateway metadata or bridge config.
    for (const provider of catalog.all) {
      if (!connected.has(provider.id) || ['magpie', 'opencode-proxy', 'opencode-bridge'].includes(provider.id)) continue;
      for (const [id, model] of Object.entries(provider.models ?? {})) {
        const alias = provider.id + '/' + id;
        if (!/^[^/\s]+\/\S+$/.test(alias) || model.capabilities?.output?.text === false || model.capabilities?.input?.text === false) continue;
        models[alias] = { model: alias, name: model.name || id, context: limit(model.limit?.context, 128000), output: limit(model.limit?.output, 16384), temperature: model.capabilities?.temperature !== false, toolcall: model.capabilities?.toolcall !== false, inputModalities:Object.entries(model.capabilities?.input??{text:true}).filter(([,value])=>value===true).map(([key])=>key), ...publicReasoning(model) };
      }
    }
    return models;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('OpenCode model discovery failed or timed out. Check the global program and its provider catalog.', 503, null, 'opencode_models');
  } finally {
    await stop(worker);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function mcpServer(body, token, fixedTools) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url !== '/' + token) return res.writeHead(404).end();
      if (req.method !== 'POST') return res.writeHead(405).end();
      const buffers = [];
      let size = 0;
      for await (const b of req) {
        size += b.length;
        if (size > 4 * 1024 * 1024) return res.writeHead(413).end();
        buffers.push(b);
      }
      const rpc = JSON.parse(Buffer.concat(buffers).toString('utf8'));
      if (!Object.hasOwn(rpc, 'id')) return res.writeHead(202).end();
      let result;
      switch (rpc.method) {
        case 'initialize':
          result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'opencode-proxy', version: '0.1.0' } };
          break;
        case 'ping': result = {}; break;
        case 'tools/list':
          result = { tools: fixedTools??mcpToolDefinitions(body) };
          break;
        case 'tools/call':
          // Acknowledge deferral only. No client function runs here. This lets
          // the standard SDK publish finish-step for every provider; the public
          // message hook prevents a second inference step.
          result = { content: [{ type: 'text', text: 'Tool execution deferred to the API client.' }], isError: false };
          break;
        default:
          return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  server.setTools = next => { body = next; };
  return server;
}

export class OpenCodeBridge {
  constructor(config) {
    this.config = normalizeConfig(config);
    this.configuredModels = { ...this.config.models };
    this.acceptedModels = this.config.models;
    this.active = 0;
    this.pool = new WorkerPool(this.config);
    this.shared = new SharedProcesses(this.config, key => this.pool.protectedKeys.has(this.shared.entries.get(key)?.baseKey));
    this.controllers = new Set();
    this.background = new Set();
    this.warmTargets = [];
    this.warmFailures = new Map();
  }
  track(task) {
    this.background.add(task);task.then(()=>this.background.delete(task),()=>this.background.delete(task));return task;
  }
  async drain() { while(this.background.size)await Promise.allSettled([...this.background]); }
  pauseWarmup(){this.warmEpoch=(this.warmEpoch??0)+1;this.warmTargets=[];this.pool.protectedKeys.clear();}
  touchHotModel(id){
    if(!this.warmTargets.length)return;
    const key=this.workerKey(this.acceptedModels[id]);
    this.warmTargets=[id,...this.warmTargets.filter(other=>this.workerKey(this.acceptedModels[other])!==key)].slice(0,this.config.maxIdleWorkers);
    this.pool.protectedKeys=new Set(this.warmTargets.map(model=>this.workerKey(this.acceptedModels[model])));
  }
  workerKey(model,upstreamKey) {
    const global=this.config.mode==='global';
    return createHash('sha256').update(JSON.stringify({model,global,upstreamKey:global?undefined:upstreamKey,command:this.config.command,cwd:this.config.workingDirectory,env:process.env})).digest('hex');
  }
  sharedKey(model,body,upstreamKey,directory=this.config.workingDirectory){
    return contractHash({base:this.workerKey(model,upstreamKey),directory,contract:sharedContract(body).hash});
  }
  async close() {
    this.closed = true;
    this.pauseWarmup();
    for (const controller of this.controllers) controller.abort(new ApiError('Bridge is shutting down.', 503, null, 'bridge_shutdown'));
    await this.drain();
    await this.pool.close();
    await this.shared.close();
  }
  async prewarm(models=this.config.warmupModels) {
    if (this.closed||this.config.mode !== 'global' || !this.config.workerReuse || !this.config.maxIdleWorkers) return;
    const epoch=this.warmEpoch;
    await this.loadModels();
    if(this.closed||epoch!==this.warmEpoch)return;
    const keys=new Set();this.warmTargets=[...new Set(models)].filter(id=>{const model=this.acceptedModels[id];if(!model||model.enabled===false)return false;const key=this.workerKey(model);if(keys.has(key))return false;keys.add(key);return true;}).slice(0,this.config.maxIdleWorkers);
    this.pool.protectedKeys=new Set(this.warmTargets.map(id=>this.workerKey(this.acceptedModels[id])));
    await this.replenish();
  }
  async replenish() {
    if(this.closed)return;
    this.pool.protectedKeys=new Set(this.warmTargets.map(id=>this.workerKey(this.acceptedModels[id])));
    const tasks=[];
    for(const model of this.warmTargets){
      const key=this.workerKey(this.acceptedModels[model]);
      if(this.config.workerSharing&&[...this.shared.entries.values()].some(entry=>entry.baseKey===key))continue;
      // Busy and resetting leases already cover this target. Starting a spare
      // for every short request would create a process only to evict it again.
      if([...this.pool.workers].some(w=>w.key===key&&!this.pool.disposing.has(w)&&!w.worker.error&&!w.worker.exited&&w.child.exitCode===null)||this.pool.pending(key)||(this.warmFailures.get(key)??0)>Date.now())continue;
      const task=Promise.resolve().then(()=>this.prepare({model,messages:[{role:'user',content:'Warm worker without inference.'}]},undefined,undefined,true)).catch(error=>{this.warmFailures.set(key,Date.now()+30000);throw error;});
      this.pool.offer(key,task);this.track(task);tasks.push(task);
    }
    await Promise.allSettled(tasks);
  }
  async loadModels(refresh = false) {
    if (this.closed) throw new ApiError('Bridge is shutting down.', 503, null, 'bridge_shutdown');
    if (!this.config.discoverModels) return this.config.models;
    if (this.catalogPending) return this.catalogPending;
    if (refresh) this.catalog = undefined;
    if (this.catalog) return this.catalog;
    const controller = new AbortController();
    this.controllers.add(controller);
    const task = discoverGlobalModels(this.config, controller.signal).then(models => {
      controller.signal.throwIfAborted();
      const catalog = modelCatalog(models, this.configuredModels, this.config.modelIdStyle);
      this.config.models = catalog.models;
      this.acceptedModels = catalog.accepted;
      return this.config.models;
    });
    this.catalog = this.catalogPending = this.track(task);
    const settled = () => { this.controllers.delete(controller); this.catalogPending = undefined; };
    task.then(settled, () => { settled(); this.catalog = undefined; });
    return this.catalog;
  }
  async startShared(model, upstreamKey, signal, contract, directory) {
    const startup = AbortSignal.any([signal, AbortSignal.timeout(this.config.startupTimeoutMs)]);
    const release = await workerStartupGate.acquire(startup);
    let home, worker, events, mcp;
    const watch = new AbortController();
    let sharedProcess;
    const dispose = async () => {
      if(sharedProcess?.instanceTouched&&events&&!events.failed&&!worker.exited&&worker.child.exitCode===null){
        await events.dispose(directory,async()=>{
          const response=await fetch(sharedProcess.base+'/instance/dispose',{method:'POST',headers:sharedProcess.headers,body:'{}',signal:AbortSignal.timeout(5000)});
          if(!response.ok)throw new Error('OpenCode group disposal failed.');await response.arrayBuffer();
        }).catch(()=>{});
      }
      await events?.close(() => watch.abort());
      watch.abort();await stop(worker);
      if(mcp){mcp.closeAllConnections();await new Promise(resolve=>mcp.close(resolve));}
      if(home)await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:200});
    };
    try {
      home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-shared-')));
      await mkdir(path.join(home,'requests'),{mode:0o700});
      const global = this.config.mode==='global';
      if(!global)await seedPluginDependency(home);
      const env = global?globalEnv(home):sandboxEnv(home), password=randomBytes(24).toString('hex'), port=await freePort();
      const permission=contract.permission,token=randomBytes(24).toString('hex'),groupID=randomUUID();
      mcp=mcpServer(undefined,token,contract.tools);const mcpPort=await listen(mcp);
      await writeFile(path.join(home,'shared.json'),JSON.stringify({version:2,directory,groupID,contract,mcpURL:'http://127.0.0.1:'+mcpPort+'/'+token,mcpTimeout:this.config.idleTimeoutMs}),{mode:0o600});
      const overrides={
        ...(global ? (model.model?{model:model.model}:{}) : {model:'opencode-bridge/'+model.id,small_model:'opencode-bridge/'+model.id,provider:{'opencode-bridge':{name:'Bridge upstream',npm:SDK[model.protocol],options:{baseURL:model.baseURL,apiKey:upstreamKey},models:{[model.id]:{name:model.id,temperature:true,limit:{context:model.context,output:model.output}}}}}}),
        permission,snapshot:false,autoupdate:false,share:'disabled',
        plugin:[pathToFileURL(this.config.workerPluginPath??fileURLToPath(new URL('./worker-plugin.mjs',import.meta.url))).href],
        agent:{bridge:{mode:'primary',prompt:'Follow the client instructions.',permission},title:{disable:true}},
      };
      Object.assign(env,{OPENCODE_CONFIG_CONTENT:JSON.stringify(workerConfig(env.OPENCODE_CONFIG_CONTENT,overrides)),OPENCODE_SERVER_PASSWORD:password,OPENCODE_PROXY_SHARED_ROOT:home,OPENCODE_PROXY_PARENT_PID:String(process.pid)});
      delete env.OPENCODE_PROXY_REQUEST;
      worker=start(await executableCommand(this.config.command),['serve','--hostname','127.0.0.1','--port',String(port)],{env,cwd:directory});
      const headers={authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64'),'content-type':'application/json','x-opencode-directory':encodeURIComponent(directory)},base='http://127.0.0.1:'+port;
      let version;
      while(true){
        startup.throwIfAborted();
        if(worker.error||worker.exited||worker.child.exitCode!==null)throw new ApiError('Shared OpenCode exited during startup.',503,null,'opencode_startup');
        try{const health=await fetch(base+'/global/health',{headers,signal:AbortSignal.any([startup,AbortSignal.timeout(1000)])});if(health.ok){version=(await health.json()).version;break;}}catch{startup.throwIfAborted();}
        await delay(100,startup);
      }
      if(typeof version!=='string'||!/^1\./.test(version))throw new ApiError('Shared instances require a compatible OpenCode 1 runtime.',503,null,'opencode_shared_unsupported');
      const connect=setTimeout(()=>watch.abort(),this.config.startupTimeoutMs);
      try{
        const response=await fetch(base+'/global/event',{headers,signal:AbortSignal.any([signal,watch.signal])});
        if(!response.ok||!response.body)throw new Error('Missing OpenCode lifecycle stream.');
        const iterator=sseEvents(response.body),first=await iterator.next();
        if(first.done||first.value.payload?.type!=='server.connected')throw new Error('Unconfirmed OpenCode lifecycle stream.');
        events=disposalEvents(iterator,()=>sharedProcess?.onFailure?.(),directory);
      }finally{clearTimeout(connect);}
      sharedProcess={home,directory,groupID,contract,worker,mcp,base,headers,version,events,dispose};
      return sharedProcess;
    }catch(error){await dispose();throw error;}
    finally{release();}
  }
  async prepare(body, apiKey, signal, warmup = false, requestId) {
    if (this.closed) throw new ApiError('Bridge is closed.', 503, null, 'bridge_shutdown');
    const catalogStart = Date.now();
    await this.loadModels();
    if(this.closed)throw new ApiError('Bridge is closed.',503,null,'bridge_shutdown');
    const catalogMs = Date.now() - catalogStart;
    validateRequest(body, this.acceptedModels);
    const generation=nativeGeneration(body);
    if(this.acceptedModels[body.model].toolcall===false&&(generation||(body.tools?.length&&body.tool_choice!=='none')))throw new ApiError('The selected OpenCode model does not advertise function-tool support.',400,generation?'response_format':'tools','unsupported_tools');
    if(generation)compileSchema(generation.format.schema);
    for(const t of body.tools??[])if(t.function.strict)compileSchema(t.function.parameters??{type:'object'},'tools');
    signal?.throwIfAborted();
    if (!warmup&&this.config.maxConcurrent > 0 && this.active >= this.config.maxConcurrent) throw new ApiError('All OpenCode workers are busy. Retry later.', 429, null, 'worker_busy');
    if(!warmup)this.touchHotModel(body.model);
    const model = this.acceptedModels[body.model];
    const global = this.config.mode === 'global';
    const upstreamKey = model.apiKeyEnv ? process.env[model.apiKeyEnv] : apiKey;
    if (!global && !upstreamKey) throw new ApiError('Upstream API key is missing. Set the configured apiKeyEnv.', 503, null, 'missing_upstream_key');
    if(!warmup)this.active++;
    let admitted=!warmup;
    const releaseAdmission=()=>{if(admitted){admitted=false;this.active--;}};
    const lifecycle = new RequestLifecycle(this.config, signal, catalogMs, requestId);
    const controller = lifecycle.controller;
    const combined = lifecycle.signal;
    this.controllers.add(controller);
    const providerID = global ? model.model?.split('/')[0] : 'opencode-bridge';
    const modelID = global ? model.model?.slice(providerID.length + 1) : model.id;
    const baseKey=this.workerKey(model,upstreamKey);
    let key=baseKey;
    let lease,sharedLease,reused=false,requestPublished=false;
    let home, mcp, worker, sessionID, eventController, requestFile, hookFile, base, headers;
    let reportedVersion,releaseStartup;
    let phase = 'creating sandbox';
    let closing, api, failure, abortCleanup, requestUsage, finishReason, aborting;
    const abortSession=()=>aborting??=api('/session/'+sessionID+'/abort',{},AbortSignal.timeout(2000));
    const cleanup = (success = false) => closing ??= (async () => {
      lifecycle.stop();
      if (abortCleanup) combined.removeEventListener('abort', abortCleanup);
      eventController?.abort();
      let retained = false;
      let recycleError;
      try {
        if (sharedLease) {
          let dirty = !success&&!sessionID;
          try {
            if(requestPublished)await writeFile(path.join(home,'closing'),'');
            if (sessionID && api) {
              await abortSession();
              const deleted = await fetch(base+'/session/'+sessionID,{method:'DELETE',headers,signal:AbortSignal.timeout(2000)});
              if(!deleted.ok)throw new Error('Shared session deletion failed.');
              await deleted.arrayBuffer();
            }
            if(requestPublished){
              const deadline=Date.now()+5000;
              while(true){
                const ack=await readFile(path.join(home,'released.json'),'utf8').then(JSON.parse,()=>undefined).catch(()=>undefined);
                if(ack?.sessionID===sessionID&&ack.requestID===lifecycle.id&&ack.groupID===sharedLease.process.groupID)break;
                if(Date.now()>=deadline)throw new Error('Shared session release was not confirmed.');
                await delay(25);
              }
            }
            if(home)await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:200});
          } catch { dirty=true;recycleError='shared_session_cleanup_failed'; }
          finally {await sharedLease.release(dirty);}
          retained=this.shared.has(key);
        } else if (success && !combined.aborted && lease && !this.closed && this.pool.reserveIdle(lease)) {
          try {
            if (sessionID && api) await abortSession();
            if (sessionID) {
              const deleted = await fetch(base + '/session/' + sessionID, { method: 'DELETE', headers, signal: AbortSignal.timeout(2000) });
              if (!deleted.ok) throw new Error('Session deletion failed');
              await deleted.arrayBuffer();
            }
            // Reset every instance-owned plugin/config/MCP cache. The next lease
            // reads a new request file and cannot reuse injected history flags.
            // Instance-scoped disposal may acknowledge before teardown. This
            // process is exclusively ours; global disposal awaits all teardown.
            await api('/global/dispose', {}, AbortSignal.timeout(5000));
            await rm(requestFile, { force: true });
            await rm(hookFile, { force: true });
            mcp.setTools({});
            await this.pool.put(lease);
            retained = this.pool.workers.has(lease);
          } catch { recycleError = 'instance_reset_failed'; await this.pool.discard(lease); }
        } else if (lease) await this.pool.discard(lease);
        else {
          await stop(worker);
          if (mcp) { mcp.closeAllConnections(); await new Promise(r => mcp.close(r)); }
          if (home) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
      } finally {
        releaseStartup?.();releaseStartup=undefined;
        releaseAdmission();
        this.controllers.delete(controller);
        const reason = failure ?? combined.reason;
        const errorCode = reason instanceof ApiError ? reason.code : combined.aborted ? 'request_cancelled' : reason ? 'opencode_error' : undefined;
        const cancelled = combined.aborted && (reason instanceof ApiError ? reason.status === 499 : !lifecycle.timeoutKind);
        const report = lifecycle.report({ model: body.model, usage: lifecycle.tokens?requestUsage??lifecycle.usage:undefined, usageKnown:!!lifecycle.tokens, tokens:lifecycle.tokens, cost:lifecycle.cost, finishReason, status: success ? warmup ? 'warmed' : 'completed' : cancelled ? 'cancelled' : 'failed', errorCode, workerReused: reused, workerRetained: retained, recycleError });
        if (this.config.diagnostics) console.error('[opencode-bridge] ' + JSON.stringify(report));
        try { await this.config.onDiagnostics?.(report); } catch {}
        if(!warmup&&this.warmTargets.length&&!this.closed)this.track(Promise.resolve().then(()=>this.replenish()));
      }
    })();
    try {
      if(this.config.workerSharing){
        phase=lifecycle.stage('shared process startup');
        const directory=await realpath(await workerDirectory(this.config));
        const contract=sharedContract(body);key=this.sharedKey(model,body,upstreamKey,directory);
        sharedLease=await this.shared.acquire(key,signal=>this.startShared(model,upstreamKey,signal,contract,directory),combined,baseKey);
        reused=sharedLease.reused;
        ({worker,base,headers}=sharedLease.process);
      } else {
      lease=this.config.workerReuse?(warmup?this.pool.take(key):await this.pool.acquire(key,combined)):undefined;reused=!!lease;
      if (lease && (lease.worker.error || lease.worker.exited || lease.child.exitCode !== null)) { await this.pool.discard(lease); lease = undefined; reused = false; }
      if (!lease) {
        phase=lifecycle.stage('worker startup queue');
        releaseStartup=await workerStartupGate.acquire(combined);
        // A queued request may outlive an earlier request's complete cleanup.
        // Recheck only ready leases, keeping unrelated cold starts unblocked.
        if (this.config.workerReuse) lease=this.pool.take(key);
        if (lease && (lease.worker.error || lease.worker.exited || lease.child.exitCode !== null)) { await this.pool.discard(lease); lease=undefined; }
        reused=!!lease;
        if (lease) { releaseStartup();releaseStartup=undefined; }
      }
      if (lease) {
        ({ home, mcp, worker, requestFile, hookFile, base, headers } = lease);
        mcp.setTools(body);
      } else {
        home = await mkdtemp(path.join(os.tmpdir(), 'opencode-proxy-'));
        phase = lifecycle.stage('working directory');
        const directory = await workerDirectory(this.config, home);
        if (!global) await seedPluginDependency(home);
        const env = global ? globalEnv(home) : sandboxEnv(home);
        delete env.OPENCODE_PROXY_SHARED_ROOT;
        const command = await executableCommand(this.config.command);
        const token = randomBytes(24).toString('hex');
        mcp = mcpServer(body, token);
        const mcpPort = await listen(mcp);
        const port = await freePort();
        const password = randomBytes(24).toString('hex');
        requestFile = path.join(home, 'request.json');
        hookFile = path.join(home, 'hooks-ready.json');
        const permissions = toolPermissions(body);
        const config = {
          ...(global
            ? (model.model ? { model: model.model } : {})
            : { model: 'opencode-bridge/' + modelID, small_model: 'opencode-bridge/' + modelID,
              provider: { 'opencode-bridge': { name: 'Bridge upstream', npm: SDK[model.protocol], options: { baseURL: model.baseURL, apiKey: upstreamKey }, models: { [modelID]: { name: modelID, temperature: true, limit: { context: model.context, output: model.output } } } } } }),
          permission: permissions, snapshot: false, autoupdate: false, share: 'disabled',
          plugin: [pathToFileURL(this.config.workerPluginPath ?? fileURLToPath(new URL('./worker-plugin.mjs', import.meta.url))).href],
          mcp: { bridge: { type: 'remote', url: 'http://127.0.0.1:' + mcpPort + '/' + token, oauth: false, timeout: this.config.idleTimeoutMs } },
          agent: { bridge: { mode: 'primary', prompt: 'Follow the client instructions.', permission: permissions }, title: { disable: true } },
        };
        Object.assign(env, { OPENCODE_CONFIG_CONTENT: JSON.stringify(workerConfig(env.OPENCODE_CONFIG_CONTENT, config)), OPENCODE_SERVER_PASSWORD: password, OPENCODE_PROXY_REQUEST: requestFile, OPENCODE_PROXY_PARENT_PID: String(process.pid) });
        // Persist before starting: global plugins can initialise with the server.
        await writeFile(requestFile, JSON.stringify({ body, modelID, providerID, outputLimit: model.output, global, hookFile, reasoningVariants:model.reasoningVariants }), { mode: 0o600 });
        combined.throwIfAborted();
        worker = start(command, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: directory });
        headers = { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'), 'content-type': 'application/json' };
        base = 'http://127.0.0.1:' + port;
        let disposed;
        const owned = { home, mcp, worker };
        lease = { key, home, mcp, worker, child: worker.child, requestFile, hookFile, base, headers,
          dispose: () => disposed ??= (async () => {
            await stop(owned.worker);
            owned.mcp.closeAllConnections(); await new Promise(r => owned.mcp.close(r));
            await rm(owned.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          })(),
        };
        this.pool.track(lease);
      }
      if (reused) await writeFile(requestFile, JSON.stringify({ body, modelID, providerID, outputLimit: model.output, global, hookFile, reasoningVariants:model.reasoningVariants }), { mode: 0o600 });
      }
      phase = lifecycle.stage('server startup');
      api = async (endpoint, payload, requestSignal = combined) => {
        const r = await fetch(base + endpoint, { headers, signal: requestSignal, ...(payload !== undefined ? { method: 'POST', body: JSON.stringify(payload) } : {}) });
        if (!r.ok) throw new ApiError('OpenCode endpoint ' + endpoint + ' returned HTTP ' + r.status + '.', 502, null, 'opencode_server_error');
        return r.status === 204 ? null : r.json();
      };
      while (true) {
        combined.throwIfAborted();
        if (worker.error || worker.exited || worker.child.exitCode !== null) throw new ApiError('OpenCode server exited during startup.', 503, null, 'opencode_startup');
        try {
          const health = await api('/global/health', undefined, AbortSignal.any([combined, AbortSignal.timeout(1000)]));
          if (typeof health.version === 'string' && /^[A-Za-z0-9._+-]{1,128}$/.test(health.version)) reportedVersion = health.version;
          break;
        } catch { await delay(100, combined); }
      }
      phase = lifecycle.stage('MCP initialization');
      if(sharedLease)sharedLease.process.instanceTouched=true;
      const status = await api('/mcp');
      if (status.bridge?.status !== 'connected') throw new ApiError('OpenCode could not connect to the client tool bridge.', 502, null, 'mcp_unavailable');
      if (warmup) { lifecycle.complete(); await cleanup(true); return { warmed: true }; }
      phase = lifecycle.stage('session creation');
      const session = await api('/session', { title: 'OpenAI API bridge' });
      sessionID = session.id;
      if(sharedLease){
        home=sessionPath(sharedLease.process.home,sessionID);await mkdir(home,{mode:0o700});
        requestFile=path.join(home,'request.json');hookFile=path.join(home,'hooks-ready.json');
        await writeFile(requestFile,JSON.stringify({body,modelID,providerID,outputLimit:model.output,global,hookFile,reasoningVariants:model.reasoningVariants,sessionID,requestID:lifecycle.id,groupID:sharedLease.process.groupID}),{mode:0o600,flag:'wx'});
        requestPublished=true;
      }
      eventController = new AbortController();
      const eventSignal = AbortSignal.any([combined, eventController.signal]);
      phase = lifecycle.stage('event subscription');
      // Headers alone do not establish a usable SSE subscription. Confirm the
      // initial event before inference, retrying empty connections without any
      // supplier call. Retain the iterator so slow clients do not lose that read.
      const connectTimeout = setTimeout(() => eventController.abort(new ApiError('OpenCode event subscription timed out.', 503, null, 'opencode_events')), this.config.startupTimeoutMs);
      let iterator, initial;
      try {
        while (true) {
          const response = await fetch(base + '/event', { headers, signal: eventSignal });
          if (!response.ok || !response.body) throw new ApiError('OpenCode event stream is unavailable.', 502);
          iterator = sseEvents(response.body);
          initial = await iterator.next();
          if (!initial.done) break;
          await delay(100, eventSignal);
        }
      } finally { clearTimeout(connectTimeout); }
      phase = 'inference';
      lifecycle.inference();
      await api(`/session/${sessionID}/prompt_async`, { ...(providerID ? { model: { providerID, modelID } } : {}),...(generation&&!generation.capture?{format:generation.format}:{}), agent: 'bridge', parts: [{ type: 'text', text: 'Complete the current client request.' }] });
      phase = lifecycle.stage('message and parameter hooks');
      const hookDeadline = Date.now() + this.config.startupTimeoutMs;
      const buffered = [initial.value];
      const nextEvent = () => iterator.next().then(event => ({ event }), error => ({ error }));
      const hookState = () => readFile(hookFile, 'utf8').then(JSON.parse, () => undefined).catch(() => undefined);
      const checkHookError = ready => {
        if (ready?.error) throw new ApiError(ready.error.message, ready.error.status, ready.error.param, ready.error.code);
      };
      let pending = nextEvent();
      while (true) {
        combined.throwIfAborted();
        const ready = await hookState();
        checkHookError(ready);
        if (ready?.history === true && ready?.system === true && ready?.params === true) break;
        if (worker.error || worker.exited || worker.child.exitCode !== null || Date.now() >= hookDeadline) throw new ApiError('OpenCode did not invoke the required message and parameter hooks. Check runtime/plugin compatibility.', 503, null, 'opencode_hooks_incompatible');
        const next = await Promise.race([pending, delay(50, combined).then(() => ({}))]);
        if (next.error) throw next.error;
        if (!next.event) continue;
        if (next.event.done) throw new ApiError('OpenCode event stream closed before request preparation.', 502, null, 'opencode_events');
        const event = next.event.value;
        const p = event.properties ?? {};
        if (p.sessionID === sessionID || p.info?.sessionID === sessionID) {
          if (event.type === 'session.error' || p.info?.error) checkHookError(await hookState());
          if (event.type === 'session.error') throw upstreamError(p.error,'opencode_session_error');
          if (p.info?.error) throw upstreamError(p.info.error);
        }
        if(p.sessionID===sessionID||p.info?.sessionID===sessionID||p.part?.sessionID===sessionID)buffered.push(event);
        if (buffered.length > 1024) throw new ApiError('OpenCode emitted model events without confirming the required hooks.', 503, null, 'opencode_hooks_incompatible');
        pending = nextEvent();
      }
      const nativeEvents = (async function* () {
        try {
          yield* buffered;
          const next = await pending;
          if (next.error) throw next.error;
          if (!next.event.done) { yield next.event.value; yield* iterator; }
        } finally { await iterator.return(); }
      })();
      phase = lifecycle.stage('waiting for output');
      releaseStartup?.();releaseStartup=undefined;
      const events = bufferEvents(nativeEvents, { sessionID, lifecycle, structured:!!generation, abort: error => controller.abort(error), stop: () => eventController.abort() });
      abortCleanup = () => { this.track(cleanup()).catch(() => {}); };
      combined.addEventListener('abort', abortCleanup, { once: true });
      combined.throwIfAborted();
      if(this.warmTargets.length)this.track(Promise.resolve().then(()=>this.replenish()));
      return { events, sessionID, cleanup, finishCleanup:()=>{releaseAdmission();const task=cleanup(true);if(!sharedLease)this.pool.offer(key,task);this.track(task).catch(()=>{});}, signal: combined, version: reportedVersion, lifecycle, reused, observe: (usage, reason) => { requestUsage = usage; finishReason = reason; }, complete: () => lifecycle.complete(), cancel: () => controller.abort(new ApiError('Request cancelled.', 499, null, 'request_cancelled')), abort: () => this.track(abortSession().catch(()=>{})),
        diagnose: async details => { failure = details.error; if (typeof this.config.onFailure === 'function') await this.config.onFailure({ phase, home, output: worker?.output ?? '', ...details }).catch(() => {}); },
      };
    } catch (error) {
      if (typeof this.config.onFailure === 'function') await this.config.onFailure({ phase, home, output: worker?.output ?? '' }).catch(() => {});
      failure = combined.aborted ? combined.reason : error;
      if (failure && typeof failure === 'object') failure.requestId = lifecycle.id;
      await cleanup();
      throw failure;
    }
  }
  async fetch(url, init = {}, apiKey) {
    try {
      const endpoint = new URL(url).pathname.replace(/\/$/, '');
      if (endpoint !== '/v1/chat/completions' || init.method !== 'POST') throw new ApiError('Only /v1/chat/completions is supported.', 404, null, 'unsupported_endpoint');
      let body;
      try { body = JSON.parse(init.body); } catch { throw new ApiError('Malformed JSON request.'); }
      const run = await this.prepare(body, apiKey, init.signal, false, init.requestId);
      const id = 'chatcmpl-' + (run.lifecycle?.id ?? randomUUID());
      const created = Math.floor(Date.now() / 1000);
      const chunks = this.chunks(body, run, { id, created, model: body.model });
      if (!body.stream) {
        let content = '', reasoning = '', calls = [], finish, usage;
        for await (const chunk of chunks) {
          if(chunk.choices?.some(choice=>choice.delta?.content||choice.delta?.reasoning_content||choice.delta?.tool_calls?.length))init.onModelOutput?.();
          const choice = chunk.choices[0];
          if (choice) {
            content += choice.delta.content ?? '';
            reasoning += choice.delta.reasoning_content ?? '';
            for (const call of choice.delta.tool_calls ?? []) {const item=calls[call.index]??={id:'',type:'function',function:{name:'',arguments:''}};if(call.id)item.id=call.id;if(call.function?.name)item.function.name+=call.function.name;item.function.arguments+=call.function?.arguments??'';}
            if (choice.finish_reason) finish = choice.finish_reason;
          }
          if (chunk.usage) usage = chunk.usage;
        }
        const message = { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) };
        return Response.json({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message, finish_reason: finish, logprobs: null }], usage }, { headers: { ...(run.version ? { 'x-opencode-version': run.version } : {}), ...(run.lifecycle ? { 'x-opencode-request-id': run.lifecycle.id, 'server-timing': timingHeader(run) } : {}) } });
      }
      // Wait for the first model event before committing a successful SSE response.
      // The initial assistant role alone does not establish successful inference:
      // an upstream rejection must still become a normal HTTP error for clients.
      const role = await chunks.next();
      const first = await chunks.next();
      init.onModelOutput?.();
      run.lifecycle?.clientOutput();
      const streamChunks = (async function* () {
        try {
          if (!role.done) yield role.value;
          if (!first.done) yield first.value;
          yield* chunks;
        } finally { await chunks.return(); }
      })();
      const encoder = new TextEncoder();
      let cancelled = false;
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const next = await streamChunks.next();
            if (cancelled) return;
            if (next.done) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
            else controller.enqueue(encoder.encode('data: ' + JSON.stringify(next.value) + '\n\n'));
          } catch (e) {
            if (cancelled) return;
            const error = e instanceof ApiError ? e : new ApiError('OpenCode stream failed.', 502, null, 'opencode_stream_error');
            init.onUpstreamError?.(error);
            controller.enqueue(encoder.encode('data: ' + JSON.stringify(error.body()) + '\n\n'));
            controller.close();
          }
        },
        async cancel() {
          cancelled = true;
          run.cancel?.();
          await run.cleanup();
          try { await streamChunks.return(); }
          catch (error) { if (error.name !== 'AbortError' && !run.signal.aborted) throw error; }
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering':'no', ...(run.version ? { 'x-opencode-version': run.version } : {}), ...(run.lifecycle ? { 'x-opencode-request-id': run.lifecycle.id, 'x-opencode-worker-reused': String(reusedHeader(run)), 'server-timing': timingHeader(run) } : {}) } });
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(init.signal?.aborted ? 'Request cancelled.' : 'OpenCode bridge failed.', init.signal?.aborted ? 499 : 502, null, 'opencode_error');
      return Response.json(error.body(), { status: error.status, headers: { ...(error.status === 429 ? { 'retry-after': '1' } : {}),...error.headers, ...(e.requestId ? { 'x-opencode-request-id': e.requestId } : {}) } });
    }
  }
  async* chunks(body, run, meta) {
    const chunk = (delta, finish_reason = null, usage) => ({ ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason, logprobs: null }], ...(usage ? { usage } : {}) });
    const names = new Map((body.tools ?? []).map(t => [nativeToolName(t.function.name), t.function.name]));
    const toolIDs = new Set();
    const announcedTools = new Map();
    const textParts = new Map();
    const assistantIDs = new Set();
    const trace = [];
    const generation=nativeGeneration(body);
    const recovery = new ToolTextRecovery(
      generation
        ? [{ name: generation.capture ? CAPTURE_TOOL : 'StructuredOutput', parameters: generation.format.schema }]
        : body.tool_choice === 'none'
          ? []
          : (body.tools ?? []).map((t) => ({
              name: nativeToolName(t.function.name),
              aliases: [t.function.name],
              parameters: t.function.parameters
            }))
    );
    let finished = false,outputStarted=false,nativeUsage,captured,captureCallID;
    const constrained=value=>{
      assertSchema(generation.format.schema,value);
      if(generation.kind==='json')return{deltas:[{content:JSON.stringify(value)}],reason:'stop'};
      const deltas=[];if(value.answer)deltas.push({content:value.answer});
      if(value.calls.length)deltas.push({tool_calls:value.calls.map((c,index)=>({index,id:'call_'+randomUUID().replaceAll('-',''),type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))});
      return{deltas,reason:value.calls.length?'tool_calls':'stop'};
    };
    try {
      yield chunk({ role: 'assistant', content: '' });
      for await (const event of run.events) {
        run.signal.throwIfAborted();
        const p = event.properties ?? {};
        if (typeof this.config.onFailure === 'function') {
          trace.push({ type: event.type, session: p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID, role: p.info?.role, part: p.part?.type, reason: p.part?.reason });
          if (trace.length > 50) trace.shift();
        }
        if (p.sessionID !== run.sessionID && p.part?.sessionID !== run.sessionID && p.info?.sessionID !== run.sessionID) continue;
        if (event.type === 'message.updated' && p.info?.role === 'assistant') {
          assistantIDs.add(p.info.id);
          if (p.info.error) throw upstreamError(p.info.error);
          if(generation&&p.info.structured!==undefined){
            if(recovery.mode==='calls')throw new ApiError('OpenCode returned mixed constrained outputs.',502,null,'invalid_structured_output');
            if(!nativeUsage)throw new ApiError('OpenCode structured output is missing its token usage.',502,null,'invalid_structured_output');
            const result=constrained(p.info.structured),reason=result.reason;for(const delta of result.deltas)yield chunk(delta);
            run.complete?.();run.observe?.(nativeUsage,reason);void run.abort();
            yield chunk({},reason,body.stream?undefined:nativeUsage);
            if(body.stream&&body.stream_options?.include_usage)yield{...meta,object:'chat.completion.chunk',choices:[],usage:nativeUsage};
            finished=true;break;
          }
        }
        if (event.type === 'session.error') throw upstreamError(p.error,'opencode_session_error');
        if (event.type === 'permission.asked' || event.type === 'question.asked') throw new ApiError('OpenCode asked for interactive input.', 502, null, 'opencode_interactive');
        if (event.type === 'session.status' && p.status?.type === 'retry') {
          // Native retries before output remain bounded by firstOutputTimeoutMs.
          // Replaying after emitted text/tool calls would duplicate client output.
          if(outputStarted)throw retryError(p.status);
          if(p.status.attempt>=3||p.status.next-Date.now()>=this.config.firstOutputTimeoutMs)throw retryError(p.status,false);
          continue;
        }
        if (event.type === 'session.idle') throw new ApiError('OpenCode ended without a model completion.', 502);
        if (event.type === 'message.part.delta' && assistantIDs.has(p.messageID) && p.field === 'text') {
          const state = textParts.get(p.partID);
          if (state) { state.sent += p.delta;outputStarted=true;const delta=state.type==='reasoning'?p.delta:recovery.push(p.delta);if(delta&&(state.type==='reasoning'||!generation))yield chunk({ [state.type === 'reasoning' ? 'reasoning_content' : 'content']: delta }); }
        }
        if (event.type !== 'message.part.updated' || !assistantIDs.has(p.part?.messageID)) continue;
        const part = p.part;
        if(generation?.capture&&part.type==='tool'&&part.tool===CAPTURE_TOOL){if(part.state.status==='error')throw new ApiError('OpenCode rejected constrained output.',502,null,'invalid_structured_output');if(part.state.status==='running'){if(captureCallID&&captureCallID!==part.callID)throw new ApiError('OpenCode returned duplicate constrained outputs.',502,null,'invalid_structured_output');if(!captureCallID){captured=constrained(part.state.input);captureCallID=part.callID;}}continue;}
        if(generation&&part.type==='tool'&&part.tool==='StructuredOutput'){if(part.state.status==='error')throw new ApiError('OpenCode rejected structured output.',502,null,'invalid_structured_output');continue;}
        if (['text', 'reasoning'].includes(part.type)) {
          const state = textParts.get(part.id) ?? { type: part.type, sent: '' };
          if (!part.text.startsWith(state.sent)) throw new ApiError('OpenCode rewrote text already streamed to the client.', 502, null, 'opencode_text_rewrite');
          const delta = part.text.slice(state.sent.length);
          state.sent = part.text;
          textParts.set(part.id, state);
          if (delta) {outputStarted=true;const text=part.type==='reasoning'?delta:recovery.push(delta);if(text&&(part.type==='reasoning'||!generation))yield chunk({ [part.type === 'reasoning' ? 'reasoning_content' : 'content']: text });}
        }
        if (part.type === 'tool' && ['pending','running'].includes(part.state.status)) {
          if(recovery.mode==='calls')throw new ApiError('OpenCode returned mixed native and DSML tool calls.',502,null,'invalid_dsml_tool_call');
          const name = names.get(part.tool);
          if (!name) throw new ApiError('OpenCode attempted an unregistered local tool.', 502, null, 'unregistered_tool');
          let state=announcedTools.get(part.callID);
          if(!state){state={index:toolIDs.size,name,complete:false};announcedTools.set(part.callID,state);toolIDs.add(part.callID);outputStarted=true;yield chunk({tool_calls:[{index:state.index,id:part.callID,type:'function',function:{name,arguments:''}}]});}
          if(state.name!==name)throw new ApiError('OpenCode changed a streamed tool identity.',502,null,'opencode_tool_rewrite');
          if(part.state.status!=='running'||state.complete)continue;
          const definition=body.tools.find(t=>t.function.name===name)?.function;
          if(definition?.strict)assertSchema(definition.parameters??{type:'object'},part.state.input,'tools');
          state.complete=true;
          outputStarted=true;
          yield chunk({ tool_calls: [{ index:state.index, function: { arguments: JSON.stringify(part.state.input) } }] });
        }
        if (part.type === 'tool' && part.state.status === 'error') throw new ApiError('OpenCode rejected the tool call before returning it.', 502, null, 'opencode_tool_error');
        if (part.type === 'step-finish') {
          if([...announcedTools.values()].some(t=>!t.complete))throw new ApiError('OpenCode ended before tool arguments were complete.',502,null,'incomplete_tool_call');
          const recovered=recovery.finish();
          if(recovered.text&&!generation)yield chunk({content:recovered.text});
          if(recovered.calls){
            if(toolIDs.size||!['stop','tool-calls'].includes(part.reason))throw new ApiError('OpenCode returned mixed or interrupted DSML tool calls.',502,null,'invalid_dsml_tool_call');
            if(generation){if(captured||recovered.calls.length!==1)throw new ApiError('OpenCode returned duplicate constrained outputs.',502,null,'invalid_structured_output');captured=constrained(recovered.calls[0].input);}
            else for(const {name,input} of recovered.calls){const id='call_'+randomUUID().replaceAll('-',''),index=toolIDs.size;toolIDs.add(id);yield chunk({tool_calls:[{index,id,type:'function',function:{name:names.get(name),arguments:JSON.stringify(input)}}]});}
          }
          if(generation&&(generation.capture||recovered.calls)&&!toolIDs.size){
            if(!captured)throw new ApiError('OpenCode did not return the required constrained output.',502,null,'invalid_structured_output');
            const usage=usageOf(part.tokens),reason=captured.reason;for(const delta of captured.deltas)yield chunk(delta);
            run.complete?.();run.observe?.(usage,reason);void run.abort();yield chunk({},reason,body.stream?undefined:usage);
            if(body.stream&&body.stream_options?.include_usage)yield{...meta,object:'chat.completion.chunk',choices:[],usage};finished=true;break;
          }
          if(generation&&!toolIDs.size){nativeUsage=usageOf(part.tokens);continue;}
          if (part.reason === 'tool-calls' && !toolIDs.size) throw new ApiError('OpenCode finished a tool batch without usable calls.', 502);
          if (!['stop', 'length', 'tool-calls', 'content-filter'].includes(part.reason)) throw new ApiError(`Unsupported OpenCode finish reason: ${part.reason}.`, 502);
          // The standard SDK publishes this after the MCP deferral acknowledgements.
          run.complete?.();
          void run.abort();
          const usage = usageOf(part.tokens);
          const reason = recovered.calls?'tool_calls':({ 'tool-calls': 'tool_calls', 'content-filter': 'content_filter' })[part.reason] ?? part.reason;
          run.observe?.(usage, reason);
          yield chunk({}, reason, body.stream ? undefined : usage);
          if (body.stream && body.stream_options?.include_usage) yield { ...meta, object: 'chat.completion.chunk', choices: [], usage };
          finished = true;
          break;
        }
      }
      if (!finished) throw new ApiError('OpenCode disconnected before completion.', 502, null, 'incomplete_stream');
    } catch (error) {
      await run.diagnose?.({ events: trace, error: run.signal.aborted ? run.signal.reason : error });
      if (run.signal.aborted) {
        if (run.signal.reason instanceof ApiError) throw run.signal.reason;
        throw new ApiError('Request cancelled.', 499, null, 'request_cancelled');
      }
      throw error;
    }
    finally { if(finished&&run.finishCleanup)run.finishCleanup();else await run.cleanup(finished); }
  }
}
