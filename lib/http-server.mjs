import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './protocol.mjs';

export function createProxyServer({bridge, apiKey}) {
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('Set OPENCODE_PROXY_API_KEY before starting the server.');
  const key = apiKey;
const authenticated = (req) => {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + key);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};
const controllers = new Set();
const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  controllers.add(controller);
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', disconnect);
  try {
    if (!authenticated(req)) return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify(new ApiError('Invalid API key.', 401, null, 'invalid_api_key').body()));
    const buffers = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new ApiError('Request body exceeds 4 MiB.', 413);
      buffers.push(chunk);
    }
    const response = await bridge.fetch('http://127.0.0.1' + req.url, { method: req.method, body: req.method === 'POST' ? Buffer.concat(buffers).toString('utf8') : undefined, signal: controller.signal });
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
      res.writeHead(error.status, { 'content-type': 'application/json' }).end(JSON.stringify(error.body()));
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
