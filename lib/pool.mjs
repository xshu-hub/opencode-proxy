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
    this.reservations = new Set();
    this.disposing = new Map();
    this.offers = new Map();
    this.waiters = new Set();
    this.protectedKeys = new Set();
    pools.add(this);
  }
  track(worker) { this.workers.add(worker); }
  count(key) { return this.idle.filter(w=>w.key===key).length; }
  pending(key) { return this.offers.get(key)?.size??0; }
  offer(key,promise) {
    const offers=this.offers.get(key)??new Set(),entry={promise,claimed:false};
    offers.add(entry);this.offers.set(key,offers);
    const remove=()=>{offers.delete(entry);if(!offers.size)this.offers.delete(key);};
    promise.then(remove,remove);
  }
  async acquire(key,signal) {
    signal?.throwIfAborted();const ready=this.take(key);if(ready)return ready;
    const entry=[...(this.offers.get(key)??[])].find(e=>!e.claimed);
    if(!entry||this.closed)return;
    entry.claimed=true;
    return new Promise((resolve,reject)=>{
      const waiter={key,finish:(worker,error)=>{if(!this.waiters.delete(waiter))return;signal?.removeEventListener('abort',abort);entry.claimed=false;if(error)reject(error);else resolve(worker);}};
      const abort=()=>waiter.finish(undefined,signal.reason),ready=()=>{if(this.waiters.has(waiter))waiter.finish(this.take(key));};
      this.waiters.add(waiter);signal?.addEventListener('abort',abort,{once:true});entry.promise.then(ready,ready);if(signal?.aborted)abort();
    });
  }
  take(key) {
    const index = this.idle.findIndex(w => w.key === key);
    if (index < 0 || this.closed) return;
    const [worker] = this.idle.splice(index, 1);
    clearTimeout(worker.idleTimer);
    worker.child.ref(); worker.child.stdout.ref?.(); worker.child.stderr.ref?.(); worker.mcp.ref();
    return worker;
  }
  discard(worker) {
    if (this.disposing.has(worker)) return this.disposing.get(worker);
    this.idle = this.idle.filter(w => w !== worker);
    this.reservations.delete(worker);
    clearTimeout(worker.idleTimer);
    const task = Promise.resolve().then(() => worker.dispose()).finally(() => {
      this.workers.delete(worker);
      this.disposing.delete(worker);
    });
    this.disposing.set(worker, task);
    return task;
  }
  // Reserve before the expensive session/config reset. Idle and resetting
  // workers share the same budget; active requests have no pool-imposed limit.
  reserveIdle(worker) {
    if (this.closed || !this.config.workerReuse || this.config.maxIdleWorkers === 0) return false;
    if (this.reservations.has(worker)) return true;
    const retained = [...this.idle, ...this.reservations];
    if (retained.length >= this.config.maxIdleWorkers) {
      // Keep an already-clean (or resetting) worker over another copy of it.
      if (retained.some(w => w.key === worker.key)) return false;
      const replaceable = this.idle.find(w => !this.protectedKeys.has(w.key) || retained.filter(other => other.key === w.key).length > 1);
      const victim = replaceable ?? (this.protectedKeys.has(worker.key) ? this.idle[0] : undefined);
      if (!victim) return false;
      // Removing the lease is synchronous; independent process teardown must
      // not serialize the rest of a concurrent completion burst.
      void this.discard(victim).catch(() => {});
    }
    this.reservations.add(worker);
    return true;
  }
  async put(worker) {
    if (!this.reserveIdle(worker)) return this.discard(worker);
    this.reservations.delete(worker);
    this.idle.push(worker);
    const expire=()=>{
      if(!this.closed&&this.protectedKeys.has(worker.key)&&this.idle.includes(worker)){worker.idleTimer=setTimeout(expire,this.config.workerIdleMs);worker.idleTimer.unref();}
      else void this.discard(worker).catch(() => {});
    };
    worker.idleTimer = setTimeout(expire, this.config.workerIdleMs);worker.idleTimer.unref();
    worker.child.unref(); worker.child.stdout.unref?.(); worker.child.stderr.unref?.(); worker.mcp.unref();
    for(const waiter of this.waiters)if(waiter.key===worker.key){const ready=this.take(worker.key);if(!ready)break;waiter.finish(ready);}
  }
  async close() {
    this.closed = true;
    for(const waiter of this.waiters)waiter.finish();
    this.protectedKeys.clear();
    pools.delete(this);
    await Promise.allSettled([...this.workers].map(w => this.discard(w)));
  }
}
