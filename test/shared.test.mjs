import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SharedProcesses, disposalEvents } from '../lib/shared-processes.mjs';
import { BridgeWorker } from '../lib/worker-plugin.mjs';
import { nativeToolName } from '../lib/protocol.mjs';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
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

test('shared plugin rejects foreign sessions, unregistered local tools and directories outside its instance root',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'shared-plugin-contract-')),previous=process.env.OPENCODE_PROXY_SHARED_ROOT;
 process.env.OPENCODE_PROXY_SHARED_ROOT=root;
 try{
  const plugins=[];
  for(const key of ['a','b']){
   const directory=path.join(root,'instances',randomUUID(),'workspace');await mkdir(directory,{recursive:true});
   const file=path.join(directory,'.bridge-request.json');
   await writeFile(file,JSON.stringify({body:{model:'test',messages:[{role:'user',content:'PRIVATE_'+key}],tools:[{type:'function',function:{name:'allowed_'+key}}]},mcpURL:'http://127.0.0.1:1/'+key,mcpTimeout:1000}));
   await writeFile(file+'.session','session-'+key);plugins.push(await BridgeWorker({directory}));
  }
  const a=plugins[0];
  await a['tool.execute.before']({sessionID:'session-a',tool:nativeToolName('allowed_a')});
  await assert.rejects(()=>a['tool.execute.before']({sessionID:'session-b',tool:nativeToolName('allowed_a')}),/does not own/);
  await assert.rejects(()=>a['tool.execute.before']({sessionID:'session-a',tool:nativeToolName('allowed_b')}),/unregistered local tool/);
  await assert.rejects(()=>a['tool.execute.before']({sessionID:'session-a',tool:'bash'}),/unregistered local tool/);
  await assert.rejects(()=>a['chat.params']({sessionID:'session-b'},{}),/does not own/);
  await assert.rejects(()=>a['experimental.chat.system.transform']({sessionID:'session-b'},{system:[]}),/does not own/);
  await assert.rejects(()=>a['experimental.chat.messages.transform']({},{messages:[{info:{sessionID:'session-b'}}]}),/does not own/);
  await assert.rejects(()=>BridgeWorker({directory:root}),/Unknown shared OpenCode instance/);
  for(const plugin of plugins)await plugin.dispose();
  await assert.rejects(()=>a['tool.execute.before']({sessionID:'session-a',tool:nativeToolName('allowed_a')}),/does not own/);
 }finally{if(previous===undefined)delete process.env.OPENCODE_PROXY_SHARED_ROOT;else process.env.OPENCODE_PROXY_SHARED_ROOT=previous;await rm(root,{recursive:true,force:true});}
});
