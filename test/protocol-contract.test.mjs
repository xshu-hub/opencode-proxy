import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adaptResponse,toChatRequest} from '../lib/outward-protocols.mjs';
import {sseEvents,validateRequest,toNativeHistory} from '../lib/protocol.mjs';
import {ResponseStore} from '../lib/response-store.mjs';

const schema={type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false};
const tools=[{type:'namespace',name:'crm',description:'Customer records',tools:[{type:'function',name:'lookup',parameters:schema}]},{type:'namespace',name:'orders',tools:[{type:'function',name:'lookup',parameters:schema}]},{type:'custom',name:'run_code',format:{type:'text'},description:'Execute the exact program supplied'}];
const text='print("鍖椾含馃檪")\nprint("<tag>")\n';
const choice=(delta,finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
function source(chunks,size=1){const bytes=new TextEncoder().encode(chunks.map(c=>'data: '+JSON.stringify(c)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n');let at=0;return new Response(new ReadableStream({pull(c){if(at===bytes.length)c.close();else{const end=Math.min(at+size,bytes.length);c.enqueue(bytes.slice(at,end));at=end;}}}),{headers:{'content-type':'text/event-stream'}});}

for(const stream of [false,true])test(`Responses namespace/custom contract survives JSON and byte-split SSE (stream=${stream})`,async()=>{
 const request={model:'demo',input:'question',tools,stream,store:true},snapshot=structuredClone(request),chat=toChatRequest('responses',request);
 validateRequest(chat,{demo:{output:1000}});
 const names=chat.tools.map(t=>t.function.name);assert.equal(new Set(names).size,3);assert.ok(names.every(n=>n.length<=64));
 const calls=names.map((name,index)=>({index,id:'call_'+index,type:'function',function:{name,arguments:JSON.stringify(index===2?{input:text}:{city:index===0?'鍖椾含':'涓婃捣'})}}));
 const chunks=[choice({reasoning_content:'Checking'}),choice({tool_calls:calls.map(c=>({...c,function:{...c.function,arguments:c.function.arguments.slice(0,4)}}))}),choice({tool_calls:calls.toReversed().map(c=>({index:c.index,function:{arguments:c.function.arguments.slice(4)}}))}),choice({},'tool_calls'),{choices:[],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}];
 const store=new ResponseStore(),response=await adaptResponse('responses',stream?source(chunks):Response.json({choices:[{message:{tool_calls:calls},finish_reason:'tool_calls'}]}),request,r=>store.put(r,request.input,'owner'));
 let result;
 if(stream){
  const events=await Array.fromAsync(sseEvents(response.body));assert.ok(!events.some(e=>e.type==='error'));assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i));assert.equal(events[0].type,'response.created');assert.equal(events[1].type,'response.in_progress');assert.equal(events.at(-1).type,'response.completed');
  const open=new Map(),buffers=new Map();
  for(const event of events){
   if(event.type==='response.output_item.added'){assert.ok(!open.has(event.output_index));open.set(event.output_index,event.item);if(event.item.type.endsWith('tool_call')||event.item.type==='function_call')buffers.set(event.item.id,'');}
   if(['response.function_call_arguments.delta','response.custom_tool_call_input.delta'].includes(event.type)){assert.equal(open.get(event.output_index).id,event.item_id);buffers.set(event.item_id,buffers.get(event.item_id)+event.delta);}
   if(['response.function_call_arguments.done','response.custom_tool_call_input.done'].includes(event.type))assert.equal(event.arguments??event.input,buffers.get(event.item_id));
   if(event.type==='response.output_item.done'){assert.equal(open.get(event.output_index).id,event.item.id);open.delete(event.output_index);}
  }
  assert.equal(open.size,0);result=events.at(-1).response;
 }else result=await response.json();
 const output=result.output.filter(i=>i.type.endsWith('tool_call')||i.type==='function_call');assert.equal(output.length,3);
 assert.deepEqual(output.map(i=>[i.type,i.namespace,i.name]),[['function_call','crm','lookup'],['function_call','orders','lookup'],['custom_tool_call',undefined,'run_code']]);assert.equal(output[2].input,text);assert.ok(!JSON.stringify(result).includes('client_'));
 const outputs=output.toReversed().map(i=>({type:i.type==='custom_tool_call'?'custom_tool_call_output':'function_call_output',call_id:i.call_id,output:'done '+i.call_id}));
 const replay=toChatRequest('responses',{model:'demo',input:[{role:'user',content:'question'},...result.output,...outputs]});validateRequest(replay,{demo:{output:1000}});assert.deepEqual(replay.messages.flatMap(m=>m.tool_calls??[]).map(c=>c.function.name),names);assert.equal(JSON.parse(replay.messages.flatMap(m=>m.tool_calls??[])[2].function.arguments).input,text);
 const expanded=store.expand({previous_response_id:result.id,input:outputs},'owner');assert.equal(expanded.tools,undefined);validateRequest(toChatRequest('responses',expanded),{demo:{output:1000}});assert.deepEqual(request,snapshot);
});

test('advanced tool choice, collision, malformed input and unsupported execution preserve constraints',async()=>{
 for(const choice of [{type:'function',namespace:'crm',name:'lookup'},{type:'custom',name:'run_code'}]){
  const chat=toChatRequest('responses',{model:'demo',input:'hello',tools,tool_choice:choice});validateRequest(chat,{demo:{output:1000}});assert.ok(chat.tools.some(t=>t.function.name===chat.tool_choice.function.name));
 }
 const bad=[{tools:[tools[0],tools[0]]},{tools:[{type:'tool_search',execution:'server'}]},{tools:[{type:'custom',name:'x',format:{type:'grammar',syntax:'lark',definition:'start: "x"'}}]},{tools:[{type:'function',name:'x',defer_loading:true}]},{tools,tool_choice:{type:'function',namespace:'missing',name:'lookup'}},{input:[{type:'custom_tool_call',call_id:'a',name:'x',input:{invalid:true}}]}];
 for(const extra of bad)assert.throws(()=>toChatRequest('responses',{model:'demo',input:'hello',...extra}),e=>e.status===400);
 const name=toChatRequest('responses',{model:'demo',input:'hi',tools}).tools[2].function.name;
 for(const argumentsText of ['{}','{"input":42}','{"input":"x","extra":true}'])await assert.rejects(()=>adaptResponse('responses',Response.json({choices:[{message:{tool_calls:[{id:'a',function:{name,arguments:argumentsText}}]},finish_reason:'tool_calls'}]}),{model:'demo',tools}),e=>e.status===502);
 const response=await adaptResponse('responses',source([choice({tool_calls:[{id:'a',function:{name,arguments:'{"input":42}'}}]}),choice({},'tool_calls')]),{model:'demo',tools,stream:true});const events=await Array.fromAsync(sseEvents(response.body));assert.equal(events.at(-1).type,'error');assert.ok(!events.some(e=>e.type==='response.completed'));
});

test('namespace/custom identities cannot collide with user functions or leak across requests',async()=>{
 const request={model:'demo',input:'hello',tools},chat=toChatRequest('responses',request),alias=chat.tools[2].function.name;
 assert.throws(()=>toChatRequest('responses',{...request,tools:[{type:'function',name:alias},...tools]}),e=>e.status===400&&/collision/.test(e.message));
 const namespaced={type:'namespace',name:'scripts',tools:[{type:'custom',name:'run_code'}]},other=toChatRequest('responses',{model:'demo',input:'hello',tools:[namespaced]});assert.notEqual(other.tools[0].function.name,alias);
 const calls=[{id:'a',function:{name:alias,arguments:'{"input":"x"}'}}];
 const response=await adaptResponse('responses',source([choice({tool_calls:calls}),choice({},'tool_calls')]),{model:'demo',stream:true});const events=await Array.fromAsync(sseEvents(response.body));assert.equal(events.at(-1).type,'error');assert.ok(!events.some(e=>e.type==='response.completed'));
});

test('cancelling a custom stream cancels its source and never stores an unfinished call',async()=>{
 const request={model:'demo',input:'hello',tools,stream:true},alias=toChatRequest('responses',request).tools[2].function.name;let cancelled=false,stored=false;
 const upstream=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(choice({tool_calls:[{id:'a',function:{name:alias,arguments:'{"input":"unfinished'}}]}))+'\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
 const response=await adaptResponse('responses',upstream,request,()=>{stored=true;}),reader=response.body.getReader();
 let added=false;while(!added){const event=new TextDecoder().decode((await reader.read()).value);added=event.includes('response.output_item.added');assert.ok(!event.includes('response.custom_tool_call_input.delta'));}
 await reader.cancel();assert.equal(cancelled,true);assert.equal(stored,false);
});

const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/cYQAAAAASUVORK5CYII=';
for(const protocol of ['responses','anthropic'])test(`${protocol} parallel image tool outputs keep attribution, complete results and modality gates`,()=>{
 const body=protocol==='responses'?{model:'vision',input:[{role:'user',content:'inspect'},{type:'function_call',call_id:'a',name:'screenshot',arguments:'{}'},{type:'function_call',call_id:'b',name:'screenshot',arguments:'{}'},{type:'function_call_output',call_id:'b',output:[{type:'input_text',text:'second'},{type:'input_image',image_url:image}]},{type:'function_call_output',call_id:'a',output:[{type:'input_text',text:'first'},{type:'input_image',image_url:image}]},{role:'user',content:'describe'}]}:{model:'vision',max_tokens:100,messages:[{role:'user',content:'inspect'},{role:'assistant',content:['a','b'].map(id=>({type:'tool_use',id,name:'screenshot',input:{}}))},{role:'user',content:[...['b','a'].map(id=>({type:'tool_result',tool_use_id:id,content:[{type:'text',text:id==='a'?'first':'second'},{type:'image',source:{type:'base64',media_type:'image/png',data:image.split(',')[1]}}]})),{type:'text',text:'describe'}]}]};
 const snapshot=structuredClone(body),chat=toChatRequest(protocol,body),models={vision:{output:1000,inputModalities:['text','image']}};validateRequest(chat,models);
 assert.deepEqual(chat.messages.map(m=>m.role),['user','assistant','tool','tool','user','user']);assert.deepEqual(chat.messages.filter(m=>m.role==='tool').map(m=>[m.tool_call_id,m.content]),[['b','second'],['a','first']]);
 const media=chat.messages[4].content;assert.equal(media.length,4);assert.match(media[0].text,/call_id: b/);assert.match(media[2].text,/call_id: a/);assert.equal(media[1].image_url.url,image);
 const native=toNativeHistory(chat,'session','mock','directory','provider');assert.equal(native.messages.at(-2).parts.filter(p=>p.type==='file').length,2);assert.deepEqual(body,snapshot);
 assert.throws(()=>validateRequest(chat,{vision:{output:1000,inputModalities:['text']}}),e=>e.code==='unsupported_modality');
 const corrupted=JSON.parse(JSON.stringify(body).replaceAll(image.split(',')[1],'invalid-base64'));assert.throws(()=>toChatRequest(protocol,corrupted),e=>e.status===400);
});

test('image tool output rejects incomplete parallel batches and preserves Anthropic tool errors',()=>{
 const messages=[{role:'user',content:'inspect'},{role:'assistant',content:['a','b'].map(id=>({type:'tool_use',id,name:'screenshot',input:{}}))},{role:'user',content:[{type:'tool_result',tool_use_id:'a',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:image.split(',')[1]}}]}]}];
 assert.throws(()=>toChatRequest('anthropic',{model:'vision',max_tokens:100,messages}),e=>e.status===400);
 const body=toChatRequest('anthropic',{model:'demo',max_tokens:100,messages:[{role:'user',content:'inspect'},{role:'assistant',content:[{type:'tool_use',id:'a',name:'screenshot',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'a',is_error:true,content:'Permission denied'}]}]});validateRequest(body,{demo:{output:1000}});assert.equal(body.messages.at(-1).content,'Tool error: Permission denied');
});
