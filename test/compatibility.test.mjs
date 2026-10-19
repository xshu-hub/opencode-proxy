import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ResponseStore} from '../lib/response-store.mjs';
import {ProxyRuntime} from '../lib/runtime.mjs';
import {OpenCodeBridge} from '../lib/bridge.mjs';
import {upstreamError} from '../lib/upstream-errors.mjs';
import {sseEvents} from '../lib/protocol.mjs';
import {validateRequest,toNativeHistory,toolPermissions} from '../lib/protocol.mjs';
import {toChatRequest} from '../lib/outward-protocols.mjs';
import {nativeGeneration} from '../lib/generation.mjs';
import {assertSchema,compileSchema} from '../lib/schema.mjs';
import {StartupGate} from '../lib/startup-gate.mjs';

test('live regression reader captures Anthropic thinking deltas and can interrupt during reasoning',async()=>{
 const {mkdtemp,rmdir}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),path=await import('node:path');
 const dir=await mkdtemp(path.join(tmpdir(),'opencode-thinking-reader-')),keys=['OPENCODE_PROXY_LIVE_URL','OPENCODE_PROXY_LIVE_KEY','OPENCODE_PROXY_LIVE_REPORT_DIR'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]])),originalFetch=globalThis.fetch;
 try{
  process.env.OPENCODE_PROXY_LIVE_URL='http://fixture/v1';process.env.OPENCODE_PROXY_LIVE_KEY='fixture-key';process.env.OPENCODE_PROXY_LIVE_REPORT_DIR=dir;
  const {request}=await import('../scripts/live-client.mjs?thinking-reader');
  const events=[{type:'message_start',message:{usage:{input_tokens:2,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'真实思考🙂'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:3}},{type:'message_stop'}];
  globalThis.fetch=async()=>new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  const response=await request('anthropic',{model:'demo',stream:true});assert.equal(response.reasoning,'真实思考🙂');assert.ok(response.firstOutputMs!==null);assert.equal(response.firstTextMs,null);
  const cancelled=await request('anthropic',{model:'demo',stream:true},{cancel:'reasoning'});assert.equal(cancelled.cancelled,true);assert.equal(cancelled.cancelStage,'reasoning');
 }finally{globalThis.fetch=originalFetch;for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}await rmdir(dir);}
});
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
test('JSON output formats and Anthropic/Responses tool choices normalize without dropping constraints',()=>{
 const schema={type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false};
 const r=toChatRequest('responses',{model:'demo',input:'hello',text:{format:{type:'json_schema',name:'result',strict:true,schema}}});
 validateRequest(r,{demo:{output:100}});assert.deepEqual(nativeGeneration(r).format.schema,schema);
 const a=toChatRequest('anthropic',{model:'demo',max_tokens:100,messages:[{role:'user',content:'hello'}],output_config:{format:{type:'json_schema',schema}}});
 validateRequest(a,{demo:{output:100}});assert.deepEqual(nativeGeneration(a).format.schema,schema);
 const tools=[{name:'weather',input_schema:{type:'object'}}];
 const forced=toChatRequest('anthropic',{model:'demo',max_tokens:100,messages:[{role:'user',content:'hello'}],tools,tool_choice:{type:'tool',name:'weather',disable_parallel_tool_use:true}});
 validateRequest(forced,{demo:{output:100}});assert.deepEqual(forced.tool_choice,{type:'function',function:{name:'weather'}});assert.equal(forced.parallel_tool_calls,false);
});
test('inline attachments retain native file parts, respect advertised modalities and reject local/remote file access',()=>{
 const image='data:image/png;base64,'+Buffer.from('fixture image bytes').toString('base64'),models={demo:{output:100,inputModalities:['text','image','pdf','audio']}};
 const messages=[{role:'user',content:[{type:'text',text:'look'},{type:'image_url',image_url:{url:image}}]}],body={model:'demo',messages};
 validateRequest(body,models);const native=toNativeHistory(body,'session','demo','directory','provider');assert.equal(native.messages[0].parts[1].type,'file');assert.equal(native.messages[0].parts[1].mime,'image/png');assert.equal(native.messages[0].parts[1].url,image);
 assert.throws(()=>validateRequest(body,{demo:{output:100,inputModalities:['text']}}),e=>e.status===400&&e.code==='unsupported_modality');
 for(const url of ['file:///C:/secret.txt','https://example.invalid/image.png','data:image/png;base64,bad!'])assert.throws(()=>validateRequest({model:'demo',messages:[{role:'user',content:[{type:'image_url',image_url:{url}}]}]},models),e=>e.status===400);
 const responses=toChatRequest('responses',{model:'demo',input:[{role:'user',content:[{type:'input_text',text:'look'},{type:'input_image',image_url:image}]}]});validateRequest(responses,models);
 const anthropic=toChatRequest('anthropic',{model:'demo',max_tokens:100,messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:Buffer.from('fixture image bytes').toString('base64')}}]}]});validateRequest(anthropic,models);
 const file=toChatRequest('responses',{model:'demo',input:[{role:'user',content:[{type:'input_file',filename:'note.txt',file_data:'data:text/plain;base64,'+Buffer.from('文本附件').toString('base64')}]}]});validateRequest(file,models);assert.match(JSON.stringify(toNativeHistory(file,'session','demo','directory')),/文本附件/);
});

