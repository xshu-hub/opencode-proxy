import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './protocol.mjs';
import {protocolFor,protocolError,clientAuthorization} from './outward-protocols.mjs';

export function createProxyServer({bridge, apiKey, authenticate}) {
  if (!authenticate && (typeof apiKey !== 'string' || !apiKey)) throw new Error('Set OPENCODE_PROXY_API_KEY before starting the server.');
  const key = apiKey;
const authenticated = (req) => {
  const supplied = Buffer.from(clientAuthorization(req.headers));
  const expected = Buffer.from('Bearer ' + key);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};
const controllers = new Set();
const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  controllers.add(controller);
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', disconnect);
  const protocol=protocolFor((req.url??'').split('?')[0],req.headers);
  // This API uses explicit access keys, never browser cookies. Admin is separate.
  res.setHeader('access-control-allow-origin','*');
  res.setHeader('access-control-expose-headers','request-id, x-opencode-request-id, retry-after, server-timing');
  try {
    if(req.method==='OPTIONS')return res.writeHead(204,{'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':req.headers['access-control-request-headers']??'authorization, content-type, x-api-key, anthropic-version, anthropic-beta','access-control-max-age':'600','vary':'Access-Control-Request-Headers'}).end();
    const client=authenticate?authenticate(req):authenticated(req);
    if (!client) return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify(protocolError(protocol,new ApiError('Invalid API key.', 401, null, 'invalid_api_key').body(),401)));
    const buffers = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new ApiError('Request body exceeds 4 MiB.', 413);
      buffers.push(chunk);
    }
    const response = await bridge.fetch('http://127.0.0.1' + req.url, { method: req.method, headers:{'content-type':req.headers['content-type'],'user-agent':req.headers['user-agent']}, clientProtocol:protocol, body: req.method === 'POST' ? Buffer.concat(buffers).toString('utf8') : undefined, signal: controller.signal }, undefined, client);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) {
        if (res.destroyed) break;
        if (!res.write(Buffer.from(chunk))) await new Promise((resolve, reject) => {
          const drain = () => { res.off('close', close); resolve(); };
          const close = () => { res.off('drain', drain); reject(new Error('Client disconnected.')); };
          res.once('drain', drain); res.once('close', close);
        });
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      const error = e instanceof ApiError ? e : new ApiError('OpenCode proxy request failed.', 502);
      res.writeHead(error.status, { 'content-type': 'application/json' }).end(JSON.stringify(protocolError(protocol,error.body(),error.status)));
    } else res.destroy();
  } finally { controllers.delete(controller); res.off('close', disconnect); }
});
server.requestTimeout = 30000;

  let shutdown;
  server.shutdown = () => shutdown ??= (async () => {
    for (const controller of controllers) controller.abort();
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await Promise.all([stopped, bridge.close()]);
  })();
  return server;
}
