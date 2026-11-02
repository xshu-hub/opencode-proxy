import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { ApiError, PROTOCOLS, MAX_BODY, WINDOW, waitFor, publicFailure } from './transport-common.mjs';
import { WatchParent } from './parent-watch.mjs';
import { authFetchScope } from './auth-fetch.mjs';

const id = prefix => prefix + randomBytes(13).toString('hex');
const unwrap = result => { if (result.error) throw new ApiError('OpenCode bootstrap API failed.', 503, null, 'bootstrap_failed'); return result.data; };
const knownHeader = key => /^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(key);

async function readJSON(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY + 1024) throw new ApiError('Request body exceeds 16 MiB.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('Malformed JSON request.'); }
}

// Loaded only by the real OpenCode executable. There is no provider network
// implementation in the Magpie process and no session fallback in this mode.
export const OpenCodeTransportPlugin = async ({ project, directory, serverUrl }) => {
  const token = process.env.OPENCODE_PROXY_CONTROL_TOKEN, descriptor = process.env.OPENCODE_PROXY_CONTROL_FILE;
  if (!token || !descriptor) return {};
  const parent = await WatchParent();
  const wire = authFetchScope();
  // Older v1 plugin clients dispatch through a separate in-process HTTP app.
  // Use the serving runtime and an explicit directory for every management call
  // so initialization and inference hooks share the same instance state.
  const management = async (pathname, method = 'GET', body) => {
    const url = new URL(pathname, serverUrl); url.searchParams.set('directory', directory);
    const response = await fetch(url, { method, headers: {
      authorization: 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64'),
      'content-type': 'application/json',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { await response.body?.cancel(); return { error: true }; }
    if (response.status === 204) return { data: undefined };
    return { data: await response.json() };
  };
  const captures = new Map(), pending = new Map(), refreshes = new Map(), active = new Set();
  const inflight = new Map();
  const stats = { bootstraps: 0, forwarded: 0, completed: 0, cancelled: 0, failures: 0, readBytes: 0 };
  let queue = Promise.resolve(), closed = false, catalog = new Map(), version;
  let authCache, authUntil = 0;
  const invalidateAuth = () => { authCache = undefined; authUntil = 0; };
  const authState = async providerID => {
    if (!authCache || Date.now() > authUntil) {
      authUntil = Date.now() + 500;
      const file = path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'opencode', 'auth.json');
      authCache = readFile(file, 'utf8').then(JSON.parse, () => ({}));
    }
    return (await authCache)[providerID];
  };
  const catalogOf = async () => {
    const raw = unwrap(await management('/provider'));
    if (!Array.isArray(raw?.all) || !Array.isArray(raw.connected)) throw new ApiError('Incompatible OpenCode provider catalog.', 503);
    const connected = new Set(raw.connected), next = new Map(), models = {};
    for (const provider of raw.all) {
      if (!connected.has(provider.id) || ['magpie', 'opencode-proxy', 'opencode-bridge'].includes(provider.id)) continue;
      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        if (model.capabilities?.input?.text === false || model.capabilities?.output?.text === false) continue;
        const key = provider.id + '/' + modelID;
        const npm = model.api?.npm ?? provider.npm;
        next.set(key, { providerID: provider.id, modelID, npm });
        const valid = value => Number.isSafeInteger(value) && value > 0;
        models[key] = { model: key, name: model.name ?? modelID, npm,
          context: valid(model.limit?.context) ? model.limit.context : 128000,
          output: valid(model.limit?.output) ? model.limit.output : 16384,
          temperature: model.capabilities?.temperature !== false, toolcall: model.capabilities?.toolcall !== false,
          inputModalities: Object.entries(model.capabilities?.input ?? { text: true }).filter(([, on]) => on === true).map(([kind]) => kind),
          reasoning: model.capabilities?.reasoning === true,
          reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(effort => Object.hasOwn(model.variants ?? {}, effort)),
        };
      }
    }
    catalog = next;
    for (const key of captures.keys()) if (!next.has(key)) captures.delete(key);
    return { models };
  };

  const bootstrap = key => {
    if (captures.has(key)) return Promise.resolve(captures.get(key));
    if (!catalog.has(key)) return Promise.reject(new ApiError('Model is not available from OpenCode. Refresh models.', 404, 'model', 'model_not_found'));
    const model = catalog.get(key);
    if (!PROTOCOLS[model.npm]) return Promise.reject(new ApiError(`Native transport does not support SDK ${model.npm}.`, 501, 'model', 'unsupported_sdk'));
    if (pending.has(key)) return pending.get(key);
    const task = queue.then(async () => {
      if (closed) throw new ApiError('OpenCode transport has stopped.', 503);
      const session = unwrap(await management('/session', 'POST', { title: 'Transport initialization' }));
      stats.bootstraps++;
      const ready = Promise.withResolvers(); void ready.promise.catch(() => {});
      const entry = { key, ready, model, stage: 'prompt' }; pending.set(session.id, entry);
      const timer = setTimeout(() => ready.reject(new ApiError('OpenCode did not expose the v1 transport hooks (' + entry.stage + ').', 503, null, 'bootstrap_timeout')), 15000);
      let unprotect = () => {};
      try {
        unprotect = wire.protectBootstrap(ready.reject);
        unwrap(await management('/session/' + session.id + '/prompt_async', 'POST', {
          model: { providerID: model.providerID, modelID: model.modelID }, agent: 'transport-bootstrap',
          parts: [{ type: 'text', text: 'Initialize the provider transport. Do not infer or execute tools.' }],
        }));
        return await ready.promise;
      } finally {
        clearTimeout(timer);
        try {
          await management('/session/' + session.id + '/abort', 'POST').catch(() => {});
          const deleted = await management('/session/' + session.id, 'DELETE').catch(() => ({ error: true }));
          pending.delete(session.id);
          if (deleted.error) { captures.delete(key); throw new ApiError('OpenCode bootstrap session cleanup failed.', 503, null, 'bootstrap_cleanup_failed'); }
        } finally { unprotect(); }
      }
    });
    queue = task.catch(() => {}); pending.set(key, task);
    task.then(transport => { captures.set(key, transport); pending.delete(key); }, () => pending.delete(key));
    return task;
  };

  const invoke = async (transport, body, signal) => {
    const headers = new Headers();
    const sessionID = id('ses_');
    if (transport.providerID.startsWith('opencode')) {
      headers.set('x-opencode-project', project.id);
      headers.set('x-opencode-session', sessionID);
      headers.set('x-opencode-request', id('msg_'));
      headers.set('x-opencode-client', process.env.OPENCODE_CLIENT ?? 'cli');
    } else { headers.set('x-session-affinity', sessionID); headers.set('x-session-id', sessionID); }
    headers.set('user-agent', 'opencode/' + version);
    for (const [name, value] of transport.headers) headers.set(name, value);
    headers.set('content-type', 'application/json');
    if (transport.protocol.name === 'anthropic' && !headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
    const outgoing = { ...body, model: transport.apiID };
    return wire.run(transport.fetch, transport.url, { method: 'POST', headers, body: JSON.stringify(outgoing), signal });
  };
  const authorizedFetch = async (transport, body, signal) => {
    // Coordinate an expired OAuth credential before fan-out. The original auth
    // plugin still performs and saves the refresh; credentials never leave here.
    for (;;) {
      const waiting = refreshes.get(transport.providerID);
      if (waiting) { await waitFor(waiting, signal); continue; }
      const auth = await authState(transport.providerID);
      signal.throwIfAborted();
      if (!transport.fetch || auth?.type !== 'oauth' || !Number.isFinite(auth.expires) || auth.expires > Date.now()) return invoke(transport, body, signal);
      const another = refreshes.get(transport.providerID);
      if (another) { await waitFor(another, signal); continue; }
      const done = Promise.withResolvers(); void done.promise.catch(() => {});
      refreshes.set(transport.providerID, done.promise);
      try {
        const response = await invoke(transport, body, signal);
        invalidateAuth();
        const after = await authState(transport.providerID);
        if (response.ok && after?.type === 'oauth' && after.expires <= Date.now()) {
          await response.body?.cancel();
          throw new ApiError('The auth plugin did not publish refreshed OAuth state; concurrent transport reuse is unsupported.', 501, null, 'unsupported_auth_refresh');
        }
        done.resolve(); return response;
      } catch (error) { done.reject(error); throw error; }
      finally { refreshes.delete(transport.providerID); }
    }
  };

  // Explicit byte credits bound runtime prefetch even when Bun's HTTP writable
  // shim reports drain before the downstream consumer has read those bytes.
  const server = http.createServer(async (req, res) => {
    const expected = Buffer.from('Bearer ' + token), supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { res.writeHead(401).end(); return; }
    const pathname = req.url;
    const controller = new AbortController(), signal = controller.signal;
    const aborted = () => controller.abort(new ApiError('Request cancelled.', 499, null, 'request_cancelled'));
    req.once('aborted', aborted); res.once('close', () => { if (!res.writableEnded) aborted(); });
    let firstTimer, idleTimer, totalTimer, business = false, succeeded = false, requestID, reader;
    const state = { controller, credit: WINDOW, ready: Promise.withResolvers() };
    const available = async () => { while (state.credit <= 0) await waitFor(state.ready.promise, signal); signal.throwIfAborted(); };
    const finish = error => {
      clearTimeout(firstTimer); clearTimeout(idleTimer); clearTimeout(totalTimer);
      req.off('aborted', aborted);
      active.delete(controller);
      if (inflight.get(requestID) === state) inflight.delete(requestID);
      if (error) { controller.abort(error); void reader?.cancel(error).catch(() => {}); }
    };
    const timeout = kind => controller.abort(new ApiError(`OpenCode transport ${kind} timeout.`, 504, null, 'transport_timeout'));
    try {
      if (pathname.startsWith('/cancel/') && req.method === 'POST') {
        const target = inflight.get(pathname.slice('/cancel/'.length));
        target?.controller.abort(new ApiError('Request cancelled.', 499, null, 'request_cancelled'));
        res.writeHead(target ? 204 : 404).end(); return;
      }
      if (pathname.startsWith('/credit/') && req.method === 'POST') {
        const target = inflight.get(pathname.slice('/credit/'.length));
        const { bytes } = await readJSON(req);
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > WINDOW * 2) throw new ApiError('Invalid stream credit.');
        if (target) { target.credit = Math.min(WINDOW, target.credit + bytes); const ready = target.ready; target.ready = Promise.withResolvers(); ready.resolve(); }
        res.writeHead(target ? 204 : 404).end(); return;
      }
      if (pathname === '/health' && req.method === 'GET') {
        const sessions = unwrap(await management('/session'));
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ pid: process.pid, version, rss: process.memoryUsage().rss, active: active.size, captures: captures.size, pending: pending.size, refreshing: refreshes.size, sessions: sessions.length, ...stats })); return;
      }
      if (pathname === '/catalog' && req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(await catalogOf())); return; }
      const key = pathname.startsWith('/forward/') ? decodeURIComponent(pathname.slice('/forward/'.length)) : '';
      if (!key || req.method !== 'POST') throw new ApiError('Unknown transport endpoint.', 404);
      requestID = req.headers['x-opencode-proxy-request'];
      if (!/^[a-f0-9]{32}$/.test(requestID ?? '') || inflight.has(requestID)) throw new ApiError('Invalid transport request identifier.');
      inflight.set(requestID, state);
      const { body, timeouts } = await readJSON(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('Request must be a JSON object.');
      if (!timeouts || !Number.isSafeInteger(timeouts.first) || timeouts.first <= 0 || !Number.isSafeInteger(timeouts.idle) || timeouts.idle <= 0 || !Number.isSafeInteger(timeouts.total) || timeouts.total < 0) throw new ApiError('Invalid transport deadlines.');
      business = true; active.add(controller); stats.forwarded++;
      firstTimer = setTimeout(() => timeout('first-output'), timeouts.first);
      if (timeouts.total) totalTimer = setTimeout(() => timeout('total'), timeouts.total);
      const transport = await waitFor(bootstrap(key), signal);
      const response = await authorizedFetch(transport, body, signal);
      reader = response.body?.getReader();
      // Delay headers until the first byte, so pre-output timeout stays 504.
      const first = reader ? await waitFor(reader.read(), signal) : { done: true };
      stats.readBytes += first.value?.byteLength ?? 0;
      clearTimeout(firstTimer);
      const hop = new Set(['connection', 'transfer-encoding', 'content-length', 'content-encoding', 'keep-alive', 'set-cookie']);
      for (const [name, value] of response.headers) if (!hop.has(name)) res.setHeader(name, value);
      res.writeHead(response.status);
      const write = async chunk => {
        for (let offset = 0; offset < chunk.byteLength;) {
          await available(); const size = Math.min(state.credit, chunk.byteLength - offset, 65536);
          state.credit -= size;
          if (!res.write(chunk.subarray(offset, offset + size))) await once(res, 'drain', { signal });
          offset += size;
        }
      };
      if (!first.done) await write(first.value);
      if (reader && !first.done) for (;;) {
        await available();
        idleTimer = setTimeout(() => timeout('idle'), timeouts.idle);
        const next = await waitFor(reader.read(), signal); clearTimeout(idleTimer);
        stats.readBytes += next.value?.byteLength ?? 0;
        if (next.done) break; await write(next.value);
      }
      res.end(); succeeded = true; stats.completed++;
    } catch (error) {
      const failure = publicFailure(signal.aborted ? signal.reason : error);
      if (business) { if (failure.status === 499) stats.cancelled++; else stats.failures++; }
      if (!res.headersSent) { res.writeHead(failure.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(failure.body())); }
      else res.destroy();
    } finally { finish(business && !succeeded ? signal.reason ?? new Error('Transport failed.') : undefined); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await writeFile(descriptor, JSON.stringify({ version: 1, port: server.address().port, pid: process.pid }), { mode: 0o600 });
  return {
    config: async cfg => {
      cfg.instructions = []; cfg.skills = { paths: [], urls: [] }; cfg.snapshot = false; cfg.share = 'disabled';
      for (const name of Object.keys(cfg.mcp ?? {})) cfg.mcp[name] = { ...cfg.mcp[name], enabled: false };
      cfg.permission = { '*': 'deny' }; cfg.agent ??= {}; cfg.agent.title = { disable: true };
      cfg.agent['transport-bootstrap'] = { mode: 'primary', prompt: 'Initialize transport only.', permission: { '*': 'deny' } };
    },
    'chat.params': async input => {
      const entry = pending.get(input.sessionID);
      if (!entry) throw new ApiError('This OpenCode instance only serves native transport.', 409);
      entry.stage = 'params';
      const npm = input.model.api?.npm ?? entry.model.npm, protocol = PROTOCOLS[npm];
      if (!protocol) { entry.ready.reject(new ApiError(`Unsupported model SDK: ${npm}`, 501)); throw new Error('TRANSPORT_BOOTSTRAP_STOP'); }
      const options = input.provider.options ?? {}, base = options.baseURL ?? input.model.api?.url;
      if (typeof base !== 'string' || base.includes('${')) { entry.ready.reject(new ApiError('Provider needs an explicit native base URL.', 501)); throw new Error('TRANSPORT_BOOTSTRAP_STOP'); }
      let url; try { url = new URL(String(base)); } catch { entry.ready.reject(new ApiError('Provider has no usable native base URL.', 501)); throw new Error('TRANSPORT_BOOTSTRAP_STOP'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) { entry.ready.reject(new ApiError('Unsupported native endpoint.', 501)); throw new Error('TRANSPORT_BOOTSTRAP_STOP'); }
      url.pathname = url.pathname.replace(/\/$/, '') + protocol.path;
      const headers = new Headers(options.headers);
      for (const [name, value] of Object.entries(input.model.headers ?? {})) headers.set(name, String(value));
      const apiKey = options.apiKey ?? input.provider.key;
      if (apiKey && ![...headers.keys()].some(knownHeader)) headers.set(protocol.name === 'anthropic' ? 'x-api-key' : 'authorization', protocol.name === 'anthropic' ? apiKey : 'Bearer ' + apiKey);
      entry.transport = { providerID: input.model.providerID, apiID: input.model.api?.id ?? input.model.id, protocol, url: url.href, fetch: typeof options.fetch === 'function' ? options.fetch : undefined, headers };
    },
    'chat.headers': async (input, output) => {
      const entry = pending.get(input.sessionID);
      if (!entry?.transport) throw new Error('TRANSPORT_BOOTSTRAP_STOP');
      entry.stage = 'headers';
      if (Object.keys(output.headers).length) entry.ready.reject(new ApiError('This provider uses per-turn chat.headers hooks. Native transport cannot safely reuse their dynamic authentication.', 501, null, 'unsupported_dynamic_headers'));
      else {
        try {
          if (!version) {
            const response = await fetch(new URL('/global/health', serverUrl), { headers: { authorization: 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64') } });
            if (!response.ok) throw new Error('health status ' + response.status);
            version = (await response.json()).version;
          }
          entry.ready.resolve(entry.transport);
        } catch { entry.ready.reject(new ApiError('OpenCode native header initialization failed.', 503, null, 'bootstrap_headers_failed')); }
      }
      // Always stop BEFORE SDK execution: bootstrap never sends inference.
      throw new Error('TRANSPORT_BOOTSTRAP_STOP');
    },
    'tool.execute.before': async () => { throw new Error('Local tools are disabled in transport mode.'); },
    dispose: async () => {
      closed = true; for (const controller of active) controller.abort();
      for (const entry of pending.values()) entry?.ready?.reject(new ApiError('Transport stopped.', 503));
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await wire.dispose(); await parent.dispose?.();
    },
  };
};
