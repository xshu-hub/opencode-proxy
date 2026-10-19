// Opt-in, billable live checks. Supplier credentials remain owned by global
// OpenCode; the disposable gateway, DSH file index and reports live in TEMP.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {ProxyRuntime} from '../lib/runtime.mjs';

const dshRoot=process.env.TEST_DSH_ROOT;
assert.ok(dshRoot,'Set TEST_DSH_ROOT to the installed @deepseek-ai/dsh package directory.');
const command=JSON.parse(process.env.TEST_OPENCODE_COMMAND??'["opencode"]');
const dir=await mkdtemp(path.join(os.tmpdir(),'opencode-proxy-advanced-'));
const models=(process.env.OPENCODE_PROXY_LIVE_MODELS??'deepseek-flash,deepseek-v4-pro').split(',');
const key=randomBytes(24).toString('hex');
const runtime=new ProxyRuntime({file:path.join(dir,'settings.json'),settings:{mode:'global',command,discoverModels:true,workerReuse:true,diagnostics:false,host:'127.0.0.1',port:0,timeoutMs:120000,models:Object.fromEntries(models.map(id=>[id,{model:'deepseek/'+id,context:128000,output:8192}])),modelOverrides:{},apiKeys:[{id:'live-advanced',name:'Disposable live regression',key,enabled:true}]}});
const imageHashes=[],gatewayFetch=runtime.fetch.bind(runtime);
runtime.fetch=(url,init,...rest)=>{
 if(typeof init?.body==='string'){
  const visit=value=>{if(!value||typeof value!=='object')return;if(value.type==='image'&&value.source?.type==='base64')imageHashes.push(createHash('sha256').update(Buffer.from(value.source.data,'base64')).digest('hex'));for(const child of Object.values(value))if(typeof child==='object')visit(child);};
  visit(JSON.parse(init.body));
 }
 return gatewayFetch(url,init,...rest);
};
function png(){
 const crc=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const b=Buffer.concat([Buffer.from(type),data]),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(b));return Buffer.concat([size,b,sum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(64);header.writeUInt32BE(64,4);header[8]=8;header[9]=2;
 const pixels=Buffer.alloc(64*(1+64*3));for(let y=0;y<64;y++)for(let x=0;x<64;x++)pixels[y*193+1+x*3]=255;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
try{
 await runtime.startGateway();
 process.env.OPENCODE_PROXY_LIVE_URL=runtime.state().endpoint;
 process.env.OPENCODE_PROXY_LIVE_KEY=key;
 process.env.OPENCODE_PROXY_LIVE_REPORT_DIR=dir;
 const {request,body,check:runCheck,report,save,nonce,requireText}=await import('./live-client.mjs');
 const filter=process.env.OPENCODE_PROXY_LIVE_FILTER?new RegExp(process.env.OPENCODE_PROXY_LIVE_FILTER):null;
 const check=(protocol,model,name,fn)=>filter&&!filter.test(`${protocol}/${model}/${name}`)?Promise.resolve():runCheck(protocol,model,name,fn);
 const data=png(),image='data:image/png;base64,'+data.toString('base64');
 await check('all','both','model-discovery-contracts',async()=>{
  for(const anthropic of [false,true]){
   const r=await fetch(runtime.state().endpoint+'/models',{headers:anthropic?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{authorization:'Bearer '+key}});assert.equal(r.status,200);const list=await r.json();
   for(const model of models){const item=list.data.find(i=>i.id===model);assert.ok(item);assert.equal(anthropic?item.type:item.object,'model');assert.ok(!item.id.includes('/'));}if(anthropic)assert.equal(typeof list.has_more,'boolean');else assert.equal(list.object,'list');
  }
  return{shortAliases:true,openai:true,anthropic:true};
 });
 const tool={name:'echo_token',description:'Return a verified secret. Wait for the result.',parameters:{type:'object',properties:{token:{type:'string'}},required:['token'],additionalProperties:false},strict:true};
 for(const model of models)for(const protocol of ['chat','responses','anthropic'])await check(protocol,model,'thinking-tools-history-off-interrupt',async()=>{
  const token=nonce(),secret=nonce(),prompt=`Call echo_token with token ${token}. Wait for the result, then output the secret it returns.`,b=body(protocol,model,prompt,{stream:true,mode:'on',tools:[tool]});
  const first=await request(protocol,b);assert.equal(first.calls.length,1);assert.equal(first.calls[0].name,tool.name);assert.equal(first.calls[0].args.token,token);
  const call=first.calls[0];
  if(protocol==='responses')b.input=[{role:'user',content:prompt},...first.raw.output,{type:'function_call_output',call_id:call.id,output:secret}];
  else if(protocol==='anthropic')b.messages.push({role:'assistant',content:first.raw.content},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:secret}]});
  else b.messages.push(first.raw.choices[0].message,{role:'tool',tool_call_id:call.id,content:secret});
  const final=await request(protocol,b);requireText(final,secret);assert.equal(final.calls.length,0);
  let reasoningChars=first.reasoning.length+final.reasoning.length;if(!reasoningChars){const reasoning=await request(protocol,body(protocol,model,'Find the greatest common divisor of 1071 and 462, showing the Euclidean algorithm step by step.',{stream:true,mode:'on'}));assert.match(reasoning.text,/21/);reasoningChars=reasoning.reasoning.length;}assert.ok(reasoningChars>0,'No visible thinking on reasoning task');
  const interrupted=await request(protocol,body(protocol,model,'Think carefully about proving infinitely many primes, explaining each step.',{stream:true,mode:'on'}),{cancel:'reasoning'});assert.equal(interrupted.cancelled,true);
  const off=await request(protocol,body(protocol,model,'Reply exactly OK'));requireText(off,'OK');assert.equal(off.reasoning,'');
  return{toolHistory:true,reasoningChars,thinkingOff:true,interrupted:true,recovered:true};
 });
 for(const model of models)for(const kind of ['namespace','custom'])await check('responses',model,'advanced-'+kind+'-roundtrip',async()=>{
  const token=nonce(),secret=nonce(),tools=kind==='namespace'?[{type:'namespace',name:'crm',description:'CRM lookup',tools:[{type:'function',name:tool.name,description:tool.description,parameters:tool.parameters,strict:true}]}]:[{type:'custom',name:'run_code',description:'Return a secret after receiving the exact freeform program.',format:{type:'text'}}];
  const input=kind==='custom'?`print("${token}")\n`:'',prompt=kind==='namespace'?`Call crm.echo_token with token ${token}; wait for its secret and then output that secret.`:`Call run_code with exactly the following program, including its trailing newline: ${JSON.stringify(input)}. Wait for its secret and then output that secret.`;
  const b={model,input:prompt,tools,stream:true,max_output_tokens:4096,reasoning:{effort:'high'},tool_choice:kind==='namespace'?{type:'function',namespace:'crm',name:tool.name}:{type:'custom',name:'run_code'}};
  const first=await request('responses',b),calls=first.raw.output.filter(i=>['function_call','custom_tool_call'].includes(i.type));assert.equal(calls.length,1);const call=calls[0];assert.equal(call.name,kind==='namespace'?tool.name:'run_code');
  if(kind==='namespace'){assert.equal(call.namespace,'crm');assert.equal(JSON.parse(call.arguments).token,token);}else assert.equal(call.input,input);
  const second=await request('responses',{...b,tool_choice:'auto',input:[{role:'user',content:prompt},...first.raw.output,{type:kind==='namespace'?'function_call_output':'custom_tool_call_output',call_id:call.call_id,output:secret}]});requireText(second,secret);return{typedCall:true,exactInput:true,history:true};
 });
 for(const protocol of ['responses','anthropic'])for(const model of models)await check(protocol,model,'image-tool-result',async()=>{
  const prompt='I called capture_image. Identify the dominant color of the actual returned image. Reply with the color only.',callID='image_'+nonce();
  const b=protocol==='responses'?{model,input:[{role:'user',content:prompt},{type:'function_call',call_id:callID,name:'capture_image',arguments:'{}'},{type:'function_call_output',call_id:callID,output:[{type:'input_image',image_url:image}]}],reasoning:{effort:'none'},max_output_tokens:1024}:{model,max_tokens:1024,thinking:{type:'disabled'},messages:[{role:'user',content:prompt},{role:'assistant',content:[{type:'tool_use',id:callID,name:'capture_image',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:callID,content:[{type:'image',source:{type:'base64',media_type:'image/png',data:data.toString('base64')}}]}]}]};
  if(model==='deepseek-flash'){const r=await request(protocol,b);assert.match(r.text,/red|红/i);return{imageUnderstood:true};}
  const r=await fetch(runtime.state().endpoint+(protocol==='responses'?'/responses':'/messages'),{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(b)});assert.equal(r.status,400);const error=await r.json();assert.match(JSON.stringify(error),/image input support/);return{textOnlyCapabilityRejection:true};
 });
 const sdkPath=path.join(dshRoot,'node_modules','openai','index.mjs');
 const {default:OpenAI}=await import(pathToFileURL(sdkPath));const sdk=new OpenAI({baseURL:runtime.state().endpoint,apiKey:key,maxRetries:0});
 for(const model of models)await check('responses',model,'official-sdk-custom-stream',async()=>{
  const input='echo SDK_OK',r=sdk.responses.stream({model,input:`Call run_code with this command: ${input}`,tools:[{type:'custom',name:'run_code',format:{type:'text'}}],tool_choice:{type:'custom',name:'run_code'},max_output_tokens:2048,reasoning:{effort:'none'}});
  let delta='';r.on('response.custom_tool_call_input.delta',e=>{delta+=e.delta;});const result=await r.finalResponse();assert.equal(result.status,'completed');const call=result.output.find(i=>i.type==='custom_tool_call');assert.ok(call.input.includes(input));assert.equal(delta,call.input);return{sdkStreamParsed:true,rawInputMatchesDeltas:true};
 });
 const {DeepSeekAdapter,DeepSeekFileStore,resolveAdapterOptions}=await import(pathToFileURL(path.join(dshRoot,'node_modules','@deepseek-ai','dsh-llm-deepseek','lib','index.js')));
 const dshVersion=JSON.parse(await readFile(path.join(dshRoot,'package.json'),'utf8')).version;
 const settings=resolveAdapterOptions({baseURL:runtime.state().endpoint,maxTokens:4096,thinking:'enabled',models:models.map(id=>({id,inputModalities:id==='deepseek-flash'?['text','image']:['text']})),streamIdleTimeoutMs:120000});
 const id='sha256:'+createHash('sha256').update(data).digest('hex'),attachment={attachmentId:id,mediaType:'image/png',bytes:data.length,width:64,height:64,name:'fixture.png'},degraded=[];
 const adapter=new DeepSeekAdapter({options:()=>settings,resolveFiles:()=>new DeepSeekFileStore(path.join(dir,'dsh-files.json')),resolveAttachments:()=>({readImageRequest:async()=>({variantId:id,attachment,data,mediaType:'image/png',bytes:data.length,width:64,height:64,depth:'uchar',space:'srgb',hasAlpha:false})}),resolveAuth:async()=>({headers:{'x-api-key':key}}),resolveUserId:()=> 'live-advanced-fixture',prepareExtensions:async()=>({fields:{dsh_plugin_packages:{version:1,packages:[]}},accept:async()=>{}}),onReplayDegrade:e=>degraded.push(e.reason)});
 async function turn(model,messages,tools,reasoningEffort='high'){
  const content=[];let finish,reasoningDeltas=0;for await(const e of adapter.stream({provider:'proxy',model,messages,tools,reasoningEffort})){if(e.type==='block-end')content[e.index]=e.block;if(e.type==='reasoning-delta')reasoningDeltas++;if(e.type==='finish')finish=e;}
  assert.ok(finish);return{content,source:{kind:'model',provider:'proxy',model,replayState:finish.replayState},reasoningDeltas};
 }
 for(const model of models)await check('dsh',model,'native-adapter-thinking-tool-replay-images',async()=>{
  const vision=model==='deepseek-flash',token=nonce(),name=vision?'capture_image':'echo_token',user={role:'user',content:[{type:'text',text:`Calculate 37 times 43, then call ${name} with token ${token} and wait for the result. ${vision?'Identify the dominant color of the returned image after it arrives.':''}`}]},tools=[{...tool,name,...(vision?{description:'Capture the image requested by the user. Identify its color only after receiving the image.'}:{})}],first=await turn(model,[user],tools);const call=first.content.find(b=>b.type==='tool-call');assert.ok(call);assert.equal(call.name,name);assert.equal(JSON.parse(call.arguments).token,token);
  const secret=nonce(),history=[user,{role:'assistant',content:first.content,source:first.source},{role:'tool',toolCallId:call.id,content:[{type:'text',text:model==='deepseek-flash'?'Identify the dominant color of the actual image; output only the color.':'Reply only '+secret},...(model==='deepseek-flash'?[{type:'image',attachment}]:[])]}];
  const beforeImages=imageHashes.length,second=await turn(model,history,tools);const text=second.content.filter(b=>b.type==='text').map(b=>b.text).join('');if(vision){assert.deepEqual(imageHashes.slice(beforeImages),[id.slice(7)]);assert.match(text,/red|红/i);}else assert.ok(text.includes(secret));assert.ok(first.reasoningDeltas+second.reasoningDeltas>0);
  const cancel=new AbortController();let cancelledOnDelta=false,cancelError;
  try{for await(const event of adapter.stream({provider:'proxy',model,messages:[{role:'user',content:[{type:'text',text:'Think carefully and prove that there are infinitely many prime numbers, explaining every step.'}]}],reasoningEffort:'high',signal:cancel.signal})){if(['reasoning-delta','text-delta'].includes(event.type)){cancelledOnDelta=true;cancel.abort();}}}catch(error){cancelError=error;}
  assert.equal(cancelledOnDelta,true);assert.equal(cancelError?.code,'ABORTED','DSH must propagate stream cancellation through its actual adapter');
  const off=await turn(model,[...history,{role:'assistant',content:second.content,source:second.source},{role:'user',content:[{type:'text',text:'Reply only OFF_OK'}]}],tools,'off');assert.ok(off.content.some(b=>b.type==='text'&&b.text.includes('OFF_OK')));assert.ok(!off.content.some(b=>b.type==='reasoning'));assert.deepEqual(degraded,[]);
  return{dshVersion,thinkingDeltas:first.reasoningDeltas+second.reasoningDeltas,thinkingBeforeTool:first.reasoningDeltas,thinkingAfterTool:second.reasoningDeltas,toolRoundtrip:true,unsignedReplay:true,thinkingOff:true,interrupted:true,recovered:true,imageToolResult:vision,imageBytesVerified:vision};
 });
 await check('all','both','concurrent-protocol-isolation',async()=>{
  const results=await Promise.all(models.flatMap(model=>['chat','responses','anthropic'].map(async protocol=>{const token=nonce(),r=await request(protocol,body(protocol,model,'Reply only CONCURRENT_'+token,{stream:true}));requireText(r,token);return{model,protocol};})));return{count:results.length};
 });
 report.finished=new Date().toISOString();save();console.log('REPORT '+path.join(dir,'report.json'));
 assert.ok(report.results.length,'No live checks matched the filter.');
 assert.equal(report.results.filter(r=>!r.pass).length,0,'Live checks failed; see report.');
}finally{await runtime.close();}
