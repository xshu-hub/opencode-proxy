// Opt-in real-model comparison. Reports/configuration stay outside Git.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
const source=path.resolve(process.env.OPENCODE_PROXY_BENCH_SOURCE??'.');
const {ProxyRuntime}=await import(pathToFileURL(path.join(source,'lib/runtime.mjs')));
const samples=Number(process.env.OPENCODE_PROXY_BENCH_SAMPLES??3);
assert.ok(Number.isInteger(samples)&&samples>=1&&samples<=20);
const dshRoot=process.env.TEST_DSH_ROOT;assert.ok(dshRoot,'Set TEST_DSH_ROOT.');
const {DeepSeekAdapter,DeepSeekFileStore,resolveAdapterOptions}=await import(pathToFileURL(path.join(dshRoot,'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js')));
const models=['deepseek-flash','deepseek-v4-pro'],protocols=['chat','responses','anthropic','dsh'];
const command=JSON.parse(process.env.TEST_OPENCODE_COMMAND??'["opencode"]');
const dir=await mkdtemp(path.join(os.tmpdir(),'opencode-proxy-latency-'));
const report={phase:process.env.OPENCODE_PROXY_BENCH_PHASE??'current',source,started:new Date().toISOString(),samples,prompt:'Write exactly eight lines, STREAM_OK_1 through STREAM_OK_8. No other text.',results:[]};
const save=()=>writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
function clock(){const start=performance.now();return()=>Math.round(performance.now()-start);}
function body(protocol,model){const common={model,stream:true};return protocol==='responses'?{...common,input:report.prompt,max_output_tokens:1024,reasoning:{effort:'none'}}:protocol==='anthropic'?{...common,messages:[{role:'user',content:report.prompt}],max_tokens:1024,thinking:{type:'disabled'}}:{...common,messages:[{role:'user',content:report.prompt}],max_completion_tokens:1024,reasoning_effort:'none',stream_options:{include_usage:true}};}
async function raw(runtime,key,protocol,model){
 const elapsed=clock(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000),metrics={text:'',deltas:0,firstTextMs:null,firstReasoningMs:null,firstToolMs:null,lastDeltaMs:null,maxGapMs:0};
 try{
  const r=await fetch(runtime.state().endpoint+'/'+({chat:'chat/completions',responses:'responses',anthropic:'messages'}[protocol]),{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body(protocol,model)),signal:controller.signal});metrics.headersMs=elapsed();assert.equal(r.status,200,r.status===200?'':await r.text());metrics.reused=r.headers.get('x-opencode-worker-reused');metrics.serverTiming=r.headers.get('server-timing');
  let buffer='',terminal=false;const decoder=new TextDecoder();
  for await(const bytes of r.body){metrics.firstByteMs??=elapsed();buffer+=decoder.decode(bytes,{stream:true});let match;while((match=/\r?\n\r?\n/.exec(buffer))){const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);const value=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!value)continue;if(value==='[DONE]'){terminal=true;metrics.terminalMs=elapsed();continue;}const e=JSON.parse(value);assert.ok(!e.error,JSON.stringify(e.error));const d=e.choices?.[0]?.delta,text=d?.content??(e.type==='response.output_text.delta'?e.delta:e.delta?.type==='text_delta'?e.delta.text:''),reason=d?.reasoning_content??(e.type==='response.reasoning_summary_text.delta'?e.delta:e.delta?.type==='thinking_delta'?e.delta.thinking:'');if(text){const at=elapsed();metrics.firstTextMs??=at;metrics.maxGapMs=Math.max(metrics.maxGapMs,metrics.lastDeltaMs===null?0:at-metrics.lastDeltaMs);metrics.lastDeltaMs=at;metrics.deltas++;metrics.text+=text;}if(reason)metrics.firstReasoningMs??=elapsed();if(d?.tool_calls||e.type==='response.function_call_arguments.delta'||e.delta?.type==='input_json_delta')metrics.firstToolMs??=elapsed();if(['response.completed','response.incomplete','message_stop'].includes(e.type)){terminal=true;metrics.terminalMs=elapsed();}if(e.usage)metrics.usage=e.usage;if(e.response?.usage)metrics.usage=e.response.usage;}}
  assert.ok(terminal,'Missing terminal event');assert.ok(metrics.firstTextMs!==null);assert.match(metrics.text,/STREAM_OK_8/);metrics.totalMs=elapsed();metrics.tailMs=metrics.terminalMs-metrics.lastDeltaMs;delete metrics.text;return metrics;
 }finally{clearTimeout(timer);}
}
function adapter(runtime,key,model){const options=resolveAdapterOptions({baseURL:runtime.state().endpoint,maxTokens:1024,thinking:'disabled',models:[{id:model}],streamIdleTimeoutMs:120000});return new DeepSeekAdapter({options:()=>options,resolveFiles:()=>new DeepSeekFileStore(path.join(dir,'dsh-files.json')),resolveAuth:async()=>({headers:{'x-api-key':key}}),resolveUserId:()=> 'latency-fixture',prepareExtensions:async()=>({fields:{},accept:async()=>{}})});}
async function dsh(runtime,key,model){
 const elapsed=clock(),metrics={firstTextMs:null,firstReasoningMs:null,firstToolMs:null,lastDeltaMs:null,deltas:0,maxGapMs:0};let text='',finished=false;
 for await(const e of adapter(runtime,key,model).stream({provider:'proxy',model,messages:[{role:'user',content:[{type:'text',text:report.prompt}]}],reasoningEffort:'off',signal:AbortSignal.timeout(120000)})){
  if(e.type==='text-delta'){const at=elapsed();metrics.firstTextMs??=at;metrics.maxGapMs=Math.max(metrics.maxGapMs,metrics.lastDeltaMs===null?0:at-metrics.lastDeltaMs);metrics.lastDeltaMs=at;metrics.deltas++;text+=e.text;}
  if(e.type==='reasoning-delta')metrics.firstReasoningMs??=elapsed();if(e.type==='tool-call-delta')metrics.firstToolMs??=elapsed();if(e.type==='finish'){finished=true;metrics.terminalMs=elapsed();}
 }
 assert.ok(finished);assert.match(text,/STREAM_OK_8/);metrics.totalMs=elapsed();metrics.tailMs=metrics.terminalMs-metrics.lastDeltaMs;return metrics;
}
async function fixture(){const key=randomBytes(24).toString('hex'),runtime=new ProxyRuntime({file:path.join(dir,randomBytes(6).toString('hex')+'.json'),settings:{mode:'global',command,discoverModels:true,workerReuse:true,warmupModels:models,diagnostics:false,host:'127.0.0.1',port:0,timeoutMs:120000,models:Object.fromEntries(models.map(id=>[id,{model:'deepseek/'+id,context:128000,output:8192}])),modelOverrides:{},apiKeys:[{id:'latency',name:'latency',key,enabled:true}]}});await runtime.initialize();await runtime.startGateway();return{runtime,key};}
async function measure(f,protocol,model,mode,index,extra={}){let row;try{row={pass:true,...await(protocol==='dsh'?dsh(f.runtime,f.key,model):raw(f.runtime,f.key,protocol,model))};}catch(error){row={pass:false,error:error.message};}report.results.push({protocol,model,mode,index,...extra,...row});await save();console.log(JSON.stringify(report.results.at(-1)));}
for(const model of models)for(const protocol of protocols){
 for(let i=0;i<samples;i++){
  const f=await fixture();try{await measure(f,protocol,model,'immediate-first',i);await f.runtime.current.bridge.drain?.();await measure(f,protocol,model,'reuse',i);}finally{await f.runtime.close();}
 }
 const start=clock(),f=await fixture();try{await f.runtime.warmup;await f.runtime.current.bridge.drain?.();await measure(f,protocol,model,'ready-first',0,{readinessMs:start(),prewarmSupported:!!f.runtime.warmup});}finally{await f.runtime.close();}
}
const percentile=(values,p)=>{const a=values.toSorted((x,y)=>x-y);return a[Math.min(a.length-1,Math.ceil(p*a.length)-1)];};report.summary=[];
for(const model of models)for(const protocol of protocols)for(const mode of ['immediate-first','reuse','ready-first']){const rows=report.results.filter(r=>r.model===model&&r.protocol===protocol&&r.mode===mode&&r.pass);if(rows.length)report.summary.push({model,protocol,mode,n:rows.length,firstTextP50:percentile(rows.map(r=>r.firstTextMs),.5),firstTextP95:percentile(rows.map(r=>r.firstTextMs),.95),tailP50:percentile(rows.map(r=>r.tailMs),.5),totalP50:percentile(rows.map(r=>r.totalMs),.5)});}
report.finished=new Date().toISOString();await save();console.log('REPORT '+path.join(dir,'report.json'));assert.ok(report.results.every(r=>r.pass),'Benchmark failures are retained in the report.');
