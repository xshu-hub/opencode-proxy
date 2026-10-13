const pools = new Set();
process.once('beforeExit', () => { void Promise.allSettled([...pools].map(pool => pool.close())); });
process.once('exit', () => {
  for (const pool of pools) for (const worker of pool.workers) worker.child?.kill();
});

// This limits idle retention only. A miss always creates a new exclusive worker.
export class WorkerPool {
  constructor(config) {
    this.config = config;
    this.workers = new Set();
    this.idle = [];
    this.retention = Promise.resolve();
    pools.add(this);
  }
  track(worker) { this.workers.add(worker); }
  take(key) {
    const index = this.idle.findIndex(w => w.key === key);
    if (index < 0 || this.closed) return;
    const [worker] = this.idle.splice(index, 1);
    clearTimeout(worker.idleTimer);
    worker.child.ref(); worker.child.stdout.ref?.(); worker.child.stderr.ref?.(); worker.mcp.ref();
    return worker;
  }
  async discard(worker) {
    this.idle = this.idle.filter(w => w !== worker);
    clearTimeout(worker.idleTimer);
    this.workers.delete(worker);
    await worker.dispose();
  }
  put(worker) {
    const operation = this.retention.then(async () => {
      if (this.closed || !this.config.workerReuse || this.config.maxIdleWorkers === 0) return this.discard(worker);
      while (this.idle.length >= this.config.maxIdleWorkers) await this.discard(this.idle[0]);
      if (this.closed) return this.discard(worker);
      this.idle.push(worker);
      worker.idleTimer = setTimeout(() => { void this.discard(worker).catch(() => {}); }, this.config.workerIdleMs);
      worker.idleTimer.unref();
      worker.child.unref(); worker.child.stdout.unref?.(); worker.child.stderr.unref?.(); worker.mcp.unref();
    });
    this.retention = operation.catch(() => {});
    return operation;
  }
  async close() {
    this.closed = true;
    pools.delete(this);
    await this.retention;
    await Promise.allSettled([...this.workers].map(w => this.discard(w)));
  }
}
