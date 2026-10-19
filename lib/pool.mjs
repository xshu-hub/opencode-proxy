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
  async discard(worker) {
    this.idle = this.idle.filter(w => w !== worker);
    clearTimeout(worker.idleTimer);
    this.workers.delete(worker);
    await worker.dispose();
  }
  put(worker) {
    const operation = this.retention.then(async () => {
      if (this.closed || !this.config.workerReuse || this.config.maxIdleWorkers === 0) return this.discard(worker);
      while (this.idle.length >= this.config.maxIdleWorkers) {
        const replaceable=this.idle.find(w=>!this.protectedKeys.has(w.key)||this.count(w.key)>1);
        if(!replaceable&&(!this.protectedKeys.has(worker.key)||this.count(worker.key)>0))return this.discard(worker);
        await this.discard(replaceable??this.idle[0]);
      }
      if (this.closed) return this.discard(worker);
      this.idle.push(worker);
      const expire=()=>{
        if(!this.closed&&this.protectedKeys.has(worker.key)&&this.idle.includes(worker)){worker.idleTimer=setTimeout(expire,this.config.workerIdleMs);worker.idleTimer.unref();}
        else void this.discard(worker).catch(() => {});
      };
      worker.idleTimer = setTimeout(expire, this.config.workerIdleMs);worker.idleTimer.unref();
      worker.child.unref(); worker.child.stdout.unref?.(); worker.child.stderr.unref?.(); worker.mcp.unref();
      for(const waiter of this.waiters)if(waiter.key===worker.key){const ready=this.take(worker.key);if(!ready)break;waiter.finish(ready);}
    });
    this.retention = operation.catch(() => {});
    return operation;
  }
  async close() {
    this.closed = true;
    for(const waiter of this.waiters)waiter.finish();
    this.protectedKeys.clear();
    pools.delete(this);
    await this.retention;
    await Promise.allSettled([...this.workers].map(w => this.discard(w)));
  }
}
