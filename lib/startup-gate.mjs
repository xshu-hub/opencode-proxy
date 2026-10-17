// Pace expensive cold starts without limiting admitted requests or inference.
export class StartupGate {
 constructor(limit=2){this.limit=limit;this.active=0;this.queue=[];}
 acquire(signal){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
   const entry={signal,resolve,reject};
   entry.abort=()=>{const i=this.queue.indexOf(entry);if(i>=0)this.queue.splice(i,1);reject(signal.reason);};
   signal?.addEventListener('abort',entry.abort,{once:true});this.queue.push(entry);this.drain();
  });
 }
 drain(){
  while(this.active<this.limit&&this.queue.length){
   const entry=this.queue.shift();entry.signal?.removeEventListener('abort',entry.abort);
   if(entry.signal?.aborted){entry.reject(entry.signal.reason);continue;}
   this.active++;let released=false;
   entry.resolve(()=>{if(released)return;released=true;this.active--;this.drain();});
  }
 }
}
export const workerStartupGate=new StartupGate();
