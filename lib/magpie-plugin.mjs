import { OpenCodeBridge, normalizeConfig } from './bridge.mjs';
import { ApiError } from './protocol.mjs';

const PROVIDER = 'opencode-proxy';
// An intercepted URL, never a network destination. Magpie translates its
// clients' protocols to Chat Completions before calling this plugin's fetch.
const BASE = 'http://opencode-proxy.invalid/v1';
const SDK = '@ai-sdk/openai-compatible';
const LOCAL = 'local';
const OPTIONS = new Set([
  'command', 'workingDirectory', 'workerSharing', 'workerReuse',
  'maxIdleWorkers', 'workerIdleMs', 'startupTimeoutMs',
  'firstOutputTimeoutMs', 'idleTimeoutMs', 'timeoutMs',
]);

function configuration(options, directory) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('OpenCode Proxy plugin options must be an object.');
  }
  for (const key of Object.keys(options)) {
    if (!OPTIONS.has(key)) throw new Error(`Unsupported OpenCode Proxy option: ${key}`);
  }
  return normalizeConfig({ startupTimeoutMs: 15000, ...options, mode: 'global', discoverModels: true, diagnostics: false }, directory);
}

function requireLocal(auth) {
  if (auth?.type !== 'api' || auth.key !== LOCAL) {
    throw new ApiError('Enable local OpenCode access in Magpie first (legacy key field: local).', 401, null, 'local_access_required');
  }
}

function waitFor(task, signal) {
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => { signal.removeEventListener('abort', abort); fn(value); };
    const abort = () => finish(reject, signal.reason);
    task.then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function modelInfo(id, model) {
  const input = Object.fromEntries((model.inputModalities ?? ['text']).map(kind => [kind, true]));
  return {
    id, providerID: PROVIDER, name: model.name ?? id,
    api: { id, url: BASE, npm: SDK },
    limit: { context: model.context, output: model.output },
    capabilities: {
      temperature: model.temperature !== false, toolcall: model.toolcall !== false,
      reasoning: model.reasoning === true, attachment: Object.keys(input).some(kind => kind !== 'text'),
      input, output: { text: true },
    },
    variants: Object.fromEntries((model.reasoningEfforts ?? []).map(effort => [effort, { reasoningEffort: effort }])),
  };
}

// Kept outside the package entry: Magpie calls every exported function there
// as a plugin. The injectable bridge lets tests exercise the host contract.
export function createPlugin(Bridge = OpenCodeBridge) {
  return async (input, options = {}) => {
    if (!input?.magpie) throw new Error('Install OpenCode Proxy in Magpie, not in OpenCode itself.');
    const config = configuration(options, input.directory);
    let bridge, closed = false, known = {};
    const getBridge = () => {
      if (closed) throw new ApiError('OpenCode Proxy plugin has stopped.', 503, null, 'bridge_shutdown');
      return bridge ??= new Bridge(config);
    };
    const models = async (refresh = false) => {
      const current = getBridge();
      const catalog = await current.loadModels(refresh);
      // No synthetic default or models routing back to Magpie are offered.
      // The backend provider/model remains private to the bridge.
      known = Object.fromEntries(Object.entries(catalog)
        .filter(([, model]) => model.model && !/^(magpie|opencode-proxy|opencode-bridge)\//.test(model.model))
        .map(([id, model]) => [id, modelInfo(id, model)]));
      return known;
    };
    const dispose = async () => {
      if (closed) return;
      closed = true;
      await bridge?.close();
    };

    return {
      config: async cfg => {
        cfg.provider ??= {};
        cfg.provider[PROVIDER] ??= { name: 'Local OpenCode', npm: SDK, api: BASE, models: {} };
      },
      auth: {
        provider: PROVIDER,
        single: true,
        methods: [{
          type: 'api', keyless: true, label: 'Use local OpenCode', placeholder: LOCAL,
          authorize: async () => ({ type: 'success', key: LOCAL }),
        }],
        loader: async getAuth => {
          requireLocal(await getAuth());
          return {
            baseURL: BASE, apiKey: LOCAL,
            fetch: async (requestInput, init) => {
              let signal;
              try {
                const request = new Request(requestInput, init);
                signal = request.signal;
                signal.throwIfAborted();
                requireLocal(await getAuth());
                if (request.url !== `${BASE}/chat/completions` || request.method !== 'POST') {
                  throw new ApiError('This plugin only accepts Chat Completions from Magpie.', 404, null, 'unsupported_endpoint');
                }
                let body;
                try { body = await request.json(); }
                catch { signal.throwIfAborted(); throw new ApiError('Malformed JSON request.'); }
                if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('Request must be a JSON object.');
                if (!Object.keys(known).length) await waitFor(models(), signal);
                if (!Object.hasOwn(known, body.model)) throw new ApiError('Model is not available from local OpenCode. Refresh the provider models.', 404, 'model', 'model_not_found');
                // Do not forward Magpie's local marker or incoming credentials.
                // The real OpenCode program owns all upstream authentication.
                return await getBridge().fetch(`${BASE}/chat/completions`, {
                  method: 'POST', body: JSON.stringify(body), signal,
                });
              } catch (error) {
                signal?.throwIfAborted();
                const failure = error instanceof ApiError ? error : new ApiError('Local OpenCode is unavailable. Check its program and provider configuration.', 503, null, 'opencode_unavailable');
                return Response.json(failure.body(), { status: failure.status, headers: failure.headers });
              }
            },
          };
        },
      },
      provider: {
        id: PROVIDER,
        models: async (_provider, { auth } = {}) => {
          if (!auth) return {};
          requireLocal(auth);
          return models(true);
        },
      },
      dispose,
    };
  };
}

export const OpenCodeProxyPlugin = createPlugin();
