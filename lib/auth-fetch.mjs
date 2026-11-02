import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { Readable, pipeline } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { ApiError } from './transport-common.mjs';

// Import the package implementation explicitly, rather than Bun's built-in
// `undici` compatibility alias (which delegates back to eager native fetch).
const { request: wireRequest, EnvHttpProxyAgent, interceptors } = createRequire(import.meta.url)('undici/index.js');

export function authFetchScope() {
  const context = new AsyncLocalStorage(), previous = globalThis.fetch;
  const dispatcher = new EnvHttpProxyAgent();
  const follow = dispatcher.compose(interceptors.redirect({ maxRedirections: 20, throwOnMaxRedirect: true }));
  const send = async (input, init = {}) => {
    if (['proxy', 'tls', 'unix', 's3'].some(key => init[key] !== undefined)) throw new ApiError('This auth plugin uses unsupported runtime-specific fetch options.', 501, null, 'unsupported_auth_fetch');
    const request = new Request(input, init);
    let connection = init.dispatcher ?? dispatcher;
    if (request.redirect === 'follow') connection = init.dispatcher ? connection.compose(interceptors.redirect({ maxRedirections: 20, throwOnMaxRedirect: true })) : follow;
    const raw = await wireRequest(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer()),
      signal: request.signal, dispatcher: connection, headersTimeout: 0, bodyTimeout: 0 });
    // Rejecting headers can destroy a body before a Response reader exists.
    // Other stream listeners still receive the error once streaming begins.
    raw.body.on('error', () => {});
    if (request.redirect === 'error' && [301, 302, 303, 307, 308].includes(raw.statusCode)) { raw.body.destroy(); throw new TypeError('Supplier redirect disallowed.'); }
    const headers = new Headers(Object.fromEntries(Object.entries(raw.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])));
    const encoding = (headers.get('content-encoding') ?? 'identity').toLowerCase().trim();
    const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding];
    if (!decoder && encoding !== 'identity') { raw.body.destroy(); throw new ApiError('Unsupported supplier content encoding.', 501, null, 'unsupported_content_encoding'); }
    let readable = raw.body;
    if (decoder) { readable = decoder(); pipeline(raw.body, readable, () => {}); headers.delete('content-encoding'); headers.delete('content-length'); }
    const empty = request.method === 'HEAD' || [204, 205, 304].includes(raw.statusCode);
    if (empty) raw.body.resume();
    const response = new Response(empty ? null : Readable.toWeb(readable), { status: raw.statusCode, headers });
    const history = raw.context?.history;
    Object.defineProperties(response, { url: { value: history?.at(-1)?.toString() ?? request.url }, redirected: { value: (history?.length ?? 0) > 1 } });
    context.getStore()?.responses.add(response);
    return response;
  };
  const scoped = Object.assign(function fetch(input, init) {
    return context.getStore() ? send(input, init) : Reflect.apply(previous, globalThis, [input, init]);
  }, previous);
  globalThis.fetch = scoped;
  return {
    run: (custom, url, init) => context.run({ responses: new WeakSet() }, async () => {
      const response = await (custom ?? send)(url, init);
      // A plugin that captured another fetch or buffers/rewraps the response
      // cannot be promised bounded streaming. Do not silently accept it.
      if (!context.getStore().responses.has(response)) {
        await response.body?.cancel();
        throw new ApiError('The auth plugin bypasses the scoped streaming fetch or wraps its response; native reuse is unsupported.', 501, null, 'unsupported_auth_fetch');
      }
      return response;
    }),
    async dispose() { if (globalThis.fetch === scoped) globalThis.fetch = previous; context.disable(); await dispatcher.destroy(); },
  };
}
