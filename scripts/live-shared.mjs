// Opt-in real-provider regression through the user's unmodified local OpenCode 1.
// Gateway keys are disposable; provider credentials never enter this script.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {readFile,mkdtemp,writeFile,readdir,realpath} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {ProxyRuntime} from '../lib/runtime.mjs';
import {createProxyServer} from '../lib/http-server.mjs';
import {defaultConfigFile,validateSettings} from '../lib/settings.mjs';
import {sharedContract} from '../lib/shared-contract.mjs';
import {sseEvents} from '../lib/protocol.mjs';
import {processMemory} from '../test/process-memory.mjs';

const dir=await mkdtemp(path.join(os.tmpdir(),'opencode-proxy-shared-live-'));
const original=JSON.parse((await readFile(defaultConfigFile(),'utf8')).replace(/^\uFEFF/,''));
const {channels,...local}=original;
const key=randomBytes(24).toString('hex');
const selected=(process.env.OPENCODE_PROXY_LIVE_MODELS??'deepseek-flash').split(',').filter(Boolean);
assert.deepEqual(selected,['deepseek-flash'],'This regression is restricted to the configured deepseek-flash model.');
const common={...local,workingDirectory:local.workingDirectory??process.cwd(),mode:'global',host:'127.0.0.1',port:0,diagnostics:false,maxConcurrent:0,timeoutMs:180000,startupTimeoutMs:60000,firstOutputTimeoutMs:120000,idleTimeoutMs:180000,workerReuse:true,workerSharing:true,maxIdleWorkers:2,apiKeys:[{id:'live-shared',name:'Disposable real-model regression',key,enabled:true}]};
const discoverySettings=validateSettings(common,path.dirname(defaultConfigFile())).settings;
const discovery=new ProxyRuntime({file:path.join(dir,'discovery.json'),settings:discoverySettings});
let definitions;
try{
 const catalog=await discovery.models();
 for(const id of selected)assert.ok(catalog.some(m=>m.id===id&&m.enabled&&m.toolcall),'Requested model must be enabled and advertise tools: '+id);
 definitions=Object.fromEntries(selected.map(id=>[id,structuredClone(discovery.current.acceptedModels[id])]));
}finally{await discovery.close();}

