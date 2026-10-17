import path from 'node:path';import assert from 'node:assert/strict';
import {models,protocols,body,request,check,summary,requireText,nonce,report,save,s,dir} from './live-client.mjs';
const schema={type:'object',properties:{answer:{type:'integer',const:323}},required:['answer'],additionalProperties:false};
const headers={authorization:'Bearer '+s.key,'content-type':'application/json'};
if(!process.argv.includes('--pressure-only')){
for(const m of models)for(const p of protocols){
 await check(p,m,'strict-json-schema-thinking-stream',async()=>{
  const format=p==='chat'?{response_format:{type:'json_schema',json_schema:{name:'result',schema,strict:true}}}:p==='responses'?{text:{format:{type:'json_schema',name:'result',schema,strict:true}}}:{output_config:{format:{type:'json_schema',schema},effort:'high'}};
  const r=await request(p,body(p,m,'Compute 17 times 19. Return answer in the requested JSON format.',{stream:true,mode:'on',...format}));assert.deepEqual(JSON.parse(r.text),{answer:323});return summary(r);
 });
 await check(p,m,'named-strict-tool-and-result-roundtrip',async()=>{
  const n=nonce(),tool={name:'lookup_ticket',description:'Read the secret code for a ticket. The result is unknown until the client executes this function.',parameters:{type:'object',properties:{ticket:{type:'string'}},required:['ticket'],additionalProperties:false},strict:true};
  const choice=p==='chat'?{type:'function',function:{name:tool.name}}:p==='responses'?{type:'function',name:tool.name}:{type:'tool',name:tool.name,disable_parallel_tool_use:true};
  const prompt='Look up ticket '+n+'. After receiving the tool result, output only secret_code.',b=body(p,m,prompt,{stream:true,mode:'on',tools:[tool],tool_choice:choice,...(p!=='anthropic'?{parallel_tool_calls:false}:{})}),first=await request(p,b);
  assert.equal(first.calls.length,1);const c=first.calls[0];assert.equal(c.name,tool.name);assert.equal(c.args.ticket,n);
  const secret='SECRET_'+nonce(),output=JSON.stringify({secret_code:secret});b.tool_choice=p==='anthropic'?{type:'none'}:'none';delete b.parallel_tool_calls;
  if(p==='chat')b.messages.push(first.raw.choices[0].message,{role:'tool',tool_call_id:c.id,content:output});
  else if(p==='responses')b.input=[{role:'user',content:prompt},...first.raw.output,{type:'function_call_output',call_id:c.id,output}];
  else b.messages.push({role:'assistant',content:first.raw.content},{role:'user',content:[{type:'tool_result',tool_use_id:c.id,content:output}]});
  const final=await request(p,b);requireText(final,secret);assert.equal(final.calls.length,0);return{call:c,first:summary(first),final:summary(final)};
 });
 await check(p,m,'100-turn-history-and-followup',async()=>{
  const markers={FIRST:nonce(),MIDDLE:nonce(),LAST:nonce()},messages=[];
  for(let i=0;i<100;i++){const key=i===0?'FIRST':i===49?'MIDDLE':i===99?'LAST':undefined;messages.push({role:'user',content:'Archive record '+i+'. '+(key?key+' secret is '+markers[key]+'. ':'')+'Payload: '+Array.from({length:25},()=>nonce()).join(' ')},{role:'assistant',content:'Archive record '+i+' stored.'});}
  messages.push({role:'user',content:'Recall the three labelled archive secrets FIRST, MIDDLE and LAST exactly. Output FIRST=<secret> MIDDLE=<secret> LAST=<secret> only.'});
  const b=body(p,m,'',{stream:true,...(p==='responses'?{input:messages}:{messages})}),first=await request(p,b);for(const n of Object.values(markers))requireText(first,n);
  if(p==='responses')b.input.push(...first.raw.output,{role:'user',content:'Output the original FIRST secret again, unchanged.'});
  else b.messages.push(p==='chat'?first.raw.choices[0].message:{role:'assistant',content:first.raw.content},{role:'user',content:'Output the original FIRST secret again, unchanged.'});
  const second=await request(p,b);requireText(second,markers.FIRST);return{historyMessages:201,requestBytes:Buffer.byteLength(JSON.stringify(b)),markers,first:summary(first),followup:summary(second)};
 });
 await check(p,m,'parallel-two-tools-reversed-results',async()=>{
  const n=nonce(),tools=['lookup_alpha','lookup_beta'].map(name=>({name,description:'Independent lookup; safe to call in the same batch as the other lookup.',parameters:{type:'object',properties:{ticket:{type:'string'}},required:['ticket'],additionalProperties:false},strict:true}));
  const prompt='Call BOTH lookup_alpha and lookup_beta with ticket "'+n+'" in the SAME tool call batch. They are independent: do not wait for either result before calling the other. After BOTH tool results arrive, output both returned secret_code values and nothing else.';
  const b=body(p,m,prompt,{stream:true,mode:'on',tools}),first=await request(p,b);assert.equal(first.calls.length,2,'Expected two parallel calls, got '+JSON.stringify(first.calls));assert.deepEqual(first.calls.map(c=>c.name).sort(),['lookup_alpha','lookup_beta']);for(const c of first.calls)assert.equal(c.args.ticket,n);
  const secrets=first.calls.map(()=>nonce()),outputs=first.calls.map((c,i)=>({id:c.id,output:JSON.stringify({secret_code:secrets[i]})})).reverse();
  if(p==='chat')b.messages.push(first.raw.choices[0].message,...outputs.map(c=>({role:'tool',tool_call_id:c.id,content:c.output})));
  else if(p==='responses')b.input=[{role:'user',content:prompt},...first.raw.output,...outputs.map(c=>({type:'function_call_output',call_id:c.id,output:c.output}))];
  else b.messages.push({role:'assistant',content:first.raw.content},{role:'user',content:outputs.map(c=>({type:'tool_result',tool_use_id:c.id,content:c.output}))});
  const final=await request(p,b);for(const secret of secrets)requireText(final,secret);assert.equal(final.calls.length,0);return{calls:first.calls,reversedResultIds:outputs.map(c=>c.id),first:summary(first),final:summary(final)};
 });
}
for(const m of models)await check('responses',m,'stored-response-continuation-retrieve-delete',async()=>{
 const n=nonce(),first=await request('responses',body('responses',m,'Remember this secret '+n+'. Reply OK.',{store:true}));const id=first.raw.id;
 assert.equal(first.raw.store,true);const next=await request('responses',{previous_response_id:id,input:'Return the secret from the first turn only.',store:true,stream:true,max_output_tokens:512,reasoning:{effort:'none'}});requireText(next,n);assert.equal(next.raw.previous_response_id,id);
 const get=await fetch(s.endpoint+'/responses/'+id,{headers});assert.equal(get.status,200);assert.equal((await get.json()).id,id);
 const deleted=await fetch(s.endpoint+'/responses/'+id,{method:'DELETE',headers});assert.equal(deleted.status,200);assert.equal((await deleted.json()).deleted,true);
 const missing=await fetch(s.endpoint+'/responses/'+id,{headers});assert.equal(missing.status,404);return{first:summary(first),continuation:summary(next),retrieved:true,deleted:true};
});
}
const concurrency=Number(process.env.OPENCODE_PROXY_LIVE_CONCURRENCY??12);
assert.ok(Number.isSafeInteger(concurrency)&&concurrency>=1&&concurrency<=64,'Live concurrency must be between 1 and 64.');
await check('all','both','unlimited-concurrency-'+concurrency,async()=>{
 const started=Date.now();
 // Keep observation inside this process: spawning CLR monitors under load can
 // consume the Windows process resources the gateway is being tested against.
 const settled=await Promise.allSettled(Array.from({length:concurrency},async(_,i)=>{const p=protocols[i%3],m=models[Math.floor(i/3)%models.length],n=nonce(),startMs=Date.now()-started,r=await request(p,body(p,m,'Output only CONCURRENT_'+n,{stream:true}));requireText(r,n);return{protocol:p,model:m,nonce:n,startMs,endMs:Date.now()-started,...summary(r)};}));
 const failures=settled.filter(r=>r.status==='rejected').map(r=>r.reason.message),requests=settled.filter(r=>r.status==='fulfilled').map(r=>r.value);
 report.concurrentAttempt={concurrency,failures,requests};save();assert.equal(failures.length,0,JSON.stringify(failures));assert.equal(requests.length,concurrency);
 assert.ok(Math.max(...requests.map(r=>r.startMs))<Math.min(...requests.map(r=>r.endMs)),'Requests did not overlap');
 return{concurrency,allRequestsOverlap:true,totalMs:Date.now()-started,requests};
});
if(process.env.OPENCODE_PROXY_LIVE_ADMIN_URL&&process.env.OPENCODE_PROXY_LIVE_ADMIN_KEY)await check('all','both','64-request-burst-with-capacity-limit',async()=>{
 const url=process.env.OPENCODE_PROXY_LIVE_ADMIN_URL,headers={'content-type':'application/json',authorization:'Bearer '+process.env.OPENCODE_PROXY_LIVE_ADMIN_KEY},admin=async(route,method='GET',body)=>fetch(url+route,{method,headers,body:body?JSON.stringify(body):undefined});
 const original=(await(await admin('/admin/state')).json()).settings;let result;
 try{
  const changed=await admin('/admin/config','POST',{...original,maxConcurrent:8});assert.equal(changed.status,200);
  const settled=await Promise.allSettled(Array.from({length:64},async(_,i)=>{const p=protocols[i%3],m=models[Math.floor(i/3)%models.length],n=nonce();try{const r=await request(p,body(p,m,'Output only BURST_'+n,{stream:true}));requireText(r,n);return{pass:true,protocol:p,model:m,...summary(r)};}catch(e){if(e.status!==429)throw e;return{busy:true,status:429};}}));
  const errors=settled.filter(r=>r.status==='rejected').map(r=>r.reason.message);assert.equal(errors.length,0,JSON.stringify(errors));const requests=settled.map(r=>r.value);
  const success=requests.filter(x=>x.pass),busy=requests.filter(x=>x.busy);assert.ok(success.length>0&&success.length<=8);assert.ok(busy.length>=56);result={submitted:64,configuredMaxConcurrent:8,succeeded:success.length,busy:busy.length,requests};
 }finally{const restored=await admin('/admin/config','POST',original);assert.equal(restored.status,200);}
 const n=nonce(),recovered=await request('chat',body('chat',models[0],'Output only RECOVER_'+n));requireText(recovered,n);return{...result,restoredDefaultUnlimited:original.maxConcurrent===0,recovery:summary(recovered)};
});
report.finished=new Date().toISOString();report.summary={checks:report.results.length,passed:report.results.filter(x=>x.pass).length,failed:report.results.filter(x=>!x.pass).length};save();console.log('SUMMARY '+JSON.stringify({...report.summary,report:path.join(dir,'report.json')}));if(report.summary.failed)process.exitCode=1;
