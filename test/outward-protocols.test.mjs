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
test('Anthropic history preserves text/tool batches/results and adaptive effort',()=>{
 const body=toChatRequest('anthropic',{model:'demo',max_tokens:100,system:[{type:'text',text:'system',cache_control:{type:'ephemeral'}}],messages:[{role:'user',content:'question'},{role:'assistant',content:[{type:'text',text:'calling'},{type:'tool_use',id:'a',name:'weather',input:{city:'北京'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'a',content:[{type:'text',text:'sunny'}]}]}],thinking:{type:'adaptive'},output_config:{effort:'high'}});
 validateRequest(body,{demo:{output:1000}});assert.equal(body.messages[2].tool_calls[0].function.arguments,'{"city":"北京"}');assert.equal(body.messages[3].content,'sunny');assert.equal(body.reasoning_effort,'high');
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