async function fixture(sharing=true,extra={}){
 const settings=validateSettings({...common,workerSharing:sharing,discoverModels:false,models:definitions,modelOverrides:{},warmupModels:selected,...extra},path.dirname(defaultConfigFile())).settings;
 const runtime=new ProxyRuntime({file:path.join(dir,randomBytes(6).toString('hex')+'.json'),settings});
 const server=createProxyServer({bridge:{fetch:(...args)=>runtime.fetch(...args),close:()=>runtime.close()},authenticate:req=>runtime.authenticate(req)});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {runtime,endpoint:'http://127.0.0.1:'+server.address().port+'/v1',close:()=>server.shutdown()};
}
const main=await fixture();
process.env.OPENCODE_PROXY_LIVE_URL=main.endpoint;process.env.OPENCODE_PROXY_LIVE_KEY=key;
process.env.OPENCODE_PROXY_LIVE_MODELS=selected.join(',');process.env.OPENCODE_PROXY_LIVE_REPORT_DIR=dir;
const {body,request,check,summary,requireText,nonce,report,save,s}=await import('./live-client.mjs');
report.mode='real-global-opencode-1-shared';report.sourceConfig=defaultConfigFile();
const filter=process.env.OPENCODE_PROXY_LIVE_FILTER?new RegExp(process.env.OPENCODE_PROXY_LIVE_FILTER):undefined;
const run=async(p,m,name,fn)=>{if(!filter||filter.test(p+'/'+m+'/'+name))return check(p,m,name,fn);};
const protocols=['chat','responses','anthropic'];
const historyBody=(p,m,history,extra={})=>body(p,m,'',{stream:true,...(p==='responses'?{input:history}:p==='anthropic'?{messages:history.filter(item=>item.role!=='system'),...(history.some(item=>item.role==='system')?{system:history.filter(item=>item.role==='system').map(item=>item.content).join('\n')}:{})}:{messages:history}),...extra});
const appendAssistant=(p,history,r)=>{if(p==='chat')history.push(r.raw.choices[0].message);else if(p==='responses')history.push(...r.raw.output);else history.push({role:'assistant',content:r.raw.content});};
const toolChoice=(p,name)=>p==='chat'?{type:'function',function:{name}}:p==='responses'?{type:'function',name}:{type:'tool',name,disable_parallel_tool_use:true};
const appendResult=(p,history,call,output)=>{
 if(p==='chat')history.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(output)});
 else if(p==='responses')history.push({type:'function_call_output',call_id:call.id,output:JSON.stringify(output)});
 else history.push({role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:JSON.stringify(output)}]});
};
const owned=(f,m,request={})=>{const bridge=f.runtime.current.bridge,entry=[...bridge.shared.entries.values()].find(entry=>entry.baseKey===bridge.workerKey(bridge.acceptedModels[m])&&entry.process?.contract.hash===sharedContract(request).hash);assert.ok(entry?.process,'Expected an owned shared process');return entry.process;};
const restoreEndpoint=()=>{s.endpoint=main.endpoint;};
try{
 const warmStart=performance.now();await main.runtime.initialize();await main.runtime.warmup;await main.runtime.current.bridge.drain();
 report.prewarmMs=Math.round(performance.now()-warmStart);save();
 const available=[];
 for(const m of selected){
  const row=await check('chat',m,'real-model-connectivity',async()=>{const token='CONNECTED_'+nonce(),r=await request('chat',body('chat',m,'Output only '+token,{stream:true}));requireText(r,token);assert.match(r.version,/^1\./);return summary(r);});
  if(row.pass)available.push(m);
 }
 for(const m of available)await run('chat',m,'real-directory-relative-files-and-session-release',async()=>{
  const workingDirectory=await mkdtemp(path.join(dir,'真实目录 with spaces ')),marker='RELATIVE_'+nonce();await writeFile(path.join(workingDirectory,'relative.txt'),marker);
  const expected=await realpath(workingDirectory),f=await fixture(true,{workingDirectory}),bridge=f.runtime.current.bridge,prepare=bridge.prepare,hookPaths=[];
  bridge.prepare=async function(...args){const result=await prepare.apply(this,args);const group=owned(f,m,args[0]);const ready=JSON.parse(await readFile(path.join(group.home,'requests',result.sessionID,'hooks-ready.json'),'utf8'));assert.equal(await realpath(ready.directory),expected);assert.equal(ready.sessionID,result.sessionID);hookPaths.push(ready.directory);return result;};
  s.endpoint=f.endpoint;
  try{
   const token='DIRECTORY_'+nonce(),response=await request('chat',body('chat',m,'Output only '+token,{stream:true}));requireText(response,token);await bridge.drain();
   const group=owned(f,m),ready=JSON.parse(await readFile(path.join(group.home,'instance-ready.json'),'utf8'));
   assert.equal(ready.directory,expected);assert.equal(ready.cwd,expected);
   const nativePath=await fetch(group.base+'/path',{headers:group.headers}).then(r=>{assert.ok(r.ok);return r.json();});assert.equal(await realpath(nativePath.directory),expected);
   const file=await fetch(group.base+'/file/content?path=relative.txt',{headers:group.headers}).then(r=>{assert.ok(r.ok);return r.json();});assert.equal(file.content,marker);
   assert.deepEqual(await readdir(path.join(group.home,'requests')),[]);assert.equal(bridge.shared.all.size,1);assert.equal([...bridge.shared.entries.values()][0].refs,0);assert.deepEqual(await readdir(workingDirectory),['relative.txt']);
   return {nativeDirectory:expected,pluginDirectory:ready.directory,processDirectory:ready.cwd,relativeRead:true,hookPaths,sessionStateRemoved:true,...summary(response)};
  }finally{bridge.prepare=prepare;await f.close();restoreEndpoint();}
 });
 for(const m of available)for(const p of protocols){
  await run(p,m,'three-conversation-turns',async()=>{
   const a='FIRST_'+nonce(),b='SECOND_'+nonce(),history=[{role:'system',content:'Follow the user exactly. Preserve the labelled memory values across all turns.'}];const turns=[];
   for(const [i,prompt] of ['Remember FIRST='+a+'. Reply only OK.','Also remember SECOND='+b+'. Reply only OK.','Return the original FIRST and SECOND values exactly. Output FIRST=<value> SECOND=<value> only.'].entries()){
    history.push({role:'user',content:prompt});const r=await request(p,historyBody(p,m,history,{stream:i!==0}));
    if(i<2)requireText(r,'OK');else{requireText(r,a);requireText(r,b);}
    appendAssistant(p,history,r);turns.push(summary(r));
   }
   return {turns,historyItems:history.length};
  });
  await run(p,m,'two-tool-rounds-and-final-answer',async()=>{
   const ticket=nonce(),first='PROOF1_'+nonce(),second='PROOF2_'+nonce();
   const tools=[{name:'lookup_first',description:'First stage. Retrieve the first proof for the ticket.',strict:true,parameters:{type:'object',properties:{ticket:{type:'string'}},required:['ticket'],additionalProperties:false}},{name:'lookup_second',description:'Second stage. Pass the exact proof returned by lookup_first. Retrieve the second proof.',strict:true,parameters:{type:'object',properties:{proof:{type:'string'}},required:['proof'],additionalProperties:false}}];
   const history=[{role:'user',content:'Use lookup_first for ticket '+ticket+', then lookup_second with the proof returned by lookup_first. After receiving the second result, output BOTH returned proof values verbatim and no other text.'}],turns=[];
   const send=(round)=>request(p,historyBody(p,m,history,{tools:round===1?tools.slice(1):tools,tool_choice:round<2?toolChoice(p,tools[round].name):(p==='anthropic'?{type:'none'}:'none'),...(p!=='anthropic'?{parallel_tool_calls:false}:{})}));
   const r1=await send(0);assert.equal(r1.calls.length,1);assert.equal(r1.calls[0].name,'lookup_first');assert.equal(r1.calls[0].args.ticket,ticket);appendAssistant(p,history,r1);appendResult(p,history,r1.calls[0],{proof:first});turns.push(summary(r1));
   const r2=await send(1);assert.equal(r2.calls.length,1);assert.equal(r2.calls[0].name,'lookup_second');assert.equal(r2.calls[0].args.proof,first);appendAssistant(p,history,r2);appendResult(p,history,r2.calls[0],{proof:second});turns.push(summary(r2));
   const r3=await send(2);requireText(r3,first);requireText(r3,second);assert.equal(r3.calls.length,0);turns.push(summary(r3));
   return {clientExecutedToolRounds:2,originalToolRemovedInSecondRound:true,turns};
  });
  await run(p,m,'incremental-unicode-stream-and-terminal-events',async()=>{
   const token=nonce(),r=await request(p,body(p,m,'Write exactly 20 lines. Line n must be "LIVE_STREAM_n_'+token+' 中文🙂" for n=1 through 20. No other text.',{stream:true}));
   requireText(r,'LIVE_STREAM_20_'+token);assert.ok(r.textDeltas>1,'Expected multiple real text deltas');assert.ok(r.firstTextMs<r.terminalMs,'First text must arrive before completion');
   assert.ok(!r.text.includes('\ufffd'),'UTF-8 corruption');return summary(r);
  });
 }
 for(const m of available){
  await run('responses',m,'stored-three-turn-continuation',async()=>{
   const token='STORED_'+nonce(),turns=[];
   const first=await request('responses',body('responses',m,'The test label is '+token+'. Keep this label in our conversation. Reply only OK.',{store:true,stream:true}));requireText(first,'OK');turns.push(summary(first));
   const second=await request('responses',{previous_response_id:first.raw.id,input:'Keep the test label unchanged. Reply only OK.',store:true,stream:true,max_output_tokens:512,reasoning:{effort:'none'}});requireText(second,'OK');turns.push(summary(second));
   const expanded=main.runtime.responses.expand({previous_response_id:second.raw.id,input:'Return the test label.'},'live-shared');
   assert.ok(JSON.stringify(expanded.input).includes(token),'Stored chain must retain the first user message');assert.equal(expanded.input.length,5);
   const third=await request('responses',{previous_response_id:second.raw.id,input:'What test label did I give you in my first message? Output that exact label only.',store:true,stream:true,max_output_tokens:512,reasoning:{effort:'none'}});requireText(third,token);turns.push(summary(third));
   const headers={authorization:'Bearer '+key};assert.equal((await fetch(main.endpoint+'/responses/'+first.raw.id,{headers})).status,200);
   assert.equal((await fetch(main.endpoint+'/responses/'+first.raw.id,{method:'DELETE',headers})).status,200);
   assert.equal((await fetch(main.endpoint+'/responses/'+first.raw.id,{headers})).status,404);
   return {turns,expandedHistoryItems:expanded.input.length,retrievedAndDeleted:true};
  });
  await run('chat',m,'native-event-connection-reopens-before-inference',async()=>{
   const originalFetch=globalThis.fetch;let dropped=false,eventConnections=0,prompts=0;
   globalThis.fetch=async(url,init)=>{
    const pathname=new URL(url).pathname;
    if(/^\/session\/[^/]+\/prompt_async$/.test(pathname))prompts++;
    const response=await originalFetch(url,init);
    if(pathname==='/event'){eventConnections++;if(!dropped){dropped=true;await response.body.cancel();}}
    return response;
   };
   try{const token='REOPEN_'+nonce(),r=await request('chat',body('chat',m,'Reply only '+token,{stream:true}));requireText(r,token);assert.ok(dropped&&eventConnections>=2);assert.equal(prompts,1,'Reopening event subscription must not repeat inference');return{realConnectionClosed:true,eventConnections,nativePromptCalls:prompts,...summary(r)};}
   finally{globalThis.fetch=originalFetch;}
  });
  await run('chat',m,'disconnect-client-after-text-and-recover',async()=>{
   const pid=owned(main,m).worker.child.pid;
   const cancelled=await request('chat',body('chat',m,'List the integers from 1 to 2000, one integer per line. Do not stop early.',{stream:true}),{cancel:true});assert.ok(cancelled.cancelled&&cancelled.firstTextMs!==null);
   await main.runtime.current.bridge.drain();const token='RECOVER_'+nonce(),recovered=await request('chat',body('chat',m,'Reply only '+token,{stream:true}));requireText(recovered,token);
   assert.equal(owned(main,m).worker.child.pid,pid,'Client disconnect must not kill the shared process');return {cancelled,recovered:summary(recovered),sameProcess:true};
  });
  await run('chat',m,'native-event-disconnect-after-first-text-and-recover',async()=>{
   const originalFetch=globalThis.fetch,pid=owned(main,m).worker.child.pid,audits=[],nativeText=new Map();let connection,dropped=false,prompts=0,interruption,recovering=false;
   globalThis.fetch=async(url,init)=>{
    const pathname=new URL(url).pathname;
    if(/^\/session\/[^/]+\/prompt_async$/.test(pathname))prompts++;
    if(pathname==='/event'){
     connection=new AbortController();
     const response=await originalFetch(url,{...init,signal:AbortSignal.any([init?.signal,connection.signal].filter(Boolean))});
     if(recovering){
      const copy=response.clone(),assistants=new Set();
      audits.push((async()=>{for await(const event of sseEvents(copy.body)){
       const p=event.properties??{};
       if(event.type==='message.updated'&&p.info?.role==='assistant')assistants.add(p.info.id);
       if(event.type==='message.part.updated'&&p.part?.type==='text'&&assistants.has(p.part.messageID))nativeText.set(p.part.id,p.part.text??'');
       if(event.type==='message.part.delta'&&p.field==='text'&&assistants.has(p.messageID))nativeText.set(p.partID,(nativeText.get(p.partID)??'')+p.delta);
      }})().catch(()=>{}));
     }
     return response;
    }
    return originalFetch(url,init);
   };
   try{
    try{await request('chat',body('chat',m,'List integers 1 through 2000, one integer per line. Do not stop early.',{stream:true}),{onOutput:({text})=>{if(text&&!dropped){assert.ok(connection);dropped=true;connection.abort();}}});}catch(error){interruption=error.message;}
    assert.ok(dropped&&interruption,'Broken native transport after output must fail explicitly');assert.equal(prompts,1,'Never replay inference after emitted output');
    await main.runtime.current.bridge.drain();recovering=true;const token='EVENT_RECOVER_'+nonce(),recovered=await request('chat',body('chat',m,'Reply only '+token,{stream:true}));await Promise.all(audits);const nativeAnswer=[...nativeText.values()].join('');assert.equal(recovered.text,nativeAnswer,'Gateway text must equal the actual native assistant stream');requireText(recovered,token);assert.equal(prompts,2);assert.equal(owned(main,m).worker.child.pid,pid);
    return {interruption,inferenceCalls:prompts,noReplay:true,sameProcess:true,nativeTextMatches:true,recovered:summary(recovered)};
   }finally{globalThis.fetch=originalFetch;}
  });
  await run('chat',m,'parallel-cancel-preserves-peer',async()=>{
   const bridge=main.runtime.current.bridge,pid=owned(main,m).worker.child.pid,prepare=bridge.prepare;let release,started,peerRun,nativePeerActiveAtCancel=false;
   const held=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});let seen=false;
   const token='PEER_'+nonce();
   bridge.prepare=async function(...args){const run=await prepare.apply(this,args);if(JSON.stringify(args[0]).includes(token))peerRun=run;return run;};
   const peer=request('chat',body('chat',m,'Write exactly 200 lines, each containing '+token+'. No other text.',{stream:true,max_completion_tokens:4096}),{onOutput:async()=>{if(!seen){seen=true;started();await held;}}});
   // Attach a rejection handler while waiting for the real peer's first text.
   peer.catch(started);
   try{
    await ready;assert.ok(seen,'Peer must emit real text before cancellation starts');
    const cancelled=await request('chat',body('chat',m,'List integers 1 through 2000, one integer per line.',{stream:true}),{cancel:true,onOutput:()=>{nativePeerActiveAtCancel=!!peerRun&&!peerRun.lifecycle.completed&&!peerRun.signal.aborted;assert.ok(nativePeerActiveAtCancel,'Peer native inference must still be active at cancellation');}});assert.ok(cancelled.cancelled);assert.ok(main.runtime.inferenceActive>=1,'Peer must remain active');release();
    const completed=await peer;requireText(completed,token);assert.equal(completed.finish,'stop');await bridge.drain();assert.equal(owned(main,m).worker.child.pid,pid);
    return {cancelled,peer:summary(completed),nativePeerActiveAtCancel,sameProcess:true};
   }finally{bridge.prepare=prepare;release();await peer.catch(()=>{});}
  });
  await run('chat',m,'session-cleanup-failure-drains-with-live-peer',async()=>{
   const bridge=main.runtime.current.bridge,originalFetch=globalThis.fetch,prepare=bridge.prepare,old=owned(main,m),pid=old.worker.child.pid;
   const marker='CLEANUP_FAILURE_'+nonce(),peerMarker='CLEANUP_PEER_'+nonce(),ready=Promise.withResolvers(),held=Promise.withResolvers();let peerRun,failed=false,peerStarted=false,peerActiveAtFailure=false;
   bridge.prepare=async function(...args){const run=await prepare.apply(this,args);if(JSON.stringify(args[0].messages).includes(peerMarker))peerRun=run;return run;};
   globalThis.fetch=async(url,init)=>{
    if(init?.method==='DELETE'&&/^\/session\/[^/]+$/.test(new URL(url).pathname)){
     const sessionID=new URL(url).pathname.split('/').at(-1),bound=await readFile(path.join(old.home,'requests',sessionID,'request.json'),'utf8').then(JSON.parse,()=>undefined);
     if(bound&&JSON.stringify(bound.body.messages).includes(marker)){failed=true;peerActiveAtFailure=!!peerRun&&!peerRun.lifecycle.completed&&!peerRun.signal.aborted;throw new Error('Owned test session deletion interrupted');}
    }
    return originalFetch(url,init);
   };
   const peer=request('chat',body('chat',m,'Write exactly 400 lines, each containing '+peerMarker+'. No other text.',{stream:true,max_completion_tokens:8192}),{onOutput:async()=>{if(!peerStarted){peerStarted=true;ready.resolve();await held.promise;}}});peer.catch(error=>ready.reject(error));
   try{
    await ready.promise;const finished=await request('chat',body('chat',m,'Reply only '+marker,{stream:true}));requireText(finished,marker);await bridge.drain();
    assert.ok(failed&&peerActiveAtFailure,'Cleanup failure must occur while the other native inference is active');assert.equal(old.worker.child.exitCode,null);assert.ok(![...bridge.shared.entries.values()].some(entry=>entry.process===old));
    const token='AFTER_CLEANUP_'+nonce(),next=await request('chat',body('chat',m,'Reply only '+token,{stream:true}));requireText(next,token);assert.notEqual(owned(main,m).worker.child.pid,pid);
    held.resolve();const completed=await peer;requireText(completed,peerMarker);assert.equal(completed.finish,'stop');await bridge.drain();assert.ok(old.worker.exited);
    return {peerActiveAtFailure,oldGroupRetired:true,replacementProcess:true,peer:summary(completed),recovered:summary(next)};
   }finally{globalThis.fetch=originalFetch;bridge.prepare=prepare;held.resolve();await peer.catch(()=>{});}
  });
  await run('all',m,'concurrent-same-tool-name-with-private-schemas',async()=>{
   const bridge=main.runtime.current.bridge,prepare=bridge.prepare,toolPIDs=new Set(),answerPIDs=new Set();let peakActive=0;const timer=setInterval(()=>{peakActive=Math.max(peakActive,main.runtime.inferenceActive);},10);
   bridge.prepare=async function(...args){const result=await prepare.apply(this,args);if(args[0].tools?.some(t=>t.function.name==='lookup_shared_name'))(args[0].tool_choice==='none'?answerPIDs:toolPIDs).add(owned(main,m,args[0]).worker.child.pid);return result;};
   try{
    const rows=await Promise.all(protocols.map(async(p,index)=>{
     const field='slot'+index,value=nonce(),proof='PRIVATE_RESULT_'+nonce(),tool={name:'lookup_shared_name',description:'Look up this request value.',strict:true,parameters:{type:'object',properties:{[field]:{type:'string',const:value}},required:[field],additionalProperties:false}},history=[{role:'user',content:'Call lookup_shared_name with '+field+' equal to '+value+'. After the tool result, output its proof verbatim.'}];
     const first=await request(p,historyBody(p,m,history,{tools:[tool],tool_choice:toolChoice(p,tool.name)}));assert.equal(first.calls.length,1);assert.equal(first.calls[0].name,tool.name);assert.deepEqual(first.calls[0].args,{[field]:value});appendAssistant(p,history,first);appendResult(p,history,first.calls[0],{proof});
     const final=await request(p,historyBody(p,m,history,{tools:[tool],tool_choice:p==='anthropic'?{type:'none'}:'none'}));requireText(final,proof);assert.equal(final.calls.length,0);return {protocol:p,proof,field,first:summary(first),final:summary(final)};
    }));
    for(const row of rows)for(const other of rows)if(row!==other)assert.ok(!row.final.text.includes(other.proof));await bridge.drain();assert.equal(toolPIDs.size,3,'Different client tool contracts must own different native processes');assert.equal(answerPIDs.size,1,'Disabled client tools share the empty effective contract');assert.ok(peakActive>=2,'Real inference requests must overlap');return {peakActive,toolContractProcesses:toolPIDs.size,answerProcesses:answerPIDs.size,requests:rows};
   }finally{bridge.prepare=prepare;clearInterval(timer);}
  });
  await run('responses',m,'owned-process-crash-and-stored-history-recovery',async()=>{
   const token='CRASH_MEMORY_'+nonce(),first=await request('responses',body('responses',m,'The test label is '+token+'. Keep this label in our conversation. Reply only OK.',{store:true,stream:true}));requireText(first,'OK');
   const process=owned(main,m),pid=process.worker.child.pid;let killed=false,partialChars=0,interrupted;
   try{await request('responses',{previous_response_id:first.raw.id,input:'List integers 1 through 2000, one integer per line. Do not stop early.',stream:true,store:false,max_output_tokens:4096,reasoning:{effort:'none'}},{onOutput:async({text})=>{partialChars+=text.length;if(text&&!killed){killed=true;process.worker.child.kill();await process.worker.done;}}});}
   catch(error){interrupted=error.message;}
   assert.ok(killed&&partialChars>0,'Crash must occur after actual model text');assert.ok(interrupted,'Interrupted inference must not report success');await main.runtime.current.bridge.drain();
   const recovered=await request('responses',{previous_response_id:first.raw.id,input:'What test label did I give you in my first message? Output that exact label only.',stream:true,store:true,max_output_tokens:512,reasoning:{effort:'none'}});requireText(recovered,token);assert.notEqual(owned(main,m).worker.child.pid,pid);
   return {killedOwnedProcess:true,partialChars,interruption:interrupted,storedHistoryRestored:true,recovered:summary(recovered)};
  });
 }
 await run('all','configured-models','concurrent-real-protocol-isolation',async()=>{
  const rows=await Promise.all(Array.from({length:4},async(_,i)=>{const model=available[i%available.length],protocol=protocols[i%3],token='ISOLATED_'+nonce(),r=await request(protocol,body(protocol,model,'Output only '+token,{stream:true}));requireText(r,token);return{model,protocol,token,...summary(r)};}));
  const tokens=rows.map(r=>r.token);for(const row of rows)for(const token of tokens)if(token!==row.token)assert.ok(!row.text.includes(token));return{requests:rows};
 });
 for(const m of available)await run('chat',m,'cold-prewarmed-and-reused-first-text-latency',async()=>{
  const samples=[];
  for(const sharing of [false,true]){
   const f=await fixture(sharing);s.endpoint=f.endpoint;
   try{
    for(const mode of ['cold','reuse']){
     const token='LATENCY_'+nonce(),r=await request('chat',body('chat',m,'Reply only '+token,{stream:true}));requireText(r,token);samples.push({sharing,mode,...summary(r)});await f.runtime.current.bridge.drain();
    }
   }finally{await f.close();restoreEndpoint();}
  }
  const f=await fixture(true);s.endpoint=f.endpoint;
  try{
   const started=performance.now();await f.runtime.initialize();await f.runtime.warmup;await f.runtime.current.bridge.drain();const prewarmMs=Math.round(performance.now()-started);
   for(let i=0;i<3;i++){const token='WARM_'+nonce(),r=await request('chat',body('chat',m,'Reply only '+token,{stream:true}));requireText(r,token);assert.equal(r.reused,'true');samples.push({sharing:true,mode:i?'ready-reuse':'prewarmed-first',prewarmMs,...summary(r)});await f.runtime.current.bridge.drain();}
  }finally{await f.close();restoreEndpoint();}
  return {samples,note:'Real-provider latency varies; native preparation and model wait are reported separately in serverTiming.'};
 });
 if(process.env.OPENCODE_PROXY_LIVE_MEMORY_CONCURRENCY)for(const m of available)await run('chat',m,'real-sustained-memory-comparison',async()=>{
  const count=Number(process.env.OPENCODE_PROXY_LIVE_MEMORY_CONCURRENCY);assert.ok(Number.isInteger(count)&&count>=2&&count<=8,'Real-model comparison supports 2 to 8 concurrent requests');
  const rows=[];
  for(const sharing of [false,true]){
   const f=await fixture(sharing,{maxIdleWorkers:count}),bridge=f.runtime.current.bridge,prepare=bridge.prepare,pids=new Set(),runs=[],seen=new Set(),ready=Promise.withResolvers(),held=Promise.withResolvers(),submit=Promise.withResolvers(),controllers=Array.from({length:count},()=>new AbortController());s.endpoint=f.endpoint;
   // No-inference prewarm keeps cold-start scheduling out of the overlap window.
   // Hold exclusive leases aside so each prewarm creates a distinct ready worker.
   const warmStarted=performance.now(),warmBody={model:m,messages:[{role:'user',content:'Warm worker without inference.'}]},warmWorkers=[];
   try{
    if(sharing)await bridge.prepare(warmBody,undefined,undefined,true);
    else{for(let i=0;i<count;i++){await bridge.prepare(warmBody,undefined,undefined,true);const worker=bridge.pool.take(bridge.workerKey(bridge.acceptedModels[m]));assert.ok(worker);warmWorkers.push(worker);}for(const worker of warmWorkers)await bridge.pool.put(worker);}
   }catch(error){await f.close();restoreEndpoint();throw error;}
   const prewarmMs=Math.round(performance.now()-warmStarted),originalFetch=globalThis.fetch;let submitted=0;
   globalThis.fetch=async(url,init)=>{if(/^\/session\/[^/]+\/prompt_async$/.test(new URL(url).pathname)){submitted++;if(submitted===count)submit.resolve();await submit.promise;}return originalFetch(url,init);};
   bridge.prepare=async function(...args){
    const run=await prepare.apply(this,args);runs.push(run);let meta;
    if(sharing)meta=JSON.parse(await readFile(path.join(owned(f,m,args[0]).home,'requests',run.sessionID,'hooks-ready.json'),'utf8'));
    else for(const worker of bridge.pool.workers){const candidate=await readFile(worker.hookFile,'utf8').then(JSON.parse,()=>undefined);if(candidate?.sessionID===run.sessionID){meta=candidate;break;}}
    assert.ok(Number.isSafeInteger(meta?.pid));pids.add(meta.pid);return run;
   };
   const label='REAL_MEMORY_'+nonce(),outputLimit=Math.min(16384,definitions[m].output);
   const jobs=controllers.map((controller,index)=>request('chat',body('chat',m,'This is a streaming data transfer measurement. Write exactly 1200 lines. Every line must contain "'+label+' 0123456789 abcdefghijklmnopqrstuvwxyz". Print every line in full. Do not use code, ellipses, summaries, or explanations.',{stream:true,max_completion_tokens:outputLimit}),{signal:controller.signal,onOutput:async()=>{if(!seen.has(index)){seen.add(index);if(seen.size===count)ready.resolve();await held.promise;}}}).catch(error=>{if(!controller.signal.aborted){ready.reject(error);throw error;}}));
   const all=Promise.all(jobs);void all.catch(()=>{});
   try{
    await Promise.race([ready.promise,all.then(()=>{throw new Error('Native requests ended before sustained overlap');})]);assert.equal(pids.size,sharing?1:count);assert.equal(runs.length,count);
    const active=()=>runs.every(run=>!run.lifecycle.completed&&!run.signal.aborted),samples=[];
    for(let i=0;i<3;i++){assert.ok(active(),'All native inferences must still be active');samples.push(await processMemory([...pids]));assert.ok(active(),'Native inference ended during sampling');}
    const max=key=>samples[0][key]===null?null:Math.max(...samples.map(sample=>sample[key]));
    rows.push({sharing,processes:pids.size,concurrentRequests:count,prewarmMs,synchronizedNativePrompts:submitted,workingSetBytes:max('workingSetBytes'),privateResidentBytes:max('privateResidentBytes'),privateCommittedBytes:max('privateCommittedBytes'),samples,allNativeInferencesActive:true});
   }finally{controllers.forEach(controller=>controller.abort());submit.resolve();held.resolve();await Promise.allSettled(jobs);await bridge.drain();globalThis.fetch=originalFetch;bridge.prepare=prepare;await f.close();restoreEndpoint();}
  }
  assert.ok(rows[1].privateResidentBytes<rows[0].privateResidentBytes,'Shared mode must reduce private resident memory for this real workload');return {rows,privateResidentReduction:1-rows[1].privateResidentBytes/rows[0].privateResidentBytes,note:'Three samples during verified overlapping native inference; not a startup peak or a general production percentage.'};
 });
 report.finished=new Date().toISOString();report.summary={checks:report.results.length,passed:report.results.filter(r=>r.pass).length,failed:report.results.filter(r=>!r.pass).length};save();
 console.log('SUMMARY '+JSON.stringify({...report.summary,report:path.join(dir,'report.json')}));assert.ok(report.results.length>selected.length,'No requested live regressions matched.');if(report.summary.failed)process.exitCode=1;
}finally{restoreEndpoint();await main.close();}
