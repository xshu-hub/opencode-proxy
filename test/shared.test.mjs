import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SharedProcesses, disposalEvents } from '../lib/shared-processes.mjs';
import { BridgeWorker } from '../lib/worker-plugin.mjs';
import { nativeToolName,toNativeHistory } from '../lib/protocol.mjs';
import { sharedContract } from '../lib/shared-contract.mjs';
import { normalizeConfig } from '../lib/bridge.mjs';
import { mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const config={workerReuse:true,maxIdleWorkers:2,workerIdleMs:10000};
const fake=dispose=>({worker:{child:{exitCode:null}},dispose});
test('shared startup is deduplicated and cancelling its first waiter preserves other requests',async()=>{
 const pool=new SharedProcesses(config),ready=Promise.withResolvers(),cancel=new AbortController();let creates=0,disposed=0;
 const create=async()=>{creates++;await ready.promise;return fake(async()=>{disposed++;});};
 try{
  const a=pool.acquire('realm-a',create,cancel.signal),b=pool.acquire('realm-a',create);
  cancel.abort(new Error('cancel only a'));await assert.rejects(a,/cancel only a/);
  ready.resolve();const lease=await b;
  assert.equal(creates,1);assert.equal(disposed,0);await lease.release();
  assert.equal(pool.entries.get('realm-a').refs,0);
 }finally{ready.resolve();await pool.close();}
 assert.equal(disposed,1);
});

test('failed instance cleanup drains a shared process without killing other active leases',async()=>{
 const pool=new SharedProcesses(config);let disposed=0;
 const create=async()=>fake(async()=>{disposed++;});
 try{
  const a=await pool.acquire('realm',create),b=await pool.acquire('realm',create);
  assert.equal(a.process,b.process);await a.release(true);
  assert.equal(disposed,0);assert.equal(pool.has('realm'),false);
  const next=await pool.acquire('realm',create);assert.notEqual(next.process,b.process);
  await b.release();assert.equal(disposed,1);await next.release();
 }finally{await pool.close();}
 assert.equal(disposed,2);
});

test('credentials and generations use separate process keys and shutdown owns draining processes',async()=>{
 const pool=new SharedProcesses(config),disposed=[];
 const acquire=key=>pool.acquire(key,async()=>fake(async()=>{disposed.push(key);}));
 try{
  const a=await acquire('credential-a'),b=await acquire('credential-b');
  assert.notEqual(a.process,b.process);await a.release(true);
  await pool.close();assert.deepEqual(disposed.sort(),['credential-a','credential-b']);
  await b.release();
 }finally{await pool.close();}
});

test('idle tool variants yield space before evicting another protected model',async()=>{
 const pool=new SharedProcesses(config,()=>true),disposed=[];
 const acquire=(key,base)=>pool.acquire(key,async()=>fake(async()=>disposed.push(key)),undefined,base);
 try{
  const a=await acquire('model-a/tools-1','model-a'),b=await acquire('model-b/empty','model-b'),c=await acquire('model-a/tools-2','model-a');
  await b.release();await a.release();await c.release();
  assert.ok(pool.has('model-b/empty'));assert.ok(pool.has('model-a/tools-2'));assert.equal(pool.has('model-a/tools-1'),false);
 }finally{await pool.close();}
 assert.equal(disposed.length,3);
});

test('instance disposal requires its own directory acknowledgement and does not retain unrelated events',async()=>{
 const events=[];let stopped=false;
 const iterator=(async function*(){while(!stopped){if(events.length)yield events.shift();else await delay(1);}})();
 const confirmations=disposalEvents(iterator);
 try{
  let done=false;
  const disposed=confirmations.dispose('/request-a',async()=>{events.push({payload:{type:'server.instance.disposed',properties:{directory:'/request-b'}}});},1000).then(()=>{done=true;});
  await delay(10);assert.equal(done,false);
  events.push({payload:{type:'server.instance.disposed',properties:{directory:'/request-a'}}});await disposed;
  await assert.rejects(()=>confirmations.dispose('/missing',async()=>{},10),/not confirmed/);
 }finally{await confirmations.close(()=>{stopped=true;});}
});

test('shared contracts isolate complete tool schemas and permissions but exclude request text and sampling',()=>{
 const tool={type:'function',function:{name:'lookup',strict:true,parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}};
 const a={tools:[tool],messages:[{role:'user',content:'PRIVATE_A'}],temperature:0},b={...a,messages:[{role:'user',content:'PRIVATE_B'}],temperature:1};
 assert.equal(sharedContract(a).hash,sharedContract(b).hash);
 const changed=structuredClone(b);changed.tools[0].function.parameters.properties.city={type:'integer'};
 assert.notEqual(sharedContract(a).hash,sharedContract(changed).hash);
 assert.notEqual(sharedContract(a).hash,sharedContract({...a,tool_choice:'none'}).hash);
 assert.notEqual(sharedContract(a).hash,sharedContract({...a,tools:[{...tool,function:{...tool.function,description:'Other contract'}}]}).hash);
 const reordered={tools:[{function:{parameters:{required:['city'],properties:{city:{type:'string'}},type:'object'},strict:true,name:'lookup'},type:'function'}]};
 assert.equal(sharedContract(a).hash,sharedContract(reordered).hash);
 assert.ok(!JSON.stringify(sharedContract(a)).includes('PRIVATE_A'));
 assert.throws(()=>normalizeConfig({mode:'global',workerSharing:true}),/真实工作目录/);
 const history=toNativeHistory({messages:[{role:'user',content:'earlier'},{role:'assistant',content:'answer'},{role:'user',content:'next'}]},'session','model','/project/subdir','provider','/project');
 assert.deepEqual(history.messages[1].info.path,{cwd:'/project/subdir',root:'/project'});
});

test('one real-directory plugin owns independent session histories, cancellation and release acknowledgements',{timeout:5000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'shared-plugin-contract-')),previous=process.env.OPENCODE_PROXY_SHARED_ROOT;
 process.env.OPENCODE_PROXY_SHARED_ROOT=root;
 let plugin;
 try{
  const directory=path.join(root,'real workspace 中文');await mkdir(directory);
  const tools=[{type:'function',function:{name:'lookup'}}],contract=sharedContract({tools}),groupID=randomUUID();
  await writeFile(path.join(root,'shared.json'),JSON.stringify({version:2,directory:await realpath(directory),contract,groupID,mcpURL:'http://127.0.0.1:1/private',mcpTimeout:1000}));
  for(const key of ['a','b']){
   const home=path.join(root,'requests','session-'+key);await mkdir(home,{recursive:true});
   await writeFile(path.join(home,'request.json'),JSON.stringify({sessionID:'session-'+key,requestID:'request-'+key,groupID,body:{model:'test',messages:[{role:'system',content:'SYSTEM_'+key},{role:'user',content:'PRIVATE_'+key}],tools}}));
  }
  plugin=await BridgeWorker({directory});
  const outputs=['a','b'].map(key=>({messages:[{info:{sessionID:'session-'+key,model:{modelID:'model',providerID:'global'}},parts:[]}]}));
  await Promise.all(outputs.map(output=>plugin['experimental.chat.messages.transform']({},output)));
  for(const [i,key] of ['a','b'].entries()){assert.equal(outputs[i].messages[0].parts[0].text,'PRIVATE_'+key);const system={system:[]};await plugin['experimental.chat.system.transform']({sessionID:'session-'+key},system);assert.deepEqual(system.system,['SYSTEM_'+key]);}
  const mixed={messages:[{info:{sessionID:'session-a'}},{info:{sessionID:'session-b'}}]};
  await assert.rejects(()=>plugin['experimental.chat.messages.transform']({},mixed),/Mixed/);
  await assert.rejects(()=>BridgeWorker({directory:root}),/does not own/);
  await plugin['tool.execute.before']({sessionID:'session-b',tool:nativeToolName('lookup')});
  await assert.rejects(()=>plugin['tool.execute.before']({sessionID:'session-a',tool:'bash'}),/unregistered local tool/);
  await assert.rejects(()=>plugin['tool.execute.before']({sessionID:'../../foreign',tool:nativeToolName('lookup')}),/Invalid native session/);
  const continuation=plugin['experimental.chat.messages.transform']({},outputs[0]);void continuation.catch(()=>{});
  await writeFile(path.join(root,'requests','session-a','closing'),'');
  await plugin.event({event:{type:'session.deleted',properties:{info:{id:'session-a'}}}});
  await assert.rejects(continuation,/continuation was cancelled|closed/);
  assert.deepEqual(JSON.parse(await readFile(path.join(root,'requests','session-a','released.json'),'utf8')),{sessionID:'session-a',requestID:'request-a',groupID});
  await assert.rejects(()=>plugin['tool.execute.before']({sessionID:'session-a',tool:nativeToolName('lookup')}),/closed/);
  await plugin['tool.execute.before']({sessionID:'session-b',tool:nativeToolName('lookup')});
  assert.deepEqual(await readdir(directory),[],'Plugin must not create proxy state in the project');
  // A session file from another process group cannot join this instance.
  const foreign=path.join(root,'requests','foreign');await mkdir(foreign);await writeFile(path.join(foreign,'request.json'),JSON.stringify({sessionID:'foreign',groupID:'other',body:{tools}}));
  await assert.rejects(()=>plugin['tool.execute.before']({sessionID:'foreign',tool:nativeToolName('lookup')}),/does not own/);
  const mismatch=path.join(root,'requests','mismatch');await mkdir(mismatch);await writeFile(path.join(mismatch,'request.json'),JSON.stringify({sessionID:'mismatch',groupID,body:{tools:[{type:'function',function:{name:'other'}}]}}));
  await assert.rejects(()=>plugin['tool.execute.before']({sessionID:'mismatch',tool:nativeToolName('other')}),/does not own/);
 }finally{await plugin?.dispose();if(previous===undefined)delete process.env.OPENCODE_PROXY_SHARED_ROOT;else process.env.OPENCODE_PROXY_SHARED_ROOT=previous;await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