const input=[{role:'user',content:'secret'}],response=id=>({id,model:'demo',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'answer'}]}]});
test('stored responses enforce ownership, expiry, bounded eviction and immutable history',()=>{
 let now=0;const cache=new ResponseStore({now:()=>now,ttlMs:100,maxEntries:2,maxBytes:10000,maxEntryBytes:1000});
 const original=response('a');cache.put(original,input,'alice');original.output[0].content[0].text='mutated';
 assert.equal(cache.get('a','alice').response.output[0].content[0].text,'answer');
 assert.throws(()=>cache.get('a','bob'),e=>e.status===404);
 assert.throws(()=>cache.get('a',undefined),e=>e.status===401);
 const expanded=cache.expand({previous_response_id:'a',input:'continue',instructions:'new instruction',store:false},'alice');
 assert.equal(expanded.model,'demo');assert.equal(expanded.input.length,3);assert.equal(expanded.instructions,'new instruction');
 expanded.input[0].content='changed';assert.equal(cache.get('a','alice').input[0].content,'secret');
 cache.put(response('b'),input,'alice');cache.put(response('c'),input,'bob');assert.throws(()=>cache.get('a','alice'),e=>e.status===404);
 assert.throws(()=>cache.put(response('huge'),[{role:'user',content:'x'.repeat(1100)}],'alice'),e=>e.status===413);
 now=101;assert.throws(()=>cache.get('c','bob'),e=>e.status===404);assert.equal(cache.bytes,0);
});
class Bridge{
 constructor(config){this.config={...config,models:{demo:{model:'fixture/demo',output:4096,context:100000}}};this.acceptedModels=this.config.models;this.requests=[];}
 async loadModels(){return this.config.models;}
 async close(){}
 async fetch(url,init){
  const body=JSON.parse(init.body);this.requests.push(body);const result={choices:[{message:{role:'assistant',content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:1,total_tokens:6}};
  if(!body.stream)return Response.json(result);
  const chunks=[{choices:[{delta:{content:'answer'},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}],usage:result.usage}];
  return new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }
}
test('Responses state is opt-in and usable over authenticated HTTP, including streaming, continuation, retrieval and delete',async()=>{
 const runtime=new ProxyRuntime({file:'test-response-state.json',settings:{mode:'global',host:'127.0.0.1',port:0,discoverModels:false,apiKeys:[{id:'alice',name:'alice',key:'alice-access-key',enabled:true},{id:'bob',name:'bob',key:'bob-access-key',enabled:true}],modelOverrides:{}},Bridge});
 await runtime.startGateway();const base=runtime.state().endpoint;
 const send=async(route,method='GET',body,key='alice-access-key')=>fetch(base+route,{method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  const preflight=await fetch(base+'/responses/resp_example',{method:'OPTIONS',headers:{origin:'http://localhost:3000','access-control-request-method':'DELETE','access-control-request-headers':'authorization'}});assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-methods'),/DELETE/);
  for(const stream of [false,true]){
   const r=await send('/responses','POST',{model:'demo',input:'secret',instructions:'old instruction',store:true,stream});assert.equal(r.status,200);
   const first=stream?(await Array.fromAsync(sseEvents(r.body))).at(-1).response:await r.json();assert.equal(first.store,true);
   assert.equal((await send('/responses/'+first.id)).status,200);
   assert.equal((await send('/responses/'+first.id,'GET',undefined,'bob-access-key')).status,404);
   assert.equal((await send('/responses/'+first.id,'DELETE',undefined,'bob-access-key')).status,404);
   const next=await send('/responses','POST',{previous_response_id:first.id,input:'continue',instructions:'new instruction',store:true});
   assert.equal(next.status,200,await(next.status===200?Promise.resolve(''):next.text()));const second=await next.json();assert.equal(second.previous_response_id,first.id);
   const sent=runtime.current.bridge.requests.at(-1);assert.deepEqual(sent.messages.map(x=>x.content),['new instruction','secret','answer','continue']);
   const deleted=await(await send('/responses/'+first.id,'DELETE')).json();assert.equal(deleted.deleted,true);assert.equal((await send('/responses/'+first.id)).status,404);
   assert.equal((await send('/responses/'+second.id)).status,200,'Deleting a parent must not break an existing child snapshot');
  }
  const stateless=await(await send('/responses','POST',{model:'demo',input:'private',store:false})).json();assert.equal(stateless.store,false);assert.equal((await send('/responses/'+stateless.id)).status,404);
  const implicit=await(await send('/responses','POST',{model:'demo',input:'private'})).json();assert.equal(implicit.store,false);assert.equal((await send('/responses/'+implicit.id)).status,404);
  assert.equal((await send('/responses/%E0%A4')).status,400);
  assert.equal(runtime.current.active,0);
 }finally{await runtime.close();assert.equal(runtime.responses.entries.size,0);}
});
test('upstream failures preserve status and only the retry-after public header',()=>{
 const e=upstreamError({name:'APIError',data:{message:'limited',statusCode:429,responseHeaders:{'Retry-After':'7','X-Private-Token':'secret'}}});
 assert.equal(e.status,429);assert.equal(e.code,'upstream_rate_limit');assert.deepEqual(e.headers,{'retry-after':'7'});
 assert.equal(upstreamError({name:'ContextOverflowError',data:{message:'too long'}}).status,400);
 assert.equal(upstreamError({name:'ProviderAuthError',data:{message:'expired'}}).status,401);
 assert.equal(upstreamError({name:'APIError',data:{statusCode:503}}).status,503);
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
