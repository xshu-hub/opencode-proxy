import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ToolTextRecovery} from '../lib/dsml-tools.mjs';
import {OpenCodeBridge} from '../lib/bridge.mjs';
import {nativeToolName,sseEvents,validateRequest} from '../lib/protocol.mjs';
import {toChatRequest,adaptResponse} from '../lib/outward-protocols.mjs';
import {nativeGeneration} from '../lib/generation.mjs';

const code='const g1 = await tools.grep({ pattern: "SessionRetry|Retry\\.policy|retryable\\(", path: "packages/opencode/src", include: "*.ts" })\nconsole.log(g1.matches.map(m=>m.path+":"+m.lineNumber+": "+m.line).join("\\n"))';
const description='Find retry policy usage sites';
const parameters={type:'object',properties:{code:{type:'string'},description:{type:'string'}},required:['code','description'],additionalProperties:false};
const name='run_code',native=nativeToolName(name);
const definitions=[{name:native,parameters}];
const batch=(tool=native,values={code,description},token='｜｜DSML｜｜',root='calls')=>`<${token} ${root}> ${Object.entries(values).length?`<${token} invoke name="${tool}"> ${Object.entries(values).map(([name,value])=>`<${token} parameter name="${name}" string="${typeof value==='string'}">${typeof value==='string'?value:JSON.stringify(value)}</${token} parameter>`).join(' ')} </${token} invoke>`:''} </${token} ${root}>`;
const sample=batch();

test('DSH DSML preserves code literally across every streaming split and canonical dialects',()=>{
  for(const token of ['｜DSML｜','｜｜DSML｜｜','|DSML|','||DSML||'])for(const root of ['calls','tool_calls','function_calls']){
    const text=batch(native,{code,description},token,root);
    for(let split=0;split<=text.length;split++){
      const recovery=new ToolTextRecovery(definitions);
      assert.equal(recovery.push(text.slice(0,split)),'');assert.equal(recovery.push(text.slice(split)),'');
      const calls=recovery.finish().calls;assert.equal(calls.length,1);assert.equal(calls[0].name,native);assert.deepEqual({...calls[0].input},{code,description});
    }
  }
});

test('DSML values preserve types, raw whitespace and prototype keys without executing or decoding text',()=>{
  const values=JSON.parse('{"text":"  &lt;tag&gt;\\n  ","object":{"count":3},"array":[1,false],"count":2,"flag":true,"empty":null,"__proto__":{"polluted":true}}');
  const recovery=new ToolTextRecovery([{name:native,parameters:{type:'object'}}]);
  for(const char of batch(native,values,'｜DSML｜','tool_calls').replaceAll('｜DSML｜ ','｜DSML｜'))recovery.push(char);
  assert.deepEqual(JSON.parse(JSON.stringify(recovery.finish().calls[0].input)),values);assert.equal({}.polluted,undefined);
});

test('DSML rejects truncated, unknown, duplicate, invalid, mixed and oversized call batches atomically',()=>{
  const bad=[sample.slice(0,-20),sample.replace(native,'bridge_unknown'),sample.replace('string="true"','string="false"'),sample.replace('</｜｜DSML｜｜ invoke>',`<｜｜DSML｜｜ parameter name="code" string="true">duplicate</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>`),batch(native,{code:7,description}),batch(native,{code}),batch(native,{code,description,extra:true}),sample+' ordinary tail',sample.replace(' calls>',' unsupported>'),sample.replace(/<｜｜DSML｜｜ invoke.*<\/｜｜DSML｜｜ invoke>/s,'')];
  for(const text of bad){const recovery=new ToolTextRecovery(definitions);recovery.push(text);assert.throws(()=>recovery.finish(),e=>e.status===502);}
  assert.throws(()=>new ToolTextRecovery(definitions,{limit:20}).push(sample),e=>e.status===502);
  const invoke=sample.slice(sample.indexOf('<｜｜DSML｜｜ invoke'),sample.indexOf('</｜｜DSML｜｜ invoke>')+'</｜｜DSML｜｜ invoke>'.length);
  const tooMany=new ToolTextRecovery(definitions);tooMany.push('<｜｜DSML｜｜ calls>'+invoke.repeat(129)+'</｜｜DSML｜｜ calls>');assert.throws(()=>tooMany.finish(),e=>e.status===502);
});

