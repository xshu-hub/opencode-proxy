import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { nativeToolName } from '../lib/protocol.mjs';

// Only disposable credentials and a loopback upstream. Never read or copy the
// user's OpenCode configuration, auth store or Magpie sign-ins into a test.
export async function globalProfile() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'opencode-magpie-test-'));
  const configDir = path.join(home, 'config', 'opencode');
  const authFile = path.join(home, 'data', 'opencode', 'auth.json');
  const pidsFile = path.join(home, 'worker-pids.jsonl');
  const saved = { ...process.env }, requests = [];
  let refreshes = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/refresh') {
      refreshes++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access: 'fixture-renewed', refresh: 'fixture-refresh', expires: Date.now() + 3600000 }));
      return;
    }
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ body, authorization: req.headers.authorization, marker: req.headers['x-fixture-opencode'] });
    if (body.messages.some(m => m.content === 'REJECT')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture refused', type: 'permission_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null, usage) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n');
    const hasResult = body.messages.some(m => m.role === 'tool');
    if (body.messages.some(m => m.content === 'CALL_TOOL') && !hasResult) {
      emit({ tool_calls: [{ index: 0, id: 'call_lookup', type: 'function', function: { name: nativeToolName('lookup'), arguments: '{"city":"北京"}' } }] });
      emit({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    } else {
      emit({ content: hasResult ? 'Tool result received.' : '你好，Magpie。' });
      emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }
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
  await writeFile(login, `import { appendFile } from 'node:fs/promises';
  export const FixtureAuth = async ({ client }) => {
    await appendFile(${JSON.stringify(pidsFile)}, JSON.stringify(process.pid) + '\\n');
    return {
    auth: { provider: 'fixture', methods: [], loader: async getAuth => ({
      apiKey: 'sdk-placeholder',
      fetch: async (url, init) => {
        let auth = await getAuth();
        if (auth.expires < Date.now()) {
          auth = { type: 'oauth', ...await fetch(${JSON.stringify(base + '/refresh')}, { method: 'POST' }).then(r => r.json()) };
          await client.auth.set({ path: { id: 'fixture' }, body: auth });
        }
        const headers = new Headers(init.headers);
        headers.set('authorization', 'Bearer ' + auth.access);
        headers.set('x-fixture-opencode', 'real-plugin');
        return fetch(url, { ...init, headers });
      }
    }) }
  }; };\n`);
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: 'fixture/mock', plugin: [pathToFileURL(login).href],
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: base + '/v1' }, models: {
      mock: { name: 'Fixture', temperature: true, tool_call: true, limit: { context: 100000, output: 1000 } },
    } } },
  };
  const configPath = path.join(configDir, 'opencode.json'), original = JSON.stringify(config);
  await writeFile(configPath, original);
  await writeFile(authFile, JSON.stringify({ fixture: { type: 'oauth', access: 'fixture-expired', refresh: 'fixture-refresh', expires: 0 } }));
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
  return { home, requests, authFile, configPath, pidsFile, original, refreshes: () => refreshes, close };
}
