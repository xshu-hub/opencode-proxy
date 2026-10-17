import {randomUUID} from 'node:crypto';
import {ApiError,validateThinking} from './protocol.mjs';

export const protocolFor=(endpoint,headers={})=>{
  const route=endpoint.replace(/\/$/,'');
  if(route==='/v1/messages/count_tokens'||(/^\/v1\/models(?:\/[^/]+)?$/.test(route)&&(headers['anthropic-version']!==undefined||headers['x-api-key']!==undefined)))return 'anthropic';
  return {'/v1/chat/completions':'chat','/v1/responses':'responses','/v1/messages':'anthropic'}[route];
};
export const clientAuthorization=headers=>headers.authorization??(typeof headers['x-api-key']==='string'?'Bearer '+headers['x-api-key']:'');
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const fail=(message,param)=>{throw new ApiError(message,400,param,'unsupported_parameter');};
function fields(value,allowed,param){if(!object(value))fail(`${param} must be an object.`,param);for(const k of Object.keys(value))if(!allowed.includes(k))fail(`Unsupported parameter: ${param}.${k}.`,`${param}.${k}`);}
function text(value,param,types=['text']){
  if(typeof value==='string')return value;
  if(!Array.isArray(value))fail('Only text content is supported.',param);
  return value.map((p,i)=>{fields(p,['type','text','annotations','cache_control',...(p?.type==='output_text'?['logprobs']:[])],`${param}[${i}]`);if(!types.includes(p.type)||typeof p.text!=='string')fail('Only text content is supported.',param);return p.text;}).join('');
}
function base(body){const out={model:body.model};for(const k of ['stream','temperature','top_p'])if(body[k]!==undefined)out[k]=body[k];return out;}
function metadata(body){if(body.metadata!==undefined&&!object(body.metadata))fail('metadata must be an object.','metadata');}
function toolChoice(value,anthropic=false){
  if(value===undefined)return undefined;
  if(anthropic){fields(value,['type','disable_parallel_tool_use'],'tool_choice');if(value.disable_parallel_tool_use===true)fail('OpenCode cannot guarantee serial tool calls.','tool_choice.disable_parallel_tool_use');if(['auto','none'].includes(value.type))return value.type;}
  else if(['auto','none'].includes(value))return value;
  fail('Only automatic tools or disabled tools are supported by OpenCode Proxy.','tool_choice');
}
function appendCall(messages,call){let last=messages.at(-1);if(last?.role!=='assistant'||last.content){last={role:'assistant',content:null,tool_calls:[]};messages.push(last);}last.tool_calls??=[];last.tool_calls.push(call);}
export function toChatRequest(protocol,body){
  // DeepSeek Harness sends plugin identities as diagnostics, never model input.
  if(object(body)&&Object.hasOwn(body,'dsh_plugin_packages')){
    body={...body};delete body.dsh_plugin_packages;
  }
  if(protocol==='chat'){
    if(!object(body))return body;
    const out={...body};metadata(body);
    if(body.user!=null&&typeof body.user!=='string')fail('user must be text.','user');
    if(body.store!=null&&typeof body.store!=='boolean')fail('store must be boolean.','store');
    if(body.store===true)fail('Server-side response storage is unavailable; use store=false.','store');
    if(body.stop!=null&&(!Array.isArray(body.stop)||body.stop.length))fail('Custom stop sequences cannot be mapped to OpenCode.','stop');
    if(body.response_format!==undefined){fields(body.response_format,['type'],'response_format');if(body.response_format.type!=='text')fail('Structured output constraints are unavailable.','response_format');}
    if(body.parallel_tool_calls!==undefined&&body.parallel_tool_calls!==true)fail('OpenCode cannot guarantee serial tool calls.','parallel_tool_calls');
    for(const k of ['metadata','user','store','response_format','parallel_tool_calls','stop'])delete out[k];
    return out;
  }
  if(protocol==='responses'){
    fields(body,['model','input','instructions','stream','temperature','top_p','max_output_tokens','tools','tool_choice','parallel_tool_calls','reasoning','text','store','metadata','include','previous_response_id','background','truncation'],'request');
    metadata(body);for(const k of ['store','background'])if(body[k]!==undefined&&typeof body[k]!=='boolean')fail(`${k} must be boolean.`,k);
    if(body.store===true)fail('Server-side response storage is unavailable; send the complete input history and store=false.','store');
    if(body.previous_response_id!=null)fail('previous_response_id is unavailable; send the complete input history.','previous_response_id');
    if(body.background===true)fail('Background responses are unavailable.','background');
    if(body.truncation!==undefined&&body.truncation!=='disabled')fail('Automatic history truncation is unavailable.','truncation');
    if(body.include!==undefined&&(!Array.isArray(body.include)||body.include.some(k=>k!=='reasoning.encrypted_content')))fail('Additional response includes are unavailable.','include');
    if(body.parallel_tool_calls!==undefined&&body.parallel_tool_calls!==true)fail('OpenCode cannot guarantee serial tool calls.','parallel_tool_calls');
    if(body.text!==undefined){fields(body.text,['format','verbosity'],'text');if(body.text.verbosity!==undefined)fail('Text verbosity cannot be mapped to OpenCode.','text.verbosity');if(body.text.format!==undefined){fields(body.text.format,['type'],'text.format');if(body.text.format.type!=='text')fail('Structured output constraints are unavailable.','text.format');}}
    const out=base(body);out.messages=[];
    let pendingReasoning='';
    const flushReasoning=()=>{if(!pendingReasoning)return;let last=out.messages.at(-1);if(last?.role!=='assistant'){last={role:'assistant',content:null};out.messages.push(last);}last.reasoning_content=(last.reasoning_content??'')+pendingReasoning;pendingReasoning='';};
    if(body.instructions!==undefined)out.messages.push({role:'system',content:text(body.instructions,'instructions')});
    if(typeof body.input==='string')out.messages.push({role:'user',content:body.input});
    else if(Array.isArray(body.input))for(const [i,item] of body.input.entries()){
      const p=`input[${i}]`;
      if(!object(item))fail('Input items must be objects.',p);
      if(item.type==='function_call'){fields(item,['type','id','call_id','name','arguments','status'],p);appendCall(out.messages,{id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}});flushReasoning();}
      else if(item.type==='function_call_output'){fields(item,['type','id','call_id','output','status'],p);flushReasoning();out.messages.push({role:'tool',tool_call_id:item.call_id,content:text(item.output,p+'.output',['input_text','text'])});}
      else if(item.type==='reasoning'){fields(item,['type','id','summary','status','encrypted_content'],p);if(item.encrypted_content!=null)fail('Encrypted reasoning history cannot be restored by OpenCode; send textual summaries.',p+'.encrypted_content');if(item.summary!==undefined)pendingReasoning+=text(item.summary,p+'.summary',['summary_text']);}
      else{fields(item,['type','id','role','content','status'],p);if(item.type!==undefined&&item.type!=='message')fail('Unsupported Responses input item.',p);if(!['system','developer','user','assistant'].includes(item.role))fail('Unsupported message role.',p);if(item.role!=='assistant')flushReasoning();out.messages.push({role:item.role,content:text(item.content,p+'.content',['input_text','output_text','text'])});if(item.role==='assistant')flushReasoning();}
    }else fail('input must be text or an array of history items.','input');
    flushReasoning();
    if(body.max_output_tokens!==undefined)out.max_completion_tokens=body.max_output_tokens;
    if(body.reasoning!==undefined){fields(body.reasoning,['effort','summary'],'reasoning');if(body.reasoning.effort!==undefined)out.reasoning_effort=body.reasoning.effort;if(body.reasoning.summary!==undefined&&!['auto','concise','detailed'].includes(body.reasoning.summary))fail('Invalid reasoning summary.','reasoning.summary');}
    if(body.tools!==undefined){if(!Array.isArray(body.tools))fail('tools must be an array.','tools');out.tools=body.tools.map((t,i)=>{fields(t,['type','name','description','parameters','strict'],`tools[${i}]`);return{type:t.type,function:{name:t.name,...(t.description!==undefined?{description:t.description}:{}),...(t.parameters!==undefined?{parameters:t.parameters}:{}),...(t.strict!==undefined?{strict:t.strict}:{})}};});}
    out.tool_choice=toolChoice(body.tool_choice);
    if(out.tool_choice===undefined)delete out.tool_choice;
    if(out.stream)out.stream_options={include_usage:true};
    return out;
  }
  fields(body,['model','messages','system','max_tokens','stream','temperature','top_p','top_k','stop_sequences','tools','tool_choice','metadata','thinking','output_config'],'request');
  metadata(body);
  if(body.stop_sequences!==undefined&&(!Array.isArray(body.stop_sequences)||body.stop_sequences.length))fail('Custom stop sequences cannot be mapped to OpenCode.','stop_sequences');
  if(!Number.isInteger(body.max_tokens)||body.max_tokens<=0)fail('Anthropic max_tokens must be a positive integer.','max_tokens');
  const out=base(body);out.max_tokens=body.max_tokens;out.messages=[];
  if(body.top_k!==undefined)out.top_k=body.top_k;
  if(body.system!==undefined)out.messages.push({role:'system',content:text(body.system,'system')});
  if(!Array.isArray(body.messages))fail('messages must be an array.','messages');
  for(const [i,m] of body.messages.entries()){
    fields(m,['role','content'],`messages[${i}]`);if(!['user','assistant'].includes(m.role))fail('Unsupported Anthropic message role.',`messages[${i}].role`);
    if(typeof m.content==='string'){out.messages.push({role:m.role,content:m.content});continue;}
    if(!Array.isArray(m.content))fail('Message content must be text or blocks.',`messages[${i}].content`);
    let normal='',calls=[],results=[];
    for(const [j,b] of m.content.entries()){
      const p=`messages[${i}].content[${j}]`;
      if(!object(b))fail('Content blocks must be objects.',p);
      if(b.type==='text')normal+=text([b],p);
      else if(b.type==='tool_use'&&m.role==='assistant'){fields(b,['type','id','name','input','cache_control'],p);if(!object(b.input))fail('Tool input must be an object.',p+'.input');calls.push({id:b.id,type:'function',function:{name:b.name,arguments:JSON.stringify(b.input)}});}
      else if(b.type==='tool_result'&&m.role==='user'){fields(b,['type','tool_use_id','content','is_error','cache_control'],p);results.push({role:'tool',tool_call_id:b.tool_use_id,content:text(b.content??'',p+'.content')});}
      else fail('Only text, client tool_use and tool_result blocks are supported; signed thinking and multimodal blocks are unavailable.',p);
    }
    out.messages.push(...results);
    if(normal||calls.length||!results.length)out.messages.push({role:m.role,content:normal||(m.role==='assistant'?null:''),...(calls.length?{tool_calls:calls}:{})});
  }
  if(body.tools!==undefined){if(!Array.isArray(body.tools))fail('tools must be an array.','tools');out.tools=body.tools.map((t,i)=>{const p=`tools[${i}]`;fields(t,['name','description','input_schema','cache_control','type','eager_input_streaming','strict'],p);if(t.type!==undefined&&t.type!=='custom')fail('Only custom function tools are supported.',p+'.type');if(t.eager_input_streaming!=null&&typeof t.eager_input_streaming!=='boolean')fail('eager_input_streaming must be boolean.',p+'.eager_input_streaming');return{type:'function',function:{name:t.name,parameters:t.input_schema,...(t.description!==undefined?{description:t.description}:{}),...(t.strict!==undefined?{strict:t.strict}:{})}};});}
  out.tool_choice=toolChoice(body.tool_choice,true);if(out.tool_choice===undefined)delete out.tool_choice;
  if(body.thinking!==undefined){
    fields(body.thinking,['type','display','budget_tokens'],'thinking');
    if(body.thinking.display!==undefined&&body.thinking.display!=='omitted')fail('Signed thinking output is unavailable; use display=omitted.','thinking.display');
    if(body.thinking.type==='adaptive'){if(body.thinking.budget_tokens!==undefined)fail('Adaptive thinking does not take a fixed budget.','thinking.budget_tokens');}
    else out.thinking={type:body.thinking.type,...(body.thinking.budget_tokens!==undefined?{budget_tokens:body.thinking.budget_tokens}:{})};
  }
  if(body.output_config!==undefined){fields(body.output_config,['effort'],'output_config');if(body.output_config.effort!==undefined){if(body.thinking?.type==='disabled')fail('Effort conflicts with disabled thinking.','output_config.effort');out.reasoning_effort=body.output_config.effort;}}
  validateThinking(out.thinking,out.max_tokens,out.reasoning_effort);
  if(out.stream)out.stream_options={include_usage:true};
  return out;
}