test('normal text, fenced examples, embedded markup and unavailable tools remain text',()=>{
  for(const text of ['ordinary text','<html>hello</html>','```xml\n'+sample+'\n```','Example: '+sample,'<','   ']){
    const recovery=new ToolTextRecovery(definitions);let output='';for(const char of text)output+=recovery.push(char);output+=recovery.finish().text??'';assert.equal(output,text);
  }
  const none=new ToolTextRecovery([]);assert.equal(none.push(sample),sample);assert.equal(none.finish().text,'');
  assert.equal(new ToolTextRecovery(definitions).push('Hello'),'Hello');
});

test('parallel DSML calls are all validated before any call can be returned',()=>{
  const invoke=sample.slice(sample.indexOf('<｜｜DSML｜｜ invoke'),sample.indexOf('</｜｜DSML｜｜ invoke>')+'</｜｜DSML｜｜ invoke>'.length);
  const recovery=new ToolTextRecovery(definitions);recovery.push('<｜｜DSML｜｜ calls>'+invoke+invoke+'</｜｜DSML｜｜ calls>');assert.equal(recovery.finish().calls.length,2);
  const invalid=new ToolTextRecovery(definitions);invalid.push('<｜｜DSML｜｜ calls>'+invoke+invoke.replace(native,'unknown')+'</｜｜DSML｜｜ calls>');assert.throws(()=>invalid.finish(),e=>e.status===502);
});

