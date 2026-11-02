import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OpenCodeBridge} from '../lib/bridge.mjs';
import {upstreamError,retryError} from '../lib/upstream-errors.mjs';
import {sseEvents} from '../lib/protocol.mjs';
import {validateRequest,toNativeHistory,toolPermissions} from '../lib/protocol.mjs';
import {nativeGeneration} from '../lib/generation.mjs';
import {assertSchema,compileSchema} from '../lib/schema.mjs';
import {StartupGate} from '../lib/startup-gate.mjs';

test('cold-start pacing is FIFO, cancels queued work and never caps active inference leases',async()=>{
 const gate=new StartupGate(2),first=await gate.acquire(),second=await gate.acquire(),cancel=new AbortController();
 let ready=false;const third=gate.acquire().then(release=>{ready=true;return release;});
 const aborted=gate.acquire(cancel.signal);cancel.abort(new Error('cancelled while waiting'));await assert.rejects(aborted,/cancelled while waiting/);
 assert.equal(ready,false);assert.equal(gate.active,2);first();first();const releaseThird=await third;assert.equal(gate.active,2);
 second();releaseThird();assert.equal(gate.active,0);assert.equal(gate.queue.length,0);
});
test('forced, required and serial function choices preserve exact schemas through native structured output',()=>{
 const tool={type:'function',function:{name:'weather',strict:true,parameters:{type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}}},base={model:'demo',messages:[{role:'user',content:'hello'}],tools:[tool]};
 for(const choice of ['required',{type:'function',function:{name:'weather'}}]){
  const body=validateRequest({...base,tool_choice:choice,parallel_tool_calls:false},{demo:{output:100}}),plan=nativeGeneration(body);
  assert.equal(plan.kind,'tools');assert.equal(plan.format.schema.properties.calls.minItems,1);assert.equal(plan.format.schema.properties.calls.maxItems,1);
  assertSchema(plan.format.schema,{calls:[{name:'weather',arguments:{city:'北京'}}]});
  for(const invalid of [{calls:[]},{calls:[{name:'unregistered',arguments:{city:'北京'}}]},{calls:[{name:'weather',arguments:{city:9}}]}])assert.throws(()=>assertSchema(plan.format.schema,invalid),e=>e.status===502);
  assert.deepEqual(toolPermissions(body),{'*':'deny',bridge_structured_output:'allow'});
 }
 assert.equal(nativeGeneration({...base,tool_choice:'none',parallel_tool_calls:false}),undefined);
 const refBody={...base,tool_choice:'required',tools:[{type:'function',function:{name:'weather',parameters:{type:'object',$defs:{city:{type:'string'}},properties:{city:{$ref:'#/$defs/city'}},required:['city'],additionalProperties:true}}}]};
 validateRequest(refBody,{demo:{output:100}});assertSchema(nativeGeneration(refBody).format.schema,{calls:[{name:'weather',arguments:{city:'北京',extra:true}}]});assert.equal(refBody.tools[0].function.parameters.properties.city.$ref,'#/$defs/city');
 for(const tool_choice of ['required',{type:'function',function:{name:'missing'}}])assert.throws(()=>validateRequest({...base,tools:[],tool_choice},{demo:{output:100}}),e=>e.status===400);
 assert.throws(()=>compileSchema({type:'invalid'}),e=>e.status===400);
 assert.throws(()=>compileSchema({$ref:'https://example.invalid/schema'}),e=>e.status===400);
 const formatted={type:'object',properties:{email:{type:'string',format:'email'}},required:['email']};assertSchema(formatted,{email:'test@example.com'});assert.throws(()=>assertSchema(formatted,{email:'invalid'}),e=>e.code==='invalid_structured_output');assert.throws(()=>compileSchema({type:'string',format:'unknown-format'}),e=>e.status===400);
});
test('upstream failures preserve status and only the retry-after public header',()=>{
 const e=upstreamError({name:'APIError',data:{message:'limited',statusCode:429,responseHeaders:{'Retry-After':'7','X-Private-Token':'secret'}}});
 assert.equal(e.status,429);assert.equal(e.code,'upstream_rate_limit');assert.deepEqual(e.headers,{'retry-after':'7'});
 assert.equal(upstreamError({name:'ContextOverflowError',data:{message:'too long'}}).status,400);
 assert.equal(upstreamError({name:'ProviderAuthError',data:{message:'expired'}}).status,401);
 assert.equal(upstreamError({name:'APIError',data:{statusCode:503}}).status,503);
});

