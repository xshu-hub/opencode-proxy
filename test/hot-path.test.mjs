import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkerPool} from '../lib/pool.mjs';
import {OpenCodeBridge} from '../lib/bridge.mjs';
import {sseEvents} from '../lib/protocol.mjs';
const streams={ref(){},unref(){}};
const worker=(key,disposed)=>({key,child:{...streams,stdout:streams,stderr:streams,kill(){}},mcp:streams,dispose:async()=>{disposed.add(key);}});

test('hot retention protects each selected model, bounds idle memory and expires other workers',async()=>{
 const pool=new WorkerPool({workerReuse:true,maxIdleWorkers:2,workerIdleMs:20}),disposed=new Set();pool.protectedKeys=new Set(['a','b']);
 try{for(const key of ['a','b','a','c']){const item=worker(key,disposed);pool.track(item);await pool.put(item);}await delay(55);assert.deepEqual(pool.idle.map(w=>w.key).sort(),['a','b']);assert.equal(pool.workers.size,2);assert.ok(disposed.has('c'));assert.equal(pool.take('a').key,'a');assert.equal(pool.take('missing'),undefined);}finally{await pool.close();}assert.equal(pool.workers.size,0);
});

test('ready leases win over a slow warmup; one pending worker never serializes a burst',async()=>{
 const pool=new WorkerPool({workerReuse:true,maxIdleWorkers:2,workerIdleMs:10000}),disposed=new Set(),slow=Promise.withResolvers(),cancel=new AbortController();
 try{
  pool.offer('a',slow.promise);const first=pool.acquire('a');assert.equal(await pool.acquire('a'),undefined,'Other requests can create exclusive workers');assert.equal(await pool.acquire('b'),undefined);
  const ready=worker('a',disposed);pool.track(ready);await pool.put(ready);assert.equal(await first,ready,'Use the first safely reset worker, not the slow warmup');
  const failed=Promise.withResolvers();pool.offer('b',failed.promise);const pending=pool.acquire('b',cancel.signal);cancel.abort(new Error('cancelled waiting'));await assert.rejects(pending,/cancelled waiting/);failed.resolve();slow.resolve();assert.equal(pool.waiters.size,0);
 }finally{slow.resolve();await pool.close();}
});

test('completed workers reserve a bounded reset budget without limiting active requests',async()=>{
 const pool=new WorkerPool({workerReuse:true,maxIdleWorkers:2,workerIdleMs:10000}),disposed=new Set();
 const workers=Array.from({length:8},()=>worker('a',disposed));
 try{
  for(const item of workers)pool.track(item);
  assert.equal(pool.workers.size,8);
  assert.deepEqual(workers.map(item=>pool.reserveIdle(item)),[true,true,false,false,false,false,false,false]);
  assert.equal(pool.reservations.size,2);assert.equal(pool.idle.length,0,'Resetting workers cannot be leased');
  await Promise.all(workers.slice(2).map(item=>pool.discard(item)));
  await pool.put(workers[0]);await pool.put(workers[1]);
  assert.equal(pool.reservations.size,0);assert.equal(pool.idle.length,2);
  assert.equal(pool.take('a'),workers[0]);
  assert.equal(pool.reserveIdle(workers[0]),true,'An active lease frees its idle/reset slot');
  await pool.discard(workers[0]);assert.equal(pool.reservations.size,0,'Failed resets release capacity');
 }finally{await pool.close();}
});

test('slow process disposal does not serialize other evictions and shutdown waits for all of them',async()=>{
 const pool=new WorkerPool({workerReuse:true,maxIdleWorkers:1,workerIdleMs:10000}),gate=Promise.withResolvers(),started=[];
 const make=key=>({...worker(key,new Set()),dispose:async()=>{started.push(key);await gate.promise;}});
 const pending=[];
 try{
  const a=make('a'),b=make('b'),c=make('c');for(const item of [a,b,c])pool.track(item);
  await pool.put(a);pending.push(pool.put(b),pool.put(c));await delay(0);
  assert.deepEqual(started,['a','b']);assert.equal(pool.idle[0],c);
  assert.equal(pool.workers.size,3,'Exiting processes remain owned until teardown completes');
  let closed=false;const closing=pool.close().then(()=>{closed=true;});await delay(0);
  assert.deepEqual(started,['a','b','c']);assert.equal(closed,false);
  gate.resolve();await closing;assert.equal(pool.workers.size,0);
 }finally{gate.resolve();await Promise.allSettled(pending);await pool.close();}
});