export function protocolError(protocol,error,status=400,requestId){
  if(protocol!=='anthropic')return error;
  return{type:'error',error:{type:status===401?'authentication_error':status===403?'permission_error':status===404?'not_found_error':status===429?'rate_limit_error':status>=500?'api_error':'invalid_request_error',message:error.error?.message??'OpenCode request failed.'},...(requestId?{request_id:requestId}:{})};
}
const responseUsage=u=>u?{input_tokens:u.prompt_tokens??0,input_tokens_details:{cached_tokens:u.prompt_tokens_details?.cached_tokens??0},output_tokens:u.completion_tokens??0,output_tokens_details:{reasoning_tokens:u.completion_tokens_details?.reasoning_tokens??0},total_tokens:u.total_tokens??(u.prompt_tokens??0)+(u.completion_tokens??0)}:null;
const anthropicUsage=u=>({input_tokens:u?Math.max(0,(u.prompt_tokens??0)-(u.prompt_tokens_details?.cached_tokens??0)-(u.prompt_tokens_details?.cache_write_tokens??0)):0,cache_read_input_tokens:u?.prompt_tokens_details?.cached_tokens??0,cache_creation_input_tokens:u?.prompt_tokens_details?.cache_write_tokens??0,output_tokens:u?.completion_tokens??0});