test('retry failures retain a bounded upstream reason and distinguish quota refusals from server failures',()=>{
 const quota=retryError({message:'Free usage exceeded, subscribe to Go',attempt:1,next:Date.now()+60000},false);
 assert.equal(quota.status,429);assert.equal(quota.code,'upstream_rate_limit');assert.match(quota.message,/Free usage exceeded/);
 assert.ok(Number(quota.headers['retry-after'])>=1);
 const server=retryError({message:'Service unavailable\nplease try later'},false);
 assert.equal(server.status,503);assert.equal(server.code,'opencode_retry_exhausted');assert.match(server.message,/Upstream: Service unavailable please try later/);
 assert.ok(retryError({message:'x'.repeat(10000)},false).message.length<1200);
 assert.doesNotMatch(retryError({},false).message,/undefined|Upstream:/);
});

for(const stream of [false,true])test('free quota rejection before output remains a public 429 (stream='+stream+')',async()=>{
 const bridge=new OpenCodeBridge({mode:'global',discoverModels:false});let cleaned=0;
 bridge.prepare=async()=>({sessionID:'session',signal:new AbortController().signal,cleanup:async()=>{cleaned++;},abort:async()=>{},events:(async function*(){
  yield{type:'session.status',properties:{sessionID:'session',status:{type:'retry',attempt:1,message:'Free usage exceeded, subscribe to Go',next:Date.now()+180000}}};
 })()});
 try{
  const response=await bridge.fetch('http://bridge/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'oc-default',messages:[{role:'user',content:'hello'}],stream})});
  assert.equal(response.status,429);
  const result=await response.json();assert.equal(result.error.code,'upstream_rate_limit');assert.match(result.error.message,/Free usage exceeded, subscribe to Go/);assert.equal(cleaned,1);
 }finally{await bridge.close();}
});
for(const stream of [false,true])for(const partial of [false,true])test('native retries '+(partial?'after':'before')+' first output (stream='+stream+')',async()=>{
 const bridge=new OpenCodeBridge({mode:'global',discoverModels:false}),ctl=new AbortController();let cleaned=0;
 const info={id:'assistant',role:'assistant',sessionID:'session'};
 bridge.prepare=async()=>({sessionID:'session',signal:ctl.signal,cleanup:async()=>{cleaned++;},abort:async()=>{},events:(async function*(){
  yield{type:'message.updated',properties:{info}};
  if(partial)yield{type:'message.part.updated',properties:{part:{id:'text',sessionID:'session',messageID:'assistant',type:'text',text:'partial'}}};
  yield{type:'session.status',properties:{sessionID:'session',status:{type:'retry',attempt:1,message:'429 Too Many Requests',next:Date.now()+1}}};
  yield{type:'message.part.updated',properties:{part:{id:'text',sessionID:'session',messageID:'assistant',type:'text',text:partial?'partial repeated':'recovered'}}};
  yield{type:'message.part.updated',properties:{part:{id:'finish',sessionID:'session',messageID:'assistant',type:'step-finish',reason:'stop',tokens:{input:1,output:1}}}};
 })()});
 try{
  const r=await bridge.fetch('http://bridge/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'oc-default',messages:[{role:'user',content:'hello'}],stream})});
  const rows=stream?await Array.fromAsync(sseEvents(r.body)):[await r.json()];
  if(partial){assert.equal(r.status,stream?200:429);assert.ok(rows.some(x=>x.error?.code==='upstream_rate_limit'));assert.ok(!rows.some(x=>x.choices?.[0]?.finish_reason==='stop'));}
  else{assert.equal(r.status,200);assert.ok(JSON.stringify(rows).includes('recovered'));assert.ok(!rows.some(x=>x.error));}
  assert.equal(cleaned,1);
 }finally{await bridge.close();}
});