function simulatedBridge({text=sample,reason='stop',reasoning=false,nativeCall=false}={}){
  const bridge=new OpenCodeBridge({mode:'global',discoverModels:false});
  bridge.prepare=async body=>{
    validateRequest(body,{'oc-default':{output:4096}});
    return {sessionID:'s',signal:new AbortController().signal,cleanup:async()=>{},abort:async()=>{},events:(async function*(){
      yield {type:'message.updated',properties:{info:{id:'m',sessionID:'s',role:'assistant'}}};
      if(reasoning)yield {type:'message.part.updated',properties:{part:{id:'r',sessionID:'s',messageID:'m',type:'reasoning',text:'thinking'}}};
      yield {type:'message.part.updated',properties:{part:{id:'p',sessionID:'s',messageID:'m',type:'text',text:''}}};
      for(const delta of text)yield {type:'message.part.delta',properties:{sessionID:'s',messageID:'m',partID:'p',field:'text',delta}};
      // Final snapshots must not duplicate streamed deltas.
      yield {type:'message.part.updated',properties:{part:{id:'p',sessionID:'s',messageID:'m',type:'text',text}}};
      if(nativeCall)yield {type:'message.part.updated',properties:{part:{id:'t',sessionID:'s',messageID:'m',type:'tool',tool:native,callID:'native-call',state:{status:'running',input:{code,description}}}}};
      yield {type:'message.part.updated',properties:{part:{id:'f',sessionID:'s',messageID:'m',type:'step-finish',reason,tokens:{input:10,output:5}}}};
    })()};
  };
  return bridge;
}
const tool={type:'function',function:{name,parameters}};
const send=async(bridge,body)=>bridge.fetch('http://bridge/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'oc-default',messages:[{role:'user',content:'Find retry policy usage sites'}],tools:[tool],...body})});

for(const protocol of ['chat','responses','anthropic'])for(const stream of [false,true])test(`${protocol} DSML becomes standard calls and the client can return tool results (stream=${stream})`,async()=>{
  const bridge=simulatedBridge(),client={model:'oc-default',stream,...(protocol==='responses'?{input:'Find retry policy usage sites',store:false,tools:[{type:'function',name,parameters}]}:{messages:[{role:'user',content:'Find retry policy usage sites'}],tools:protocol==='chat'?[tool]:[{name,input_schema:parameters}],...(protocol==='anthropic'?{max_tokens:100}:{})})};
  const chat=toChatRequest(protocol,client),reply=await adaptResponse(protocol,await send(bridge,chat),client);assert.equal(reply.status,200);
  const events=stream?await Array.fromAsync(sseEvents(reply.body)):[],result=stream?undefined:await reply.json();
  let call,continuation;
  if(protocol==='chat'){
    const message=stream?{role:'assistant',content:null,tool_calls:events.flatMap(e=>e.choices?.[0]?.delta.tool_calls??[]).map(({index,...c})=>c)}:result.choices[0].message;
    assert.equal(stream?events.find(e=>e.choices?.[0]?.finish_reason)?.choices[0].finish_reason:result.choices[0].finish_reason,'tool_calls');call=message.tool_calls[0];assert.equal(call.function.name,name);assert.equal(JSON.parse(call.function.arguments).code,code);assert.equal(message.content??'', '');
    continuation={...client,messages:[...client.messages,message,{role:'tool',tool_call_id:call.id,content:'retry policy found'}]};
  }else if(protocol==='responses'){
    const final=stream?events.at(-1).response:result;assert.equal(final.status,'completed');call=final.output.find(i=>i.type==='function_call');assert.equal(call.name,name);assert.equal(JSON.parse(call.arguments).code,code);
    continuation={...client,input:[{role:'user',content:client.input},...final.output,{type:'function_call_output',call_id:call.call_id,output:'retry policy found'}]};
  }else{
    const stop=stream?events.find(e=>e.type==='message_delta').delta.stop_reason:result.stop_reason;assert.equal(stop,'tool_use');
    call=stream?events.find(e=>e.type==='content_block_start'&&e.content_block.type==='tool_use')?.content_block:result.content.find(b=>b.type==='tool_use');assert.ok(call);assert.equal(call.name,name);
    const input=stream?JSON.parse(events.filter(e=>e.type==='content_block_delta'&&e.delta.type==='input_json_delta').map(e=>e.delta.partial_json).join('')):call.input;assert.equal(input.code,code);assert.equal(input.description,description);
    continuation={...client,messages:[...client.messages,{role:'assistant',content:[{...call,input}]},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'retry policy found'}]}]};
  }
  assert.ok(!JSON.stringify(result??events).includes('DSML'));
  const next=toChatRequest(protocol,continuation);validateRequest(next,{'oc-default':{output:4096}});assert.equal(next.messages.at(-1).role,'tool');assert.equal(next.messages.at(-1).content,'retry policy found');
});

test('DSML forced/serial tools and structured capture obey their existing constraints',async()=>{
  for(const disabled of [false,true]){
    const body={model:'oc-default',messages:[{role:'user',content:'call'}],tools:[tool],tool_choice:'required',parallel_tool_calls:false,...(disabled?{thinking:{type:'disabled'}}:{})},plan=nativeGeneration(body);
    const text=batch(plan.capture?'bridge_structured_output':'StructuredOutput',{calls:[{name,arguments:{code,description}}]});
    const response=await send(simulatedBridge({text}),body),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.choices[0].finish_reason,'tool_calls');assert.equal(result.choices[0].message.tool_calls[0].function.name,name);
  }
});

for(const stream of [false,true])test(`invalid DSML never emits success or leaks markup (stream=${stream})`,async()=>{
  for(const options of [{text:sample.slice(0,-20)},{text:sample,reason:'length'},{text:sample,reason:'content-filter'},{text:sample.replace(native,'unknown')},{text:sample,nativeCall:true}]){
    const response=await send(simulatedBridge({...options,reasoning:stream}),{stream});
    const result=stream?await Array.fromAsync(sseEvents(response.body)):await response.json();assert.equal(response.status,stream?200:502);
    assert.ok(stream?result.some(e=>e.error):result.error);assert.ok(!JSON.stringify(result).includes('DSML｜'));if(stream)assert.ok(!result.some(e=>e.choices?.[0]?.finish_reason));
  }
});
