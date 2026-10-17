import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toChatRequest,adaptResponse,observation} from '../lib/outward-protocols.mjs';
import {sseEvents,validateRequest} from '../lib/protocol.mjs';
const usage={prompt_tokens:22,completion_tokens:12,total_tokens:34,prompt_tokens_details:{cached_tokens:7,cache_write_tokens:5},completion_tokens_details:{reasoning_tokens:2}};
const choice=(delta,finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
function source(chunks,split=7){let bytes=new TextEncoder().encode(chunks.map(c=>'data: '+JSON.stringify(c)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n'),index=0;return new Response(new ReadableStream({pull(c){if(index>=bytes.length)c.close();else c.enqueue(bytes.slice(index,index+=split));}}),{headers:{'content-type':'text/event-stream'}});}
test('Responses history preserves system, parallel calls and reversed tool results',()=>{
 const body=toChatRequest('responses',{model:'demo',instructions:'system',input:[{role:'user',content:[{type:'input_text',text:'北京'}]},{type:'function_call',call_id:'a',name:'weather',arguments:'{}'},{type:'function_call',call_id:'b',name:'clock',arguments:'{}'},{type:'function_call_output',call_id:'b',output:'time'},{type:'function_call_output',call_id:'a',output:'sunny'}],max_output_tokens:100,reasoning:{effort:'high'},parallel_tool_calls:true,store:false});
 validateRequest(body,{demo:{output:1000}});assert.equal(body.messages[2].tool_calls.length,2);assert.equal(body.messages[3].tool_call_id,'b');assert.equal(body.reasoning_effort,'high');assert.equal(body.max_completion_tokens,100);
});
test('DSH plugin inventory is ignored on all protocols without changing inference or client input',()=>{
 const schema={type:'object',properties:{dsh_plugin_packages:{type:'string'}}};
 const requests=[
  ['chat',{model:'demo',messages:[{role:'user',content:'hello'}],tools:[{type:'function',function:{name:'inspect',parameters:schema}}],max_tokens:100}],
  ['responses',{model:'demo',instructions:'system',input:[{role:'user',content:'hello'},{type:'function_call',call_id:'a',name:'inspect',arguments:'{}'},{type:'function_call_output',call_id:'a',output:'done'}],tools:[{type:'function',name:'inspect',parameters:schema}],max_output_tokens:100}],
  ['anthropic',{model:'demo',system:'system',messages:[{role:'user',content:'hello'},{role:'assistant',content:[{type:'tool_use',id:'a',name:'inspect',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'a',content:'done'}]}],tools:[{name:'inspect',input_schema:schema}],max_tokens:100}],
 ];
 const inventories=[{version:1,packages:[]},{version:1,packages:[{name:'@deepseek-ai/dsh-example',version:'0.1.1-rc.2'},{name:'@deepseek-ai/dsh-example',version:'0.2.0'},{name:'local-plugin'}]}];
 for(const [protocol,request] of requests)for(const stream of [false,true])for(const inventory of inventories){
  const baseline={...request,stream},client=Object.freeze({...structuredClone(baseline),dsh_plugin_packages:structuredClone(inventory)}),snapshot=structuredClone(client);
  const normalized=toChatRequest(protocol,client);
  assert.deepEqual(normalized,toChatRequest(protocol,baseline));assert.equal(Object.hasOwn(normalized,'dsh_plugin_packages'),false);
  validateRequest(normalized,{demo:{output:1000}});assert.deepEqual(client,snapshot);
 }
});
test('DSH compatibility does not allow other unknown fields or unsupported inference semantics',()=>{
 for(const [protocol,request] of [['chat',{messages:[{role:'user',content:'hello'}]}],['responses',{input:'hello'}],['anthropic',{messages:[{role:'user',content:'hello'}],max_tokens:100}]]){
  const body={model:'demo',...request,dsh_plugin_packages:{version:1,packages:[]}};
  for(const field of ['unknown_option','dsh_session_log','dsh_future'])assert.throws(()=>validateRequest(toChatRequest(protocol,{...body,[field]:{}}),{demo:{output:1000}}),e=>e.status===400&&e.param.endsWith(field));
 }
 assert.throws(()=>toChatRequest('responses',{model:'demo',input:'hello',store:true,dsh_plugin_packages:{version:1,packages:[]}}),e=>e.status===400&&e.param==='store');
});
test('Anthropic history preserves text/tool batches/results and adaptive effort',()=>{
 const body=toChatRequest('anthropic',{model:'demo',max_tokens:100,system:[{type:'text',text:'system',cache_control:{type:'ephemeral'}}],messages:[{role:'user',content:'question'},{role:'assistant',content:[{type:'text',text:'calling'},{type:'tool_use',id:'a',name:'weather',input:{city:'北京'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'a',content:[{type:'text',text:'sunny'}]}]}],thinking:{type:'adaptive'},output_config:{effort:'high'}});
 validateRequest(body,{demo:{output:1000}});assert.equal(body.messages[2].tool_calls[0].function.arguments,'{"city":"北京"}');assert.equal(body.messages[3].content,'sunny');assert.equal(body.reasoning_effort,'high');
});
test('Responses JSON and streamed output can be reused unchanged across reasoning/text/tool turns',async()=>{
 for(const stream of [false,true])for(const tools of [false,true]){
  const calls=tools?[{id:'a',type:'function',function:{name:'weather',arguments:'{"city":"北京"}'}},{id:'b',type:'function',function:{name:'clock',arguments:'{}'}}]:[];
  const finish=tools?'tool_calls':'stop',message={role:'assistant',content:'checking',reasoning_content:'思考',...(tools?{tool_calls:calls}:{})};
  const upstream=stream?source([choice({reasoning_content:'思考'}),choice({content:'checking'}),...(tools?[choice({tool_calls:calls.map((c,index)=>({...c,index}))})]:[]),choice({},finish),{choices:[],usage}]):Response.json({choices:[{message,finish_reason:finish}],usage});
  const response=await adaptResponse('responses',upstream,{model:'demo',stream});let result;
  if(stream){for await(const event of sseEvents(response.body))if(event.type==='response.completed')result=event.response;}else result=await response.json();
  const input=[{role:'user',content:'question'},...result.output,...(tools?[{type:'function_call_output',call_id:'b',output:'time'},{type:'function_call_output',call_id:'a',output:'sunny'}]:[]),{role:'user',content:'continue'}],snapshot=structuredClone(input);
  const body=toChatRequest('responses',{model:'demo',input,include:['reasoning.encrypted_content'],store:false});validateRequest(body,{demo:{output:1000}});
  assert.deepEqual(input,snapshot);assert.equal(body.messages.filter(m=>m.reasoning_content).map(m=>m.reasoning_content).join(''),'思考');assert.equal(body.messages.filter(m=>m.role==='assistant').map(m=>m.content??'').join(''),'checking');
  assert.equal(body.messages.flatMap(m=>m.tool_calls??[]).length,calls.length);assert.deepEqual(body.messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id),tools?['b','a']:[]);assert.equal(body.messages.at(-1).content,'continue');
 }
});
test('Responses associates consecutive summaries with the correct turn and rejects opaque state',()=>{
 const body=toChatRequest('responses',{model:'demo',input:[{role:'user',content:'one'},{type:'reasoning',summary:[{type:'summary_text',text:'first'}],encrypted_content:null},{type:'reasoning',summary:[{type:'summary_text',text:' thought'}]},{role:'assistant',content:[{type:'output_text',text:'answer',annotations:[],logprobs:[]}]},{role:'user',content:'two'},{type:'reasoning',summary:[{type:'summary_text',text:'second'}]},{type:'function_call',call_id:'a',name:'weather',arguments:'{}'},{type:'function_call_output',call_id:'a',output:'sunny'}]});
 validateRequest(body,{demo:{output:1000}});assert.equal(body.messages[1].reasoning_content,'first thought');assert.equal(body.messages[3].reasoning_content,'second');
 for(const extra of [{include:['unknown']},{input:[{type:'reasoning',summary:[],encrypted_content:'opaque'},{role:'user',content:'hello'}]}])assert.throws(()=>toChatRequest('responses',{model:'demo',input:'hello',...extra}),e=>e.status===400);
});
test('Anthropic accepts current function-tool streaming preferences without weakening validation',()=>{
 for(const flag of [undefined,null,false,true]){
  const body=toChatRequest('anthropic',{model:'demo',max_tokens:100,top_k:20,stop_sequences:[],stream:true,thinking:{type:'adaptive',display:'omitted'},messages:[{role:'user',content:'hello'}],tools:[{type:'custom',name:'weather',input_schema:{type:'object'},eager_input_streaming:flag,strict:false}]});
  validateRequest(body,{demo:{output:1000}});assert.equal(body.top_k,20);assert.deepEqual(body.tools,[{type:'function',function:{name:'weather',parameters:{type:'object'},strict:false}}]);assert.equal(body.stream_options.include_usage,true);
 }
 for(const patch of [{eager_input_streaming:'yes'},{type:'bash_20250124'},{strict:true},{unrecognized:true}])assert.throws(()=>validateRequest(toChatRequest('anthropic',{model:'demo',max_tokens:100,messages:[{role:'user',content:'hi'}],tools:[{name:'weather',input_schema:{type:'object'},...patch}]}),{demo:{output:1000}}),e=>e.status===400);
 for(const top_k of [-1,1.5,'20'])assert.throws(()=>validateRequest(toChatRequest('anthropic',{model:'demo',max_tokens:100,top_k,messages:[{role:'user',content:'hi'}]}),{demo:{output:1000}}),e=>e.status===400&&e.param==='top_k');
 assert.throws(()=>toChatRequest('anthropic',{model:'demo',max_tokens:100,messages:[{role:'user',content:'hi'}],thinking:{type:'adaptive',display:'summarized'}}),e=>e.status===400&&e.param==='thinking.display');
});
test('Chat accepts harmless standard hints and still rejects unsupported guarantees',()=>{
 const request={model:'demo',messages:[{role:'user',content:'hello'}],stream:true},client={...request,user:'client-user',metadata:{client:'sdk'},store:false,stop:[],response_format:{type:'text'},parallel_tool_calls:true},snapshot=structuredClone(client);
 const body=toChatRequest('chat',client);validateRequest(body,{demo:{output:1000}});assert.deepEqual(body,request);assert.deepEqual(client,snapshot);
 for(const patch of [{store:true},{store:'false'},{user:{}},{metadata:[]},{stop:['END']},{parallel_tool_calls:false},{response_format:{type:'json_schema'}},{tool_choice:'required'}])assert.throws(()=>validateRequest(toChatRequest('chat',{...request,...patch}),{demo:{output:1000}}),e=>e.status===400);
});
test('Anthropic thinking mode toggles are distinct from numeric budgets and honor explicit effort',()=>{
 const request={model:'demo',max_tokens:4096,messages:[{role:'user',content:'hello'}]};
 for(const thinking of [{type:'enabled'},{type:'disabled'},{type:'enabled',budget_tokens:2048}]){
  const client={...request,thinking},snapshot=structuredClone(client),body=toChatRequest('anthropic',client);validateRequest(body,{demo:{output:4096}});assert.deepEqual(body.thinking,thinking);assert.deepEqual(client,snapshot);
 }
 assert.equal(toChatRequest('anthropic',{...request,thinking:{type:'enabled'},output_config:{effort:'low'}}).reasoning_effort,'low');
 for(const thinking of [null,{type:'invalid'},{type:'enabled',budget_tokens:1023},{type:'enabled',budget_tokens:4096},{type:'enabled',budget_tokens:1.5},{type:'disabled',budget_tokens:2048},{type:'adaptive',budget_tokens:2048}])assert.throws(()=>toChatRequest('anthropic',{...request,thinking}),e=>e.status===400);
 assert.throws(()=>toChatRequest('anthropic',{...request,thinking:{type:'enabled'},output_config:{effort:'none'}}),e=>e.status===400);
 assert.throws(()=>toChatRequest('anthropic',{...request,thinking:{type:'disabled'},output_config:{effort:'high'}}),e=>e.status===400);
});
test('Unsupported state, strict-output and signed-thinking semantics fail explicitly',()=>{
 for(const extra of [{previous_response_id:'resp_old'},{store:true},{text:{format:{type:'json_schema'}}},{input:[{role:'user',content:[{type:'input_image',image_url:'x'}]}]}])assert.throws(()=>toChatRequest('responses',{model:'demo',input:'hello',...extra}),e=>e.status===400);
 assert.throws(()=>toChatRequest('anthropic',{model:'demo',messages:[{role:'user',content:'hello'}],max_tokens:100,thinking:{type:'enabled',budget_tokens:100}}),e=>e.status===400);
});
test('Responses streaming emits sequenced events, complete items, Unicode and usage',async()=>{
 const chunks=[choice({reasoning_content:'思考'}),choice({content:'你好'}),choice({tool_calls:[{index:0,id:'a',function:{name:'weather',arguments:'{"city":'}}]}),choice({tool_calls:[{index:0,function:{arguments:'"北京"}'}}]}),choice({},'tool_calls'),{choices:[],usage}];
 const response=await adaptResponse('responses',source(chunks),{model:'demo',stream:true,store:false});const events=[];for await(const e of sseEvents(response.body))events.push(e);
 assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i));assert.equal(events[0].type,'response.created');assert.equal(events.at(-1).type,'response.completed');
 const final=events.at(-1).response;assert.equal(final.output.find(i=>i.type==='function_call').arguments,'{"city":"北京"}');assert.equal(final.output.find(i=>i.type==='message').content[0].text,'你好');assert.equal(final.usage.input_tokens,22);assert.equal(final.usage.output_tokens_details.reasoning_tokens,2);assert.equal(final.store,false);
});
test('Anthropic streaming completes blocks and separates cached input without fake signatures',async()=>{
 const response=await adaptResponse('anthropic',source([choice({reasoning_content:'private'}),choice({content:'你好'}),choice({tool_calls:[{index:0,id:'a',function:{name:'weather',arguments:'{"city":"北京"}'}}]}),choice({},'tool_calls'),{choices:[],usage}],1),{model:'demo',stream:true});const events=[];for await(const e of sseEvents(response.body))events.push(e);
 assert.equal(events[0].type,'message_start');assert.equal(events.at(-1).type,'message_stop');assert.equal(events.filter(e=>e.type==='content_block_start').length,events.filter(e=>e.type==='content_block_stop').length);assert.ok(!JSON.stringify(events).includes('private'));const last=events.find(e=>e.type==='message_delta');assert.equal(last.delta.stop_reason,'tool_use');assert.deepEqual(last.usage,{input_tokens:10,cache_read_input_tokens:7,cache_creation_input_tokens:5,output_tokens:12});assert.equal(observation('anthropic',last).usage.prompt_tokens,22);
});
test('Nonstream outputs preserve length, tool inputs and protocol errors',async()=>{
 const data={choices:[{message:{content:'hello',tool_calls:[{id:'a',function:{name:'weather',arguments:'{"city":"北京"}'}}]},finish_reason:'length'}],usage};
 const a=await(await adaptResponse('anthropic',Response.json(data),{model:'demo'})).json();assert.equal(a.stop_reason,'max_tokens');assert.deepEqual(a.content[1].input,{city:'北京'});
 const r=await(await adaptResponse('responses',Response.json(data),{model:'demo'})).json();assert.equal(r.status,'incomplete');assert.equal(r.incomplete_details.reason,'max_output_tokens');
 const error=await adaptResponse('anthropic',Response.json({error:{message:'bad model'}},{status:404}),{model:'bad'});assert.equal(error.status,404);assert.equal((await error.json()).error.type,'not_found_error');
});
test('Midstream errors never emit successful completion; cancel releases upstream',async()=>{
 const response=await adaptResponse('responses',source([choice({content:'hi'}),{error:{code:'lost',message:'failed'}}]),{model:'demo',stream:true});const events=[];for await(const e of sseEvents(response.body))events.push(e);assert.equal(events.at(-1).type,'error');assert.ok(!events.some(e=>e.type==='response.completed'));
 let cancelled=false;const upstream=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});const adapted=await adaptResponse('anthropic',upstream,{model:'demo',stream:true});const reader=adapted.body.getReader();await reader.read();await reader.cancel();assert.equal(cancelled,true);
});
