import { ApiError } from './protocol.mjs';

// One process per immutable model/config/credential key. Instances, sessions,
// tools and cancellation remain request-owned; a client never owns this process.
export class SharedProcesses {
  constructor(config, protectedKey = () => false) {
    this.config = config;
    this.protectedKey = protectedKey;
    this.entries = new Map();
    this.all = new Set();
    this.retiring = new Set();
  }
  has(key) { const entry = this.entries.get(key); return !!entry && !entry.draining; }
  async acquire(key, create, signal) {
    signal?.throwIfAborted();
    if (this.closed) throw new ApiError('Bridge is shutting down.', 503, null, 'bridge_shutdown');
    let entry = this.entries.get(key), reused = !!entry && !entry.draining;
    if (!reused) {
      entry = { key, refs: 0, controller: new AbortController() };
      this.all.add(entry);
      this.entries.set(key, entry);
      entry.ready = Promise.resolve().then(() => create(entry.controller.signal)).then(process => {
        entry.process = process;
        process.onFailure = () => this.retire(entry);
        return process;
      }).catch(error => { this.retire(entry); throw error; });
    }
    clearTimeout(entry.timer);
    entry.refs++;
    let released = false;
    const release = async (dirty = false) => {
      if (released) return;
      released = true;
      entry.refs--;
      if (dirty) this.retire(entry);
      if (!entry.refs) {
        if (entry.draining || this.closed || !this.config.workerReuse || !this.config.maxIdleWorkers) return this.destroy(entry);
        entry.idleAt = Date.now();
        const expire = () => {
          if (entry.refs || entry.draining) return;
          if (this.protectedKey(key) && !this.closed) { entry.timer = setTimeout(expire, this.config.workerIdleMs); entry.timer.unref(); }
          else this.retire(entry);
        };
        entry.timer = setTimeout(expire, this.config.workerIdleMs);entry.timer.unref();
        const idle = [...this.entries.values()].filter(e => !e.refs && !e.draining).sort((a,b) => a.idleAt-b.idleAt);
        while (idle.length > this.config.maxIdleWorkers) {
          const index = idle.findIndex(e => !this.protectedKey(e.key));
          this.retire(idle.splice(index < 0 ? 0 : index, 1)[0]);
        }
      }
    };
    const cancelled = Promise.withResolvers();
    const abort = () => cancelled.reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      const process = await Promise.race([entry.ready, cancelled.promise]);
      signal?.throwIfAborted();
      if (entry.draining || process.events?.failed || process.worker.error || process.worker.exited || process.worker.child.exitCode !== null)
        throw new ApiError('Shared OpenCode process is unavailable.', 503, null, 'opencode_shared_unavailable');
      return { process, reused, release };
    } catch (error) { await release(!signal?.aborted); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  retire(entry) {
    entry.draining = true;
    clearTimeout(entry.timer);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (!entry.refs) void this.destroy(entry);
  }
  destroy(entry) {
    if (entry.closing) return entry.closing;
    this.retireWithoutDestroy(entry);
    entry.controller.abort();
    const task = entry.ready.then(process => process.dispose(), () => {}).finally(() => { this.retiring.delete(task);this.all.delete(entry); });
    entry.closing = task;
    this.retiring.add(task);
    // Retirement may be triggered by a timer or a transport failure.
    void task.catch(() => {});
    return task;
  }
  retireWithoutDestroy(entry) {
    entry.draining = true;clearTimeout(entry.timer);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.all].map(entry => this.destroy(entry)));
    await Promise.allSettled(this.retiring);
  }
}

// /instance/dispose may acknowledge before teardown. The global stream confirms
// the exact directory's disposal; unrelated session events are never retained.
export function disposalEvents(iterator, onFailure = () => {}) {
  const pending = new Map();
  const canonical = directory => process.platform === 'win32' ? directory.replaceAll('\\','/').toLowerCase() : directory;
  let failure, stopped = false;
  const pump = (async () => {
    try {
      for await (const event of iterator) {
        if (event.payload?.type !== 'server.instance.disposed') continue;
        const directory = event.payload.properties?.directory;
        if (typeof directory === 'string') pending.get(canonical(directory))?.resolve();
      }
      if (!stopped) throw new Error('Shared OpenCode lifecycle stream closed.');
    } catch (error) {
      if (!stopped) { failure = error; for (const waiter of pending.values()) waiter.reject(error);onFailure(); }
    }
  })();
  return {
    get failed() { return failure; },
    async dispose(directory, action, timeoutMs = 5000) {
      if (failure) throw failure;
      const key = canonical(directory), waiter = Promise.withResolvers();
      pending.set(key, waiter);
      const timer = setTimeout(() => waiter.reject(new Error('OpenCode instance disposal was not confirmed.')), timeoutMs);
      // Observe immediately: an action can fail before the disposal timeout.
      const confirmed = waiter.promise;void confirmed.catch(() => {});
      try { await action(); await confirmed; }
      finally { clearTimeout(timer);pending.delete(key); }
    },
    async close(abort) { stopped = true;abort();await pump; },
  };
}
