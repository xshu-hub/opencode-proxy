import { ApiError } from './protocol.mjs';
import { eventBuffer } from './events.mjs';

const canonical = directory => process.platform === 'win32' ? directory.replaceAll('\\', '/').toLowerCase() : directory;

// One parser/connection per OpenCode process. Route before buffering, and keep
// each request's bounded queue, lifecycle and cancellation independent.
export class SessionEventHub {
  constructor(directory) {
    this.directory = canonical(directory); this.sessions = new Map();
    this.received = 0; this.delivered = 0;
  }
  subscribe(sessionID, options) {
    if (this.failure) throw this.failure;
    if (this.sessions.has(sessionID)) throw new ApiError('Duplicate OpenCode event subscription.', 503, null, 'opencode_events');
    const signal = options.signal;
    const remove = () => { this.sessions.delete(sessionID); signal?.removeEventListener('abort', aborted); options.stop?.(); };
    const buffer = eventBuffer({ ...options, sessionID, stop: remove });
    const aborted = () => buffer.cancel(signal.reason);
    this.sessions.set(sessionID, { buffer, lifecycle: options.lifecycle });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    return buffer;
  }
  publish(envelope) {
    this.received++;
    if (typeof envelope.directory === 'string' && canonical(envelope.directory) !== this.directory) return;
    const event = envelope.payload ?? envelope, p = event.properties ?? {};
    const sessionID = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    const target = this.sessions.get(sessionID);
    if (target) { this.delivered++; target.buffer.push(event); }
  }
  fail() {
    this.failure ??= new ApiError('The shared OpenCode event stream disconnected. Retry from the caller.', 503, null, 'opencode_events');
    for (const { buffer, lifecycle } of [...this.sessions.values()]) buffer.end(lifecycle.completed ? undefined : this.failure);
  }
  close() {
    this.failure ??= new ApiError('Shared OpenCode events stopped.', 503, null, 'bridge_shutdown');
    for (const { buffer } of [...this.sessions.values()]) buffer.cancel(this.failure);
  }
  get stats() { return { subscribers: this.sessions.size, queuedBytes: [...this.sessions.values()].reduce((sum, item) => sum + item.buffer.bytes, 0), received: this.received, delivered: this.delivered }; }
}