test('hot targets deduplicate model aliases and rotate toward recently requested models',async()=>{
 const a={model:'fixture/a',context:10000,output:1000},b={model:'fixture/b',context:10000,output:1000},c={model:'fixture/c',context:10000,output:1000};
 const bridge=new OpenCodeBridge({mode:'global',discoverModels:false,maxIdleWorkers:2,models:{a,alias:a,b,c}});bridge.replenish=async()=>{};
 try{await bridge.prewarm(['a','alias','b','c']);assert.deepEqual(bridge.warmTargets,['a','b']);bridge.touchHotModel('c');assert.deepEqual(bridge.warmTargets,['c','a']);bridge.touchHotModel('alias');assert.deepEqual(bridge.warmTargets,['alias','c']);assert.equal(bridge.pool.protectedKeys.size,2);}finally{await bridge.close();}
});
test('pausing warmup during catalog loading cannot restore hot targets after stop',async()=>{
 const bridge=new OpenCodeBridge({mode:'global',discoverModels:false}),gate=Promise.withResolvers();let prepared=false;bridge.loadModels=()=>gate.promise;bridge.replenish=async()=>{prepared=true;};
 try{const task=bridge.prewarm(['oc-default']);bridge.pauseWarmup();gate.resolve();await task;assert.equal(prepared,false);assert.equal(bridge.warmTargets.length,0);assert.equal(bridge.pool.protectedKeys.size,0);}finally{gate.resolve();await bridge.close();}
});
const event=(part)=>({type:'message.part.updated',properties:{part:{sessionID:'s',messageID:'m',...part}}});
function run(events,extra={}){return{events,signal:new AbortController().signal,sessionID:'s',abort:async()=>{},cleanup:async()=>{},...extra};}
const assistant={type:'message.updated',properties:{info:{id:'m',sessionID:'s',role:'assistant'}}};
const finish=event({id:'finish',type:'step-finish',reason:'stop',tokens:{input:1,output:1}});
test('successful terminal output precedes slow cleanup and close still drains cleanup',async()=>{
 const bridge=new OpenCodeBridge({mode:'global',discoverModels:false}),gate=Promise.withResolvers();let cleaned=false;
 bridge.prepare=async()=>run((async function*(){yield assistant;yield event({id:'text',type:'text',text:'VISIBLE'});yield finish;})(),{abort:()=>bridge.track(gate.promise),finishCleanup(){bridge.track(gate.promise.then(()=>{cleaned=true;}));}});
 try{const response=await bridge.fetch('http://bridge/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'oc-default',messages:[{role:'user',content:'hello'}],stream:true})});const text=await Promise.race([response.text(),delay(500).then(()=>{throw new Error('Completion waited for cleanup');})]);assert.ok(text.includes('[DONE]'));assert.equal(cleaned,false);let closed=false;const closing=bridge.close().then(()=>{closed=true;});await delay(0);assert.equal(closed,false);gate.resolve();await closing;assert.equal(cleaned,true);}finally{gate.resolve();await bridge.close();}
});

test('native tool identity streams before complete arguments without duplication or early success',async()=>{
 const bridge=new OpenCodeBridge({mode:'global',discoverModels:false}),gate=Promise.withResolvers();const {nativeToolName}=await import('../lib/protocol.mjs');
 const tool={type:'function',function:{name:'lookup',strict:true,parameters:{type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}}};
 bridge.prepare=async()=>run((async function*(){yield assistant;yield event({id:'tool',type:'tool',callID:'call',tool:nativeToolName('lookup'),state:{status:'pending',raw:'',input:{}}});await gate.promise;yield event({id:'tool',type:'tool',callID:'call',tool:nativeToolName('lookup'),state:{status:'running',input:{city:'北京🙂'}}});yield event({id:'finish',type:'step-finish',reason:'tool-calls',tokens:{input:1,output:1}});})());
 try{const response=await bridge.fetch('http://bridge/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'oc-default',messages:[{role:'user',content:'hello'}],tools:[tool],stream:true})}),iterator=sseEvents(response.body);await iterator.next();const start=(await iterator.next()).value.choices[0].delta.tool_calls[0];assert.equal(start.id,'call');assert.equal(start.function.name,'lookup');assert.equal(start.function.arguments,'');gate.resolve();const rest=await Array.fromAsync(iterator);const delta=rest.flatMap(c=>c.choices?.[0]?.delta.tool_calls??[]);assert.equal(delta.length,1);assert.deepEqual(JSON.parse(delta[0].function.arguments),{city:'北京🙂'});assert.equal(delta[0].id,undefined);assert.equal(rest.at(-1).choices[0].finish_reason,'tool_calls');
  const json=await bridge.fetch('http://bridge/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'oc-default',messages:[{role:'user',content:'hello'}],tools:[tool]})});const call=(await json.json()).choices[0].message.tool_calls[0];assert.equal(call.id,'call');assert.equal(call.function.name,'lookup');assert.equal(call.function.arguments,'{"city":"北京🙂"}');
 }finally{gate.resolve();await bridge.close();}
});

test('an unfinished native tool emits an error instead of a usable call completion',async()=>{
 const bridge=new OpenCodeBridge({mode:'global',discoverModels:false}),{nativeToolName}=await import('../lib/protocol.mjs');bridge.prepare=async()=>run((async function*(){yield assistant;yield event({id:'t',type:'tool',callID:'call',tool:nativeToolName('lookup'),state:{status:'pending',raw:'',input:{}}});yield event({id:'f',type:'step-finish',reason:'tool-calls',tokens:{input:1,output:1}});})());
 try{const r=await bridge.fetch('http://bridge/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'oc-default',messages:[{role:'user',content:'hello'}],tools:[{type:'function',function:{name:'lookup'}}],stream:true})}),events=await Array.fromAsync(sseEvents(r.body));assert.equal(events.at(-1).error.code,'incomplete_tool_call');assert.ok(!events.some(e=>e.choices?.[0]?.finish_reason));}finally{await bridge.close();}
});
