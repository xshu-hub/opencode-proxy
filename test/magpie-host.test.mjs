import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { executableCommand } from '../lib/command.mjs';
import { globalProfile } from './global-profile.mjs';

if (!process.env.TEST_MAGPIE_HOST) throw new Error('Set TEST_MAGPIE_HOST to Magpie internal/plugin/host.js.');
const source = path.resolve(process.env.TEST_MAGPIE_HOST);
const root = fileURLToPath(new URL('../', import.meta.url));

test('the real Magpie Bun host loads the package, lists models and streams real OpenCode inference', { timeout: 120000 }, async t => {
  const command = JSON.parse(process.env.TEST_OPENCODE_COMMAND ?? '["opencode"]');
  const bun = await executableCommand(JSON.parse(process.env.TEST_BUN_COMMAND ?? '["bun"]'));
  const profile = await globalProfile();
  const child = spawn(bun[0], [...bun.slice(1), source], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env }, cwd: profile.home });
  let stderr = '', sequence = 0;
  const pending = new Map();
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const write = message => child.stdin.write(JSON.stringify(message) + '\n');
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const waiter = pending.get(value.id);
    if (!waiter) return;
    if (value.event) {
      waiter.frames.push(value);
      if (value.event === 'chunk') write({ method: 'credit', params: { id: value.id, n: Buffer.from(value.data, 'base64').length + 2048 } });
      return;
    }
    pending.delete(value.id); clearTimeout(waiter.timer);
    if (value.error) waiter.reject(new Error(value.error.message + '\n' + stderr));
    else waiter.resolve({ result: value.result, frames: waiter.frames });
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out\n${stderr}`)); }, 45000);
    pending.set(id, { resolve, reject, frames: [], timer });
    write({ id, method, params });
  });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000); timer.unref();
    try {
      await exited;
      const deadline = Date.now() + 6000;
      const pids = (await readFile(profile.pidsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
      const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
      while (pids.some(alive) && Date.now() < deadline) await delay(100);
      assert.deepEqual(pids.filter(alive), [], 'OpenCode workers must stop after the Magpie host exits');
    } finally {
      clearTimeout(timer);
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      lines.close();
      await profile.close();
    }
  });
  const init = await rpc('init', {
    authPath: path.join(profile.home, 'magpie-auth.json'), directory: profile.home,
    plugins: [{ spec: root, target: root, options: { command, startupTimeoutMs: 15000, firstOutputTimeoutMs: 20000 } }],
  });
  assert.equal(init.result.plugins.length, 1);
  assert.equal(init.result.plugins[0].error, undefined, JSON.stringify(init.result));
  const first = (await rpc('providers')).result;
  assert.equal(first[0].id, 'opencode-proxy');
  assert.equal(first[0].signedIn, false);
  assert.equal(first[0].methods[0].keyless, true);
  assert.equal((await rpc('apiKey', { provider: 'opencode-proxy', method: 0 })).result.ok, true);
  const listed = (await rpc('providers')).result[0];
  assert.equal(listed.signedIn, true);
  assert.equal(listed.fellBack, false, JSON.stringify(listed));
  assert.ok(listed.models.some(m => m.id === 'mock'), JSON.stringify(listed));
  const loaded = (await rpc('load', { provider: 'opencode-proxy' })).result;
  assert.equal(loaded.fetch, true);
  const fetched = await rpc('fetch', {
    provider: 'opencode-proxy', model: 'mock', npm: '@ai-sdk/openai-compatible',
    url: loaded.baseURL + '/chat/completions', method: 'POST',
    body: Buffer.from(JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hello' }], stream: true, stream_options: { include_usage: true } })).toString('base64'),
  });
  assert.equal(fetched.frames[0].status, 200);
  const text = Buffer.concat(fetched.frames.filter(f => f.event === 'chunk').map(f => Buffer.from(f.data, 'base64'))).toString('utf8');
  assert.match(text, /你好，Magpie/);
  assert.match(text, /\[DONE\]/);
  assert.equal(profile.requests.length, 1);
  assert.equal(profile.requests[0].authorization, 'Bearer fixture-renewed');
  assert.equal(profile.requests[0].marker, 'real-plugin');
  assert.equal(await readFile(profile.configPath, 'utf8'), profile.original);
});
