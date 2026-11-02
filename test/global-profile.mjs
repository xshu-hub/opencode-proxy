import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

// Only disposable credentials and a loopback upstream. Never read or copy the
// user's OpenCode configuration, auth store or Magpie sign-ins into a test.
export async function globalProfile({ respond, bootstrapOutbound = false, bootstrapPreparation = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'opencode-magpie-test-'));
  const configDir = path.join(home, 'config', 'opencode');
  const authFile = path.join(home, 'data', 'opencode', 'auth.json');
  const pidsFile = path.join(home, 'worker-pids.jsonl');
  const bootstrapGate = path.join(home, 'bootstrap-gate');
  const mcpMarker = path.join(home, 'mcp-started'), mcpScript = path.join(home, 'mcp-sentinel.mjs');
  await writeFile(mcpScript, `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(mcpMarker)}, 'started');`);
  const saved = { ...process.env }, requests = [], preparations = [];
  let refreshes = 0, active = 0, peak = 0, produced = 0;
  const upstream = http.createServer(async (req, res) => {
    if (['/bootstrap-metadata', '/custom-auth/preflight'].includes(req.url)) {
      preparations.push({ method: req.method, path: req.url }); req.resume();
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ nonce: 'fixture-nonce', ticket: 'fixture-preflight-ticket' })); return;
    }
    if (req.url === '/refresh') {
      refreshes++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access: 'fixture-renewed', refresh: 'fixture-refresh', expires: Date.now() + 3600000 }));
      return;
    }
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    active++; peak = Math.max(peak, active); res.once('close', () => active--);
    requests.push({ body, path: req.url, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'], marker: req.headers['x-fixture-opencode'], userAgent: req.headers['user-agent'], session: req.headers['x-session-id'], option: req.headers['x-fixture-option'], modelHeader: req.headers['x-fixture-model'], preflight: req.headers['x-fixture-preflight'] });
    if (respond && await respond({ req, res, body })) return;
    const text = JSON.stringify(body.messages ?? body.input ?? body);
    if (text.includes('CONCURRENT_')) await new Promise(resolve => setTimeout(resolve, 150));
    if (text.includes('WAIT_FIRST')) { res.once('close', () => {}); return; }
    if (text.includes('TRANSPORT_GZIP')) { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(gzipSync(JSON.stringify({ choices: [{ message: { content: 'GZIP_OK' } }] }))); return; }
    if (text.includes('SLOW_READER')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const block = Buffer.alloc(65536, 120);
      const controller = new AbortController(); res.once('close', () => controller.abort());
      try { for (let i = 0; i < 4096 && !res.destroyed; i++) { produced++; if (!res.write(block)) await once(res, 'drain', { signal: controller.signal }); } if (!res.destroyed) res.end(); } catch {} return;
    }
    if (body.messages?.some(m => m.content === 'REJECT')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture refused', type: 'permission_error' } }));
      return;
    }
    if (req.url.endsWith('/responses')) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'resp_fixture', object: 'response', status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RESPONSES_OK', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })); return;
    }
    if (req.url.endsWith('/messages')) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'MESSAGES_OK' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })); return;
    }
    if (!body.stream) {
      const hasResult = body.messages.some(m => m.role === 'tool');
      const calls = body.messages.some(m => m.content === 'CALL_TOOL') && !hasResult;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'chat_fixture', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: calls ? null : hasResult ? 'Tool result received.' : '你好，Magpie。', ...(calls ? { tool_calls: [{ id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"city":"北京"}' } }] } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null, usage) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n');
    const hasResult = body.messages.some(m => m.role === 'tool');
    if (body.messages.some(m => m.content === 'CALL_TOOL') && !hasResult) {
      emit({ tool_calls: [{ index: 0, id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"city":"北京"}' } }] });
      emit({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    } else {
      emit({ content: hasResult ? 'Tool result received.' : '你好，Magpie。' });
      emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }
    if (text.includes('WAIT_IDLE')) return;
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  await mkdir(configDir, { recursive: true });
  await mkdir(path.dirname(authFile), { recursive: true });
  const sdk = process.env.TEST_OPENCODE_PLUGIN_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@opencode-ai/plugin'))), '..');
  const manifest = JSON.parse(await readFile(path.join(sdk, 'package.json'), 'utf8'));
  await cp(sdk, path.join(configDir, 'node_modules', '@opencode-ai', 'plugin'), { recursive: true });
  await writeFile(path.join(configDir, 'package.json'), JSON.stringify({ private: true, dependencies: { '@opencode-ai/plugin': manifest.version } }));
  await writeFile(path.join(configDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { '@opencode-ai/plugin': manifest.version } }, 'node_modules/@opencode-ai/plugin': { version: manifest.version } } }));
  const login = path.join(configDir, 'fixture-auth.mjs');
  await writeFile(login, `import { appendFile, access } from 'node:fs/promises';
  export const FixtureAuth = async ({ client }) => {
    await appendFile(${JSON.stringify(pidsFile)}, JSON.stringify(process.pid) + '\\n');
    let ticket;
    return {
    'chat.params': async input => {
      while (await access(${JSON.stringify(bootstrapGate)}).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 20));
      if (${JSON.stringify(bootstrapPreparation)}) {
        const metadata = await fetch(new URL(${JSON.stringify(base + '/bootstrap-metadata')})).then(r => r.json());
        const prepared = await fetch(new Request(${JSON.stringify(base + '/custom-auth/preflight')}, { method: 'POST', body: JSON.stringify({ nonce: metadata.nonce, model: input.model.id }) })).then(r => r.json());
        ticket = prepared.ticket;
      }
      if (${JSON.stringify(bootstrapOutbound)}) await fetch(${JSON.stringify(base + '/v1/chat/completions')}, { method: 'POST', body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'UNEXPECTED_BOOTSTRAP_INFERENCE' }] }) });
    },
    'chat.headers': async (input, output) => { if (input.model.providerID === 'fixture-dynamic') output.headers['x-dynamic-auth'] = 'fixture-signed-per-turn'; },
    auth: { provider: 'fixture', methods: [], loader: async getAuth => ({
      apiKey: 'sdk-placeholder',
      fetch: async (url, init) => {
        if (${JSON.stringify(bootstrapPreparation)} && !ticket) throw new Error('Provider preparation did not complete.');
        let auth = await getAuth();
        if (auth.expires < Date.now()) {
          auth = { type: 'oauth', ...await fetch(${JSON.stringify(base + '/refresh')}, { method: 'POST' }).then(r => r.json()) };
          await client.auth.set({ path: { id: 'fixture' }, body: auth });
        }
        const headers = new Headers(init.headers);
        headers.set('authorization', 'Bearer ' + auth.access);
        headers.set('x-fixture-opencode', 'real-plugin');
        if (ticket) headers.set('x-fixture-preflight', ticket);
        return fetch(url, { ...init, headers });
      }
    }) }
  }; };\n`);
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: 'fixture/mock', plugin: [pathToFileURL(login).href],
    mcp: { sentinel: { type: 'local', command: [process.execPath, mcpScript], enabled: true } },
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: base + '/v1' }, models: {
      mock: { name: 'Fixture', temperature: true, tool_call: true, limit: { context: 100000, output: 1000 } },
    } },
    'fixture-api': { npm: '@ai-sdk/openai-compatible', options: { baseURL: base + '/v1', headers: { 'x-fixture-option': 'option', 'User-Agent': 'fixture-agent' } }, models: { 'api-model': { headers: { 'x-fixture-option': 'override', 'x-fixture-model': 'model' }, limit: { context: 100000, output: 1000 } } } },
    'fixture-responses': { npm: '@ai-sdk/openai', options: { baseURL: base + '/v1' }, models: { 'response-model': { limit: { context: 100000, output: 1000 } } } },
    'fixture-messages': { npm: '@ai-sdk/anthropic', options: { baseURL: base + '/v1' }, models: { 'message-model': { limit: { context: 100000, output: 1000 } } } },
    'fixture-unsupported': { npm: '@ai-sdk/google', options: { apiKey: 'fixture-key', baseURL: base + '/v1' }, models: { 'unknown-model': { limit: { context: 100000, output: 1000 } } } },
    'fixture-dynamic': { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'fixture-key', baseURL: base + '/v1' }, models: { 'dynamic-model': { limit: { context: 100000, output: 1000 } } } },
    },
  };
  const configPath = path.join(configDir, 'opencode.json'), original = JSON.stringify(config);
  await writeFile(configPath, original);
  await writeFile(authFile, JSON.stringify({ fixture: { type: 'oauth', access: 'fixture-expired', refresh: 'fixture-refresh', expires: 0 }, 'fixture-api': { type: 'api', key: 'fixture-key' }, 'fixture-responses': { type: 'api', key: 'fixture-key' }, 'fixture-messages': { type: 'api', key: 'fixture-key' } }));
  const env = {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    TMP: home, TEMP: home, TMPDIR: home,
  };
  const keep = new Set(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'COMSPEC', 'PATHEXT', 'OPENCODE_GIT_BASH_PATH']);
  for (const key of Object.keys(process.env)) if (!keep.has(key) && !key.startsWith('TEST_')) delete process.env[key];
  Object.assign(process.env, env);
  for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_DB']) delete process.env[key];
  const close = async () => {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
    Object.assign(process.env, saved);
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { home, requests, preparations, authFile, configPath, pidsFile, original, holdBootstrap: () => writeFile(bootstrapGate, 'hold'), releaseBootstrap: () => rm(bootstrapGate, { force: true }), mcpStarted: () => readFile(mcpMarker).then(() => true, () => false), refreshes: () => refreshes, activity: () => ({ active, peak, produced }), close };
}