class Output{
  constructor(protocol,request){this.protocol=protocol;this.request=request;this.id=(protocol==='responses'?'resp_':'msg_')+randomUUID().replaceAll('-','');this.created=Math.floor(Date.now()/1000);this.items=[];this.calls=new Map();this.sequence=0;this.events=[];}
  emit(type,body={}){this.events.push({type,...body,...(this.protocol==='responses'?{sequence_number:this.sequence++}:{})});}
  response(status='in_progress'){
    const r=this.request;
    return{id:this.id,object:'response',created_at:this.created,status,error:null,incomplete_details:status==='incomplete'?{reason:this.finish==='length'?'max_output_tokens':'content_filter'}:null,model:r.model,output:structuredClone(this.items),instructions:r.instructions??null,tools:r.tools??[],tool_choice:r.tool_choice??'auto',parallel_tool_calls:true,temperature:r.temperature??null,top_p:r.top_p??null,max_output_tokens:r.max_output_tokens??null,reasoning:r.reasoning??{effort:null,summary:null},text:r.text??{format:{type:'text'}},store:false,metadata:r.metadata??{},usage:responseUsage(this.usage)};
  }
  message(final=false){return{id:this.id,type:'message',role:'assistant',model:this.request.model,content:final?structuredClone(this.items):[],stop_reason:final?({tool_calls:'tool_use',length:'max_tokens',content_filter:'refusal'}[this.finish]??'end_turn'):null,stop_sequence:null,usage:anthropicUsage(this.usage)};}
  start(){if(this.protocol==='responses'){this.emit('response.created',{response:this.response()});this.emit('response.in_progress',{response:this.response()});}else this.emit('message_start',{message:this.message()});return this.drain();}
  drain(){return this.events.splice(0);}
  add(item){const index=this.items.length;this.items.push(item);if(this.protocol==='responses')this.emit('response.output_item.added',{output_index:index,item:structuredClone(item)});else this.emit('content_block_start',{index,content_block:structuredClone(item)});return index;}
  chunk(chunk){
    if(chunk.usage)this.usage=chunk.usage;
    const c=chunk.choices?.[0],d=c?.delta??c?.message??{};
    if(c?.finish_reason)this.finish=c.finish_reason;
    if(this.protocol==='responses'){
      if(d.reasoning_content){if(this.reasonIndex===undefined){this.reasonIndex=this.add({id:'rs_'+randomUUID(),type:'reasoning',summary:[]});this.items[this.reasonIndex].summary.push({type:'summary_text',text:''});this.emit('response.reasoning_summary_part.added',{item_id:this.items[this.reasonIndex].id,output_index:this.reasonIndex,summary_index:0,part:{type:'summary_text',text:''}});}const item=this.items[this.reasonIndex];item.summary[0].text+=d.reasoning_content;this.emit('response.reasoning_summary_text.delta',{item_id:item.id,output_index:this.reasonIndex,summary_index:0,delta:d.reasoning_content});}
      if(d.content){if(this.textIndex===undefined){this.textIndex=this.add({id:'msg_'+randomUUID(),type:'message',role:'assistant',status:'in_progress',content:[]});const part={type:'output_text',text:'',annotations:[],logprobs:[]};this.items[this.textIndex].content.push(part);this.emit('response.content_part.added',{item_id:this.items[this.textIndex].id,output_index:this.textIndex,content_index:0,part:structuredClone(part)});}const item=this.items[this.textIndex];item.content[0].text+=d.content;this.emit('response.output_text.delta',{item_id:item.id,output_index:this.textIndex,content_index:0,delta:d.content,logprobs:[]});}
      for(const [pos,t] of (d.tool_calls??[]).entries()){const key=t.index??pos;let index=this.calls.get(key);if(index===undefined){if(!t.id||!t.function?.name)throw new ApiError('Tool stream is missing an ID or name.',502);index=this.add({id:'fc_'+randomUUID(),type:'function_call',call_id:t.id,name:t.function.name,arguments:'',status:'in_progress'});this.calls.set(key,index);}const item=this.items[index];item.arguments+=t.function?.arguments??'';if(t.function?.arguments)this.emit('response.function_call_arguments.delta',{item_id:item.id,output_index:index,delta:t.function.arguments});}
    }else{
      // OpenCode reasoning is provider-specific and has no Anthropic signature.
      // Never forge a signed thinking block. Answer text and usage remain native.
      if(d.content){if(this.textIndex===undefined){this.stopText();this.textIndex=this.add({type:'text',text:''});}this.items[this.textIndex].text+=d.content;this.emit('content_block_delta',{index:this.textIndex,delta:{type:'text_delta',text:d.content}});}
      for(const [pos,t] of (d.tool_calls??[]).entries()){this.stopText();const key=t.index??pos;let index=this.calls.get(key);if(index===undefined){if(!t.id||!t.function?.name)throw new ApiError('Tool stream is missing an ID or name.',502);index=this.add({type:'tool_use',id:t.id,name:t.function.name,input:{}});this.calls.set(key,index);this.items[index]._arguments='';}this.items[index]._arguments+=t.function?.arguments??'';if(t.function?.arguments)this.emit('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:t.function.arguments}});}
    }
    return this.drain();
  }
  stopText(){if(this.textIndex!==undefined){this.emit('content_block_stop',{index:this.textIndex});this.textIndex=undefined;}}
  end(){
    if(!this.finish)throw new ApiError('OpenCode stream ended without a completion.',502,null,'incomplete_stream');
    if(this.protocol==='responses'){
      for(const [index,item] of this.items.entries()){
        const args={item_id:item.id,output_index:index};
        if(item.type==='message'){this.emit('response.output_text.done',{...args,content_index:0,text:item.content[0].text,logprobs:[]});this.emit('response.content_part.done',{...args,content_index:0,part:structuredClone(item.content[0])});item.status='completed';}
        if(item.type==='reasoning'){this.emit('response.reasoning_summary_text.done',{...args,summary_index:0,text:item.summary[0].text});this.emit('response.reasoning_summary_part.done',{...args,summary_index:0,part:structuredClone(item.summary[0])});}
        if(item.type==='function_call'){this.emit('response.function_call_arguments.done',{...args,name:item.name,arguments:item.arguments});item.status='completed';}
        this.emit('response.output_item.done',{output_index:index,item:structuredClone(item)});
      }
      const status=['length','content_filter'].includes(this.finish)?'incomplete':'completed';this.emit('response.'+status,{response:this.response(status)});
    }else{
      this.stopText();for(const index of this.calls.values()){const item=this.items[index];try{item.input=JSON.parse(item._arguments);}catch{throw new ApiError('Invalid tool arguments from OpenCode.',502);}delete item._arguments;this.emit('content_block_stop',{index});}
      this.emit('message_delta',{delta:{stop_reason:this.message(true).stop_reason,stop_sequence:null},usage:anthropicUsage(this.usage)});this.emit('message_stop');
    }
    return this.drain();
  }
}

export async function adaptResponse(protocol,response,request){
  if(protocol==='chat'||!protocol)return response;
  const headers=new Headers(response.headers);headers.delete('content-length');headers.set('request-id',headers.get('x-opencode-request-id')??randomUUID());
  if(response.status>=400){const error=await response.json();return Response.json(protocolError(protocol,error,response.status,headers.get('request-id')),{status:response.status,headers});}
  const out=new Output(protocol,request);
  if(!request.stream){const data=await response.json();out.chunk(data);out.end();return Response.json(protocol==='responses'?out.response(['length','content_filter'].includes(out.finish)?'incomplete':'completed'):out.message(true),{headers});}
  const reader=response.body.getReader(),decoder=new TextDecoder(),encoder=new TextEncoder();let buffer='',eof=false,cancelled=false,queue=out.start();
  const frame=event=>encoder.encode('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
  function failure(error){if(protocol==='responses')return{type:'error',sequence_number:out.sequence++,code:error.code??'opencode_stream_error',message:error.message??'OpenCode stream failed.',param:error.param??null};return protocolError(protocol,{error:{message:error.message}},502,headers.get('request-id'));}
  const stream=new ReadableStream({async pull(controller){
    try{
      while(!queue.length&&!eof){let match=/\r?\n\r?\n/.exec(buffer);
        if(!match){const next=await reader.read();if(cancelled)return;if(next.done){buffer+=decoder.decode();if(buffer.trim())throw new ApiError('Incomplete event frame.',502);queue=out.end();eof=true;break;}buffer+=decoder.decode(next.value,{stream:true});if(buffer.length>16*1024*1024)throw new ApiError('Event frame is too large.',502);continue;}
        const raw=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);
        const data=raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
        if(!data){if(raw.startsWith(':'))queue=[{type:'ping'}];continue;}
        if(data==='[DONE]'){queue=out.end();eof=true;await reader.cancel();break;}
        const value=JSON.parse(data);if(value.error){queue=[failure(value.error)];eof=true;await reader.cancel();break;}queue=out.chunk(value);
      }
      if(cancelled)return;
      if(queue.length){const item=queue.shift();controller.enqueue(item.type==='ping'&&protocol==='responses'?encoder.encode(': keepalive\n\n'):frame(item));}else controller.close();
    }catch(error){if(cancelled)return;eof=true;queue=[];controller.enqueue(frame(failure(error)));controller.close();await reader.cancel(error).catch(()=>{});}
  },async cancel(reason){cancelled=true;queue=[];await reader.cancel(reason);}});
  return new Response(stream,{headers});
}

// A common semantic observation for TTFT and Magpie metrics; raw journals retain
// the actual client protocol, including all named SSE events.
export function observation(protocol,data){
  if(protocol==='chat'||!protocol)return data;
  if(data.type==='error'||data.error)return{error:data.error??data};
  if(protocol==='responses'){
    const usage=data.response?.usage??data.usage;
    return{...(usage?{usage:{prompt_tokens:usage.input_tokens,completion_tokens:usage.output_tokens,total_tokens:usage.total_tokens,prompt_tokens_details:usage.input_tokens_details,completion_tokens_details:usage.output_tokens_details}}:{}),choices:[{delta:data.type==='response.output_text.delta'?{content:data.delta}:data.type==='response.reasoning_summary_text.delta'?{reasoning_content:data.delta}:data.type==='response.function_call_arguments.delta'?{tool_calls:[{}]}:{},finish_reason:['response.completed','response.incomplete'].includes(data.type)?data.response?.incomplete_details?.reason??'stop':null}]};
  }
  const d=data.delta,u=data.type==='message_delta'?data.usage:undefined;
  return{...(u?{usage:{prompt_tokens:(u.input_tokens??0)+(u.cache_read_input_tokens??0)+(u.cache_creation_input_tokens??0),completion_tokens:u.output_tokens,prompt_tokens_details:{cached_tokens:u.cache_read_input_tokens??0,cache_write_tokens:u.cache_creation_input_tokens??0}}}:{}),choices:[{delta:d?.type==='text_delta'?{content:d.text}:d?.type==='input_json_delta'?{tool_calls:[{}]}:{},finish_reason:data.type==='message_delta'?d?.stop_reason:null}]};
}
