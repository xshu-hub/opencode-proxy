import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globalProfile } from '../test/global-profile.mjs';

if (!process.env.TEST_OPENCODE_COMMAND) throw new Error('Set TEST_OPENCODE_COMMAND to a real OpenCode command array.');
const command = JSON.parse(process.env.TEST_OPENCODE_COMMAND);
const args = process.argv.slice(2), baseline = args.includes('--baseline');
const root = fileURLToPath(new URL('../', import.meta.url));
let moduleURL = new URL('../lib/bridge.mjs', import.meta.url).href;
if (baseline) {
  // Copy our own immutable baseline into an ignored directory. The current
  // checkout stays on main, and the real OpenCode executable is never modified.
  const directory = path.join(root, 'bridge-runtime', 'resource-baseline');
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', '584b969', 'lib'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim().split(/\r?\n/);
  for (const file of files) {
    if (!/^lib\/[a-z-]+\.mjs$/.test(file)) throw new Error('Unexpected baseline source path');
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, execFileSync('git', ['show', '584b969:' + file], { cwd: root, windowsHide: true }));
  }
  moduleURL = pathToFileURL(path.join(directory, 'lib', 'bridge.mjs')).href;
}
const { OpenCodeBridge } = await import(moduleURL);
const reports = [];
for (const scenario of [
  { name: 'default-4', count: 4, models: ['mock'] },
  { name: 'shared-8', count: 8, sharing: true, models: ['mock'] },
  { name: 'mixed-8', count: 8, sharing: true, models: ['mock', 'mock-alt', 'secondary', 'secondary-alt'] },
]) {
  const arrived = Promise.withResolvers(), release = Promise.withResolvers();
  let received = 0, bridge, timer;
  const profile = await globalProfile({ multipleModels: true, resourceMetrics: true, respond: async ({ res, body }) => {
    if (++received === scenario.count) arrived.resolve();
    await release.promise;
    if (res.destroyed) return true;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const content = body.model + '|' + body.messages.at(-1).content;
    for (let n = 0; n < 160 && !res.destroyed; n++) {
      res.write('data: ' + JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n');
      await delay(2);
    }
    if (!res.destroyed) res.end('data: ' + JSON.stringify({ id: 'bench', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 160, total_tokens: 170 } }) + '\n\ndata: [DONE]\n\n');
    return true;
  } });
  const originalFetch = globalThis.fetch;
  const metrics = { eventConnections: 0, eventBytes: 0 };
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['/event', '/global/event'].includes(url.pathname) || !response.body) return response;
    metrics.eventConnections++;
    return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
      metrics.eventBytes += chunk.byteLength; controller.enqueue(chunk);
    } })), { status: response.status, headers: response.headers });
  };
  try {
    const auth = JSON.parse(await readFile(profile.authFile, 'utf8'));
    auth.fixture.access = 'fixture-ready'; auth.fixture.expires = Date.now() + 3600000;
    await writeFile(profile.authFile, JSON.stringify(auth));
    bridge = new OpenCodeBridge({ mode: 'global', command, workingDirectory: profile.home, diagnostics: false,
      ...(scenario.sharing === undefined ? {} : { workerSharing: scenario.sharing }), startupTimeoutMs: 30000, firstOutputTimeoutMs: 120000 });
    await bridge.loadModels();
    globalThis.gc?.();
    const cpu = process.cpuUsage(), started = performance.now();
    let version; const outputs = [];
    const jobs = Array.from({ length: scenario.count }, async (_, i) => {
      const model = scenario.models[i % scenario.models.length], marker = 'REQUEST_' + i + '_END';
      const response = await bridge.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model,
        messages: [{ role: 'system', content: 'CLIENT_SYSTEM' }, { role: 'user', content: marker }], stream: true }) });
      version = response.headers.get('x-opencode-version');
      const text = await response.text(); assert.equal(response.status, 200, text.slice(0, 500));
      assert.ok(text.includes(model + '|' + marker));
      for (let peer = 0; peer < scenario.count; peer++) if (peer !== i) assert.ok(!text.includes('REQUEST_' + peer + '_END'));
      outputs.push({ text, expected: (model + '|' + marker).repeat(160) });
    });
    jobs.forEach(job => void job.catch(error => arrived.reject(error)));
    timer = setTimeout(() => arrived.reject(new Error('Timed out waiting for all mock requests')), 90000);
    await arrived.promise; clearTimeout(timer);
    const memoryByPid = new Map();
    for (const request of profile.requests) memoryByPid.set(request.pid, Math.max(memoryByPid.get(request.pid) ?? 0, request.rss));
    release.resolve(); await Promise.all(jobs); await bridge.drain();
    const used = process.cpuUsage(cpu);
    const elapsedMs = Math.round(performance.now() - started);
    for (const { text, expected } of outputs) {
      const content = text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
        .flatMap(line => JSON.parse(line.slice(6)).choices ?? []).map(choice => choice.delta?.content ?? '').join('');
      assert.equal(content, expected, 'Multiplexing must preserve every text delta exactly');
    }
    assert.equal(profile.requests.length, scenario.count, 'No bootstrap or retry inference is allowed');
    for (const request of profile.requests) {
      assert.equal(request.signature, request.expectedSignature);
      assert.equal(request.authorization, request.body.model.startsWith('secondary') ? 'Bearer fixture-secondary-key' : 'Bearer fixture-ready');
    }
    const report = { scenario: scenario.name, runtime: version, requests: scenario.count, ...metrics,
      inferenceProcesses: memoryByPid.size, openCodeRssAtSend: [...memoryByPid.values()].reduce((a, b) => a + b, 0),
      nodeCpuMs: Math.round((used.user + used.system) / 1000), elapsedMs,
      pendingRequests: bridge.active, pendingControllers: bridge.controllers.size };
    assert.equal(report.pendingRequests, 0); assert.equal(report.pendingControllers, 0);
    reports.push(report); console.log(JSON.stringify(report));
  } finally {
    clearTimeout(timer); release.resolve(); await bridge?.close(); globalThis.fetch = originalFetch; await profile.close();
  }
}
const output = path.resolve(args.find(arg => !arg.startsWith('--')) ?? 'artifacts/resources.json');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), implementation: baseline ? '584b969 (0.12.0)' : 'current',
  node: process.version, platform: process.platform, arch: process.arch,
  notes: 'Disposable mock; RSS snapshots at model dispatch, not peak. Node CPU includes mock server and consumer. Model discovery and final content-integrity assertions excluded.', reports }, null, 2));
