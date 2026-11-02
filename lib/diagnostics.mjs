import os from 'node:os';
import path from 'node:path';
import { mkdir, appendFile, stat, rename, rm } from 'node:fs/promises';

export function logDirectory(env = process.env, platform = process.platform) {
  const base = platform === 'win32' ? env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'opencode-proxy', 'logs');
}

// Never serialize request bodies, tool inputs, HTTP headers or child output.
// Error messages may themselves echo those values, so scrub that text too.
export function diagnosticText(value, privateValues = []) {
  let text = typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message : '';
  text = text.slice(0, 32768);
  for (const secret of privateValues) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
  return text
    .replace(/-----BEGIN[^\r\n]*-----[\s\S]*?(?:-----END[^\r\n]*-----|$)/g, '[redacted certificate]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[redacted authentication]')
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|x-auth-token|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|signature|x-oc-[\w-]+)["']?\s*[:=]\s*[^\r\n]*/gi, '[redacted credential]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b(?:value|input|arguments|messages|prompt|body|output|content)["']?\s*[:=]\s*[^\r\n]*/gi, '[redacted payload]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, 2048);
}

export function privateStrings(value, result = [], depth = 0) {
  if (result.length >= 512 || depth > 16) return result;
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) for (const item of value) privateStrings(item, result, depth + 1);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) privateStrings(item, result, depth + 1);
  return result;
}

export class FailureLogger {
  constructor({ directory = logDirectory(), enabled = true, maxBytes = 2 * 1024 * 1024, maxPending = 32, stderr = line => console.error(line) } = {}) {
    Object.assign(this, { directory, enabled, maxBytes, maxPending, stderr });
    this.file = path.join(directory, 'diagnostics.jsonl');
    this.pending = 0; this.dropped = 0; this.tail = Promise.resolve();
  }
  record(details) {
    if (!this.enabled || this.closed) return Promise.resolve();
    if (this.pending >= this.maxPending) { this.dropped++; return Promise.resolve(); }
    // Allowlist fields; the existing debug callback also receives unsafe child
    // output/home paths. They must never enter the persistent log.
    const error = details.error, tool = error?.tool, hidden = details.privateValues ?? [];
    const record = { time: new Date().toISOString(), event: details.event || 'request_failed',
      requestId: diagnosticText(details.requestId), sessionId: diagnosticText(details.sessionId), model: diagnosticText(details.model),
      phase: diagnosticText(details.phase), openCodeVersion: diagnosticText(details.version),
      platform: process.platform, arch: process.arch, nodeVersion: process.version, pid: process.pid,
      error: { name: diagnosticText(error?.name), code: diagnosticText(error?.code),
        status: Number.isInteger(error?.status) ? error.status : undefined, message: diagnosticText(error, hidden) },
      tool: tool ? { name: diagnosticText(tool.name), nativeName: diagnosticText(tool.nativeName), callId: diagnosticText(tool.callId), status: 'error', reason: diagnosticText(tool.reason) } : undefined,
      events: details.events?.slice(-50).map(e => Object.fromEntries(['type', 'part', 'tool', 'status', 'reason'].map(key => [key, diagnosticText(e[key]).slice(0, 128)]))),
      dropped: this.dropped || undefined };
    this.dropped = 0;
    const line = JSON.stringify(record) + '\n'; this.pending++;
    this.tail = this.tail.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const size = await stat(this.file).then(s => s.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        await rm(this.file + '.1', { force: true });
        await rename(this.file, this.file + '.1').catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
      await appendFile(this.file, line, { mode: 0o600 });
      this.stderr('[opencode-proxy] ' + JSON.stringify({ event: record.event, requestId: record.requestId, code: record.error.code, log: this.file }));
    }).catch(error => {
      // Logging failure must never replace the actual inference error.
      try { this.stderr('[opencode-proxy] diagnostic_write_failed ' + (error.code || 'unknown')); } catch {}
    }).finally(() => { this.pending--; });
    return this.tail;
  }
  async close() { this.closed = true; await this.tail; }
}
