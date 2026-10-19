import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkerPool} from '../lib/pool.mjs';
import {OpenCodeBridge} from '../lib/bridge.mjs';
import {ProxyRuntime} from '../lib/runtime.mjs';
import {sseEvents} from '../lib/protocol.mjs';
import {createProxyServer} from '../lib/http-server.mjs';
import {adaptResponse} from '../lib/outward-protocols.mjs';
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

test('gateway warmup is asynchronous, selects enabled models and cannot resurrect a closed generation',async()=>{
 const gate=Promise.withResolvers(),calls=[];
 class Bridge{
  constructor(config){this.config=config;this.config.models={a:{enabled:true},b:{enabled:false},c:{enabled:true}};this.acceptedModels=this.config.models;}
  async loadModels(){return this.config.models;}
  async prewarm(models){calls.push(models);await gate.promise;}
  async close(){this.closed=true;gate.resolve();}
 }
 const runtime=new ProxyRuntime({file:'fixture/settings.json',settings:{mode:'global',host:'127.0.0.1',port:0,apiKeys:[],modelOverrides:{}},Bridge});
 try{await runtime.startGateway();assert.ok(runtime.gateway.listening);await delay(0);assert.deepEqual(calls,[['a','c']]);assert.equal(runtime.current.active,0);await runtime.initialize();assert.equal(calls.length,1);}finally{await runtime.close();}assert.equal(runtime.current.bridge.closed,true);
});

const event=(part)=>({type:'message.part.updated',properties:{part:{sessionID:'s',messageID:'m',...part}}});
test('retired generations finish client streams before slow bridge shutdown and remain owned until closed',async()=>{
 const gate=Promise.withResolvers();let closing=false;
 class Bridge{constructor(config){this.config=config;this.acceptedModels=config.models;}async loadModels(){}async fetch(){return new Response('done');}async close(){closing=true;await gate.promise;}}
 const runtime=new ProxyRuntime({file:'fixture/settings.json',settings:{mode:'global',discoverModels:false,apiKeys:[]},Bridge});
 try{const response=await runtime.fetch('http://fixture/health');runtime.current.retired=true;assert.equal(await Promise.race([response.text(),delay(500).then(()=>{throw new Error('EOF waited for retired bridge');})]),'done');assert.equal(closing,true);assert.equal(runtime.generations.size,1);let closed=false;const task=runtime.close().then(()=>{closed=true;});await delay(0);assert.equal(closed,false);gate.resolve();await task;assert.equal(runtime.generations.size,0);}finally{gate.resolve();await runtime.close();}
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

for(const protocol of ['responses','anthropic'])test(`${protocol} exposes a tool identity before gated arguments and completes it exactly once`,async()=>{
 const gate=Promise.withResolvers(),encode=value=>new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n');
 const source=new Response(new ReadableStream({async start(c){c.enqueue(encode({choices:[{delta:{tool_calls:[{index:0,id:'early-call',type:'function',function:{name:'lookup',arguments:''}}]}}]}));await gate.promise;c.enqueue(encode({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'{"city":"北京🙂"}'}}]}}]}));c.enqueue(encode({choices:[{delta:{},finish_reason:'tool_calls'}]}));c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));c.close();}}),{headers:{'content-type':'text/event-stream'}});
 try{
  const response=await adaptResponse(protocol,source,{model:'demo',stream:true}),events=sseEvents(response.body),seen=[];
  const identity=await Promise.race([(async()=>{for(;;){const {value:event,done}=await events.next();assert.equal(done,false);seen.push(event);if(protocol==='responses'?event.item?.type==='function_call':event.content_block?.type==='tool_use')return event;}})(),delay(500).then(()=>{throw new Error('Tool identity buffered until arguments');})]);
  assert.equal(protocol==='responses'?identity.item.call_id:identity.content_block.id,'early-call');assert.equal(seen.some(e=>e.type.endsWith('.done')||e.type==='content_block_stop'),false);gate.resolve();const rest=await Array.fromAsync(events);seen.push(...rest);const deltas=seen.filter(e=>protocol==='responses'?e.type==='response.function_call_arguments.delta':e.delta?.type==='input_json_delta');assert.equal(deltas.length,1);assert.deepEqual(JSON.parse(protocol==='responses'?deltas[0].delta:deltas[0].delta.partial_json),{city:'北京🙂'});assert.equal(seen.filter(e=>protocol==='responses'?e.type==='response.output_item.added':e.type==='content_block_start').length,1);assert.equal(seen.at(-1).type,protocol==='responses'?'response.completed':'message_stop');
 }finally{gate.resolve();}
});

test('successful SSE flushes headers, sends comment heartbeats and preserves real error statuses',async()=>{
 const gate=Promise.withResolvers();let cancelled=false;
 const server=createProxyServer({apiKey:'fixture',heartbeatMs:20,bridge:{close:async()=>{},fetch:async url=>url.endsWith('/bad')?Response.json({error:{message:'limited'}},{status:429}):new Response(new ReadableStream({async start(c){await gate.promise;c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));c.close();},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}})}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const response=await Promise.race([fetch(base+'/v1/chat/completions',{headers:{authorization:'Bearer fixture'}}),delay(500).then(()=>{throw new Error('Headers waited for body');})]);assert.equal(response.status,200);const reader=response.body.getReader(),first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/: keepalive/);assert.ok(!first.includes('data:'));gate.resolve();let rest='';for(;;){const {value,done}=await reader.read();if(done)break;rest+=new TextDecoder().decode(value);}assert.match(rest,/\[DONE\]/);assert.equal(cancelled,false);
  const error=await fetch(base+'/bad',{headers:{authorization:'Bearer fixture'}});assert.equal(error.status,429);assert.equal((await error.json()).error.message,'limited');
 }finally{gate.resolve();await server.shutdown();}
});
