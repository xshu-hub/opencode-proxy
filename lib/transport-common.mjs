export class ApiError extends Error {
  constructor(message, status = 400, param = null, code = 'invalid_request') {
    super(message); Object.assign(this, { status, param, code });
  }
  body() { return { error: { message: this.message, type: this.status === 429 ? 'rate_limit_error' : this.status >= 500 ? 'api_error' : 'invalid_request_error', param: this.param, code: this.code } }; }
}

export const BASE = 'http://opencode-proxy.invalid/v1';
export const PROTOCOLS = Object.freeze(Object.assign(Object.create(null), {
  '@ai-sdk/openai-compatible': { name: 'chat', path: '/chat/completions' },
  '@ai-sdk/openai': { name: 'responses', path: '/responses' },
  '@ai-sdk/anthropic': { name: 'anthropic', path: '/messages' },
}));
export const MAX_BODY = 16 * 1024 * 1024;
export const WINDOW = 256 * 1024;

export function optionsOf(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('Plugin options must be an object.');
  const allowed = new Set(['command', 'workingDirectory', 'startupTimeoutMs', 'firstOutputTimeoutMs', 'idleTimeoutMs', 'timeoutMs', 'headerHooks', 'workerReuse', 'workerSharing', 'maxIdleWorkers', 'workerIdleMs']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new ApiError(`Unsupported OpenCode Proxy option: ${key}`);
  const out = { command: ['opencode'], startupTimeoutMs: 20000, firstOutputTimeoutMs: 120000, idleTimeoutMs: 180000, timeoutMs: 0, headerHooks: 'reject', ...input, maxConcurrent: 0 };
  if (!['reject', 'per-request'].includes(out.headerHooks)) throw new ApiError('headerHooks must be reject or per-request.');
  if (!Array.isArray(out.command) || !out.command.length || out.command.some(x => typeof x !== 'string' || !x.trim())) throw new ApiError('command must be an executable and optional argument array.');
  if (out.workingDirectory !== undefined && (typeof out.workingDirectory !== 'string' || !out.workingDirectory.trim() || out.workingDirectory.includes('\0'))) throw new ApiError('workingDirectory must be a nonempty directory path.');
  for (const key of ['startupTimeoutMs', 'firstOutputTimeoutMs', 'idleTimeoutMs']) if (!Number.isSafeInteger(out[key]) || out[key] <= 0) throw new ApiError(`${key} must be a positive integer.`);
  if (!Number.isSafeInteger(out.timeoutMs) || out.timeoutMs < 0) throw new ApiError('timeoutMs must be a nonnegative integer.');
  // Accept the previous package's saved options, but never restore its pools.
  for (const key of ['workerReuse', 'workerSharing']) if (out[key] !== undefined && typeof out[key] !== 'boolean') throw new ApiError(`${key} must be boolean.`);
  for (const key of ['maxIdleWorkers', 'workerIdleMs']) if (out[key] !== undefined && (!Number.isSafeInteger(out[key]) || out[key] < 0)) throw new ApiError(`${key} must be a nonnegative integer.`);
  if (out.workerReuse === false) throw new ApiError('Transport mode requires a persistent OpenCode process; remove workerReuse:false.');
  return out;
}

export function waitFor(task, signal) {
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => { signal.removeEventListener('abort', abort); fn(value); };
    const abort = () => finish(reject, signal.reason);
    task.then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

export function publicFailure(error) {
  return error instanceof ApiError ? error : new ApiError('Local OpenCode transport is unavailable. Check the program, provider and plugin compatibility.', 503, null, 'opencode_unavailable');
}
