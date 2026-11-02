import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { executableCommand } from './command.mjs';
import { workerConfig } from './config.mjs';
import { modelCatalog } from './models.mjs';
import { ApiError, BASE, PROTOCOLS, WINDOW, optionsOf, waitFor } from './transport-common.mjs';

const port = async () => {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
};

export class OpenCodeTransport {
  constructor(input = {}) {
    const { maxConcurrent, ...options } = input;
    this.config = optionsOf(options); this.controllers = new Set();
    this.config.workingDirectory = path.resolve(this.config.workingDirectory ?? os.homedir());
    this.acceptedModels = {}; this.starts = 0;
  }
  async start() {
    if (this.closed) throw new ApiError('OpenCode transport has stopped.', 503, null, 'bridge_shutdown');
    return this.starting ??= this.launch().catch(async error => { await this.stopChild(); this.starting = undefined; throw error; });
  }
  async launch() {
    const info = await stat(this.config.workingDirectory).catch(() => undefined);
    if (!info?.isDirectory()) throw new ApiError('workingDirectory must name an existing directory.', 503, 'workingDirectory');
    this.home = await mkdtemp(path.join(os.tmpdir(), 'opencode-transport-'));
    this.token = randomBytes(32).toString('hex');
    const bind = await port(), descriptor = path.join(this.home, 'control.json');
    const helper = pathToFileURL(fileURLToPath(new URL('./opencode-transport.mjs', import.meta.url))).href;
    const overrides = { plugin: [helper], snapshot: false, autoupdate: false, share: 'disabled' };
    const env = { ...process.env, OPENCODE_DB: path.join(this.home, 'opencode.sqlite'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(workerConfig(process.env.OPENCODE_CONFIG_CONTENT, overrides)),
      OPENCODE_SERVER_PASSWORD: this.token, OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_PROXY_PARENT_PID: String(process.pid), OPENCODE_PROXY_CONTROL_FILE: descriptor,
      OPENCODE_PROXY_CONTROL_TOKEN: this.token, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1' };
    const command = await executableCommand(this.config.command);
    if (this.closed) throw new ApiError('OpenCode transport has stopped.', 503);
    this.childDead = false; this.startError = undefined;
    const child = this.child = spawn(command[0], [...command.slice(1), 'serve', '--hostname', '127.0.0.1', '--port', String(bind)], { env, cwd: this.config.workingDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.starts++;
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    this.exit = new Promise(resolve => { child.once('error', error => { this.startError = error; this.childDead = true; resolve(); }); child.once('exit', () => { this.childDead = true; resolve(); }); });
    const signal = AbortSignal.any([AbortSignal.timeout(this.config.startupTimeoutMs), (this.lifecycle ??= new AbortController()).signal]);
    const headers = { authorization: 'Basic ' + Buffer.from('opencode:' + this.token).toString('base64') };
    const base = 'http://127.0.0.1:' + bind;
    for (;;) {
      signal.throwIfAborted();
      if (this.startError || this.childDead) throw new ApiError('OpenCode exited during transport startup.', 503);
      try {
        const res = await fetch(base + '/global/health', { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
        if (res.ok) { const health = await res.json(); this.version = health.version; break; }
        await res.body?.cancel();
      } catch { signal.throwIfAborted(); }
      await delay(50, undefined, { signal });
    }
    // Other minor lines must verify hook order before bootstrap may run: the
    // stop hook must precede SDK inference, not merely exist in plugin types.
    if (!/^1\.18\.\d+(?:\+.*)?$/.test(this.version ?? '')) throw new ApiError('Native transport currently requires OpenCode 1.18.x with verified pre-inference hooks.', 503, null, 'unsupported_opencode_version');
    // This initializes plugins without listing credentials or creating a chat.
    const init = await fetch(base + '/provider/auth', { headers, signal });
    await init.body?.cancel();
    if (!init.ok) throw new ApiError('OpenCode could not initialize provider plugins.', 503);
    for (;;) {
      signal.throwIfAborted();
      const state = await readFile(descriptor, 'utf8').then(JSON.parse, () => undefined);
      if (Number.isInteger(state?.pid) && Number.isInteger(state.port) && state.version === 1) {
        if (state.pid <= 0 || state.pid === process.pid) throw new ApiError('Invalid OpenCode transport process.', 503);
        this.nativePid = state.pid; this.base = 'http://127.0.0.1:' + state.port; break;
      }
      await delay(50, undefined, { signal });
    }
    child.unref(); child.stdout.unref?.(); child.stderr.unref?.();
    return this;
  }
  async control(pathname, init = {}) {
    await this.start();
    if (this.childDead || this.startError) throw new ApiError('The persistent OpenCode process exited. Re-enable the Magpie plugin.', 503, null, 'opencode_exited');
    return fetch(this.base + pathname, { ...init, headers: { ...init.headers, authorization: 'Bearer ' + this.token } });
  }
  async loadModels(refresh = false) {
    if (this.closed) throw new ApiError('OpenCode transport has stopped.', 503, null, 'bridge_shutdown');
    if (this.catalogPending) return this.catalogPending;
    if (!refresh && this.catalog) return this.catalog;
    const task = (async () => {
      if (refresh && this.catalog) {
        if (this.controllers.size) throw new ApiError('Wait for active requests before refreshing OpenCode configuration.', 409, null, 'transport_busy');
        // OpenCode v1 caches global configuration beyond instance disposal.
        // Explicit refresh replaces the sole child; requests never spawn peers.
        this.catalog = undefined; this.config.models = {}; this.acceptedModels = {};
        await this.stopChild(); this.starting = undefined;
      }
      const res = await this.control('/catalog', { signal: AbortSignal.any([(this.lifecycle ??= new AbortController()).signal, AbortSignal.timeout(this.config.startupTimeoutMs)]) });
      const body = await res.json();
      if (!res.ok) throw new ApiError(body.error?.message ?? 'OpenCode model discovery failed.', res.status);
      const catalog = modelCatalog(body.models, {}, 'short');
      this.config.models = catalog.models; this.acceptedModels = catalog.accepted;
      this.catalog = Promise.resolve(catalog.models); return catalog.models;
    })();
    this.catalogPending = task;
    task.then(() => { this.catalogPending = undefined; }, () => { this.catalogPending = undefined; });
    return task;
  }
  async fetch(url, init = {}) {
    await waitFor(this.loadModels(), init.signal);
    let body; try { body = JSON.parse(init.body); } catch { throw new ApiError('Malformed JSON request.'); }
    const model = Object.hasOwn(this.config.models, body?.model) ? this.config.models[body.model] : undefined;
    if (!model) throw new ApiError('Model is not available from local OpenCode.', 404, 'model', 'model_not_found');
    const protocol = PROTOCOLS[model.npm];
    if (!protocol) throw new ApiError(`Native transport does not yet support this model's SDK: ${model.npm}`, 501, 'model', 'unsupported_sdk');
    if (url !== BASE + protocol.path || init.method !== 'POST') throw new ApiError('The request API does not match this model.', 404, null, 'unsupported_endpoint');
    const controller = new AbortController(); this.controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, this.lifecycle.signal, ...(init.signal ? [init.signal] : [])]);
    const requestID = randomBytes(16).toString('hex');
    const complete = () => { this.controllers.delete(controller); signal.removeEventListener('abort', abort); };
    const abort = () => {
      complete();
      // Bun's node:http shim does not always report a pre-header disconnect.
      // An explicit private cancellation also stops the supplier fetch then.
      if (!this.lifecycle.signal.aborted) void (async () => {
        for (let i = 0; i < 3; i++) {
          try {
            const response = await fetch(this.base + '/cancel/' + requestID, { method: 'POST', headers: { authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(1000) });
            await response.body?.cancel(); if (response.status === 204) return;
          } catch { return; }
          await delay(20);
        }
      })();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const res = await this.control('/forward/' + encodeURIComponent(model.model), { method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-opencode-proxy-request': requestID }, body: JSON.stringify({ body, timeouts: { first: this.config.firstOutputTimeoutMs, idle: this.config.idleTimeoutMs, total: this.config.timeoutMs } }) });
      if (!res.body) { complete(); return res; }
      const reader = res.body.getReader();
      let consumed = 0;
      const credit = async bytes => {
        consumed += bytes;
        if (consumed < WINDOW / 2) return;
        const amount = consumed; consumed = 0;
        const grant = await this.control('/credit/' + requestID, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bytes: amount }) });
        await grant.body?.cancel();
        if (grant.status !== 204 && grant.status !== 404) throw new ApiError('OpenCode stream flow control failed.', 503);
      };
      return new Response(new ReadableStream({
        async pull(c) { try { const next = await reader.read(); if (next.done) { complete(); c.close(); } else { await credit(next.value.byteLength); c.enqueue(next.value); } } catch (error) { controller.abort(error); complete(); c.error(error); } },
        async cancel(reason) { controller.abort(reason); try { await reader.cancel(reason); } catch { /* already aborted by fetch */ } finally { complete(); } },
      }), { status: res.status, headers: res.headers });
    } catch (error) { complete(); throw error; }
  }
  async diagnostics() { const res = await this.control('/health'); return { ...await res.json(), starts: this.starts, pendingClients: this.controllers.size }; }
  async stopChild() {
    // npm's JavaScript launcher can own a separate native child on Windows.
    if (this.nativePid && this.nativePid !== this.child?.pid) {
      try { process.kill(this.nativePid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (this.child && !this.childDead) { this.child.kill(); await this.exit; }
    this.nativePid = undefined;
    if (this.home) await rm(this.home, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true; this.lifecycle?.abort();
    for (const controller of this.controllers) controller.abort();
    return this.closing = (async () => { await this.starting?.catch(() => {}); await this.stopChild(); this.controllers.clear(); })();
  }
}
