import {test} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {validateSettings,withModelDefaults} from '../lib/settings.mjs';
import {ProxyRuntime} from '../lib/runtime.mjs';
import {createAdminServer} from '../lib/admin-server.mjs';
import {ledDecode,flowMs} from '../lib/magpie-metrics.mjs';
import {Telemetry} from '../lib/telemetry.mjs';

const config=()=>({mode:'global',host:'127.0.0.1',port:0,diagnostics:false,apiKeys:[{id:'test',name:'测试客户端',key:'fixture-access-key',enabled:true}],modelOverrides:{}});
class Bridge{
  constructor(config){this.config=config;this.config.models={mock:{model:'fixture/mock',name:'模型',context:100000,output:1000,reasoning:true,reasoningEfforts:['low','high']}};this.acceptedModels={'fixture/mock':this.config.models.mock,...this.config.models};}
  async loadModels(){return this.config.models;}
  async close(){this.closed=true;}
  async fetch(_url,init){const body=JSON.parse(init.body);this.body=body;this.config.onDiagnostics({requestId:init.requestId,status:'completed',timings:{catalogMs:0,firstModelEvent:10,completion:1010},usage:{prompt_tokens:15,completion_tokens:8,prompt_tokens_details:{cached_tokens:5},completion_tokens_details:{reasoning_tokens:2}},tokens:{input:10,output:6,reasoning:2,cache:{read:5,write:0}}});return Response.json({id:'test',choices:[{message:{content:'fixture answer'},finish_reason:'stop'}],usage:{prompt_tokens:15,completion_tokens:8,prompt_tokens_details:{cached_tokens:5},completion_tokens_details:{reasoning_tokens:2}}});}
}
async function fixture(run){const directory=await mkdtemp(path.join(os.tmpdir(),'opencode-proxy-admin-'));let runtime,server;try{const settings=validateSettings(config(),directory).settings;runtime=new ProxyRuntime({file:path.join(directory,'config.json'),settings,Bridge});await runtime.initialize();server=createAdminServer({runtime,token:'fixture-admin-key'}).server;await new Promise(r=>server.listen(0,'127.0.0.1',r));await run({runtime,server,directory,base:'http://127.0.0.1:'+server.address().port});}finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await runtime?.close();await rm(directory,{recursive:true,force:true});}}
test('admin rejects wrong keys, cross-origin posts and DNS-rebinding hosts',async()=>fixture(async({base})=>{
  assert.equal((await fetch(base+'/admin/state')).status,401);
  assert.equal((await fetch(base+'/admin/config',{method:'POST',headers:{authorization:'Bearer fixture-admin-key',origin:'http://foreign.example'},body:'{}'})).status,403);
  const rejected=await new Promise(resolve=>{http.get(base+'/admin/state',{headers:{authorization:'Bearer fixture-admin-key',host:'foreign.example'}},res=>{res.resume();resolve(res.statusCode);});});assert.equal(rejected,403);
  const state=await(await fetch(base+'/admin/state',{headers:{authorization:'Bearer fixture-admin-key'}})).json();assert.equal(state.settings.apiKeys[0].name,'测试客户端');
}));
test('model aliases/defaults, key changes and request details survive atomic save without killing active generations',async()=>fixture(async({runtime,directory})=>{
  const settings=structuredClone(runtime.settings);settings.modelOverrides={'fixture/mock':{alias:'short-name',defaults:{temperature:0.3,max_tokens:100}}};
  const old=runtime.current;old.active++;await runtime.save(settings);assert.equal(old.bridge.closed,undefined);
  const catalog=await runtime.models();assert.ok(catalog.some(m=>m.id==='short-name'));assert.equal(catalog.some(m=>m.id==='mock'),false);
  const body={model:'short-name',messages:[{role:'system',content:'full prompt sentinel'},{role:'user',content:'hello'}],temperature:0.7,max_completion_tokens:50,tools:[{type:'function',function:{name:'weather',parameters:{type:'object'}}}]};
  const response=await runtime.fetch('http://proxy/v1/chat/completions',{method:'POST',body:JSON.stringify(body)},undefined,{name:'客户端'});await response.text();
  assert.equal(runtime.current.bridge.body.temperature,0.7);assert.equal(runtime.current.bridge.body.max_tokens,undefined);
  const row=runtime.telemetry.rows[0];assert.equal(row.ttftMs,undefined,'Non-streamed replies are not timed, as in Magpie');assert.equal(row.tokensPerSecond,undefined);assert.equal(row.inputTokens,10);assert.equal(row.cacheRead,5);
  const detail=await runtime.requests.detail(row.id);assert.deepEqual(detail.requestedBody,body);assert.equal(detail.effectiveBody.temperature,0.7);assert.match(detail.responsePreview,/fixture answer/);
  const file=await readFile(path.join(directory,'config.json'),'utf8');assert.ok(file.includes('short-name'));assert.equal((await readFile(path.join(directory,'statistics.json'),'utf8').catch(()=>'' )).includes('full prompt sentinel'),false);
  await runtime.release(old);assert.equal(old.bridge.closed,true);
}));
test('model validation rejects conflicting aliases and invalid defaults before persistence',async()=>fixture(async({runtime,directory})=>{
  await assert.rejects(()=>runtime.save({...runtime.settings,modelOverrides:{'fixture/mock':{output:2000}}}),e=>e.code==='model_limit');
  assert.throws(()=>validateSettings({...config(),modelOverrides:{'fixture/mock':{defaults:{temperature:3}}}},directory));
  assert.deepEqual(withModelDefaults({max_completion_tokens:50,temperature:0.9},{defaults:{max_tokens:100,temperature:0.2,top_p:0.8}}),{max_completion_tokens:50,temperature:0.9,top_p:0.8});
}));
test('Magpie reasoning/TTFT/speed samples match the original ledger regression cases',()=>{
  const rows=[{out:2200,reasoning:2000,ms:15500,ttft_ms:14000,first_text_ms:14000},{out:2200,reasoning:2000,ms:15500,ttft_ms:13990,first_text_ms:14000},{out:1300,reasoning:1000,ms:9000,ttft_ms:6000,first_text_ms:6000},{out:1500,reasoning:1400,ms:9000,ttft_ms:8000,first_text_ms:0},{out:900,reasoning:1000,ms:9000,ttft_ms:6000,first_text_ms:6000},{out:500,reasoning:0,ms:7000,ttft_ms:2000},{out:900,reasoning:300,ms:7000}];
  const decoded=rows.map(r=>ledDecode({...r,status:200})).filter(Boolean);
  assert.equal(decoded.reduce((n,r)=>n+r.n,0),1200);assert.equal(decoded.reduce((n,r)=>n+r.w,0),11000);
  assert.equal(ledDecode({status:200,out:8264,ms:24360,ttft_ms:24359}),null);
  assert.equal(ledDecode({status:499,out:500,ms:7000,ttft_ms:2000}),null);
  assert.equal(ledDecode({status:200,out:200,ms:5000,ttft_ms:1000,flow_ms:100}),null);
  assert.equal(flowMs([{at:1000,sum:10},{at:1100,sum:20},{at:1900,sum:90},{at:2000,sum:100}],1000),1125);
});
test('model switches reject new calls on all protocols and qualification cannot bypass aliases/defaults',async()=>fixture(async({runtime})=>{
  await runtime.updateModel('fixture/mock',{alias:'friendly',defaults:{temperature:0.4,reasoning_effort:'high'}});
  const response=await runtime.fetch('http://proxy/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'fixture/mock',messages:[{role:'user',content:'hello'}]})});await response.text();assert.equal(runtime.current.bridge.body.temperature,0.4);assert.equal(runtime.current.bridge.body.reasoning_effort,'high');
  await runtime.updateModel('fixture/mock',{enabled:false});assert.equal((await runtime.models())[0].enabled,false);assert.deepEqual(Object.keys(runtime.current.bridge.config.models),[]);
  for(const [route,body] of [['chat/completions',{model:'friendly',messages:[{role:'user',content:'hi'}]}],['responses',{model:'fixture/mock',input:'hi'}],['messages',{model:'friendly',messages:[{role:'user',content:'hi'}],max_tokens:20}]]){
    const rejected=await runtime.fetch('http://proxy/v1/'+route,{method:'POST',body:JSON.stringify(body)});assert.equal(rejected.status,403);assert.match(JSON.stringify(await rejected.json()),/停用/);
  }
  await runtime.updateModel('fixture/mock',{enabled:true});assert.equal((await runtime.models())[0].enabled,true);assert.equal(runtime.settings.modelOverrides['fixture/mock'].defaults.reasoning_effort,'high');
}));
test('concurrent model updates merge and native reasoning choices validate before persistence',async()=>fixture(async({runtime,directory})=>{
  await Promise.all([runtime.updateModel('fixture/mock',{enabled:false}),runtime.updateModel('fixture/mock',{defaults:{temperature:0.5,reasoning_effort:'low'}})]);
  const m=(await runtime.models())[0];assert.equal(m.enabled,false);assert.equal(m.defaults.temperature,0.5);assert.equal(m.defaults.reasoning_effort,'low');
  const before=await readFile(path.join(directory,'config.json'),'utf8');await assert.rejects(()=>runtime.updateModel('fixture/mock',{defaults:{reasoning_effort:'xhigh'}}),e=>e.code==='unsupported_reasoning_effort');assert.equal(await readFile(path.join(directory,'config.json'),'utf8'),before);
  await runtime.updateModel('fixture/mock',{defaults:{reasoning_effort:null}});assert.equal((await runtime.models())[0].defaults.reasoning_effort,undefined);assert.equal((await runtime.models())[0].defaults.temperature,0.5);
}));

test('custom mappings extend native choices and clearing them validates default selection atomically',async()=>fixture(async({runtime,directory})=>{
  await runtime.updateModel('fixture/mock',{reasoningVariants:{max:{reasoningEffort:'max'}},defaults:{reasoning_effort:'max'}});
  const model=(await runtime.models())[0];assert.deepEqual(model.reasoningEfforts,['low','high','max']);assert.deepEqual(model.customReasoningEfforts,['max']);
  assert.equal(runtime.current.bridge.acceptedModels['fixture/mock'].reasoningVariants.max.reasoningEffort,'max');
  const saved=await readFile(path.join(directory,'config.json'),'utf8');
  await assert.rejects(()=>runtime.updateModel('fixture/mock',{reasoningVariants:{}}),e=>e.code==='unsupported_reasoning_effort');assert.equal(await readFile(path.join(directory,'config.json'),'utf8'),saved);
  await runtime.updateModel('fixture/mock',{reasoningVariants:null,defaults:{reasoning_effort:null}});assert.deepEqual((await runtime.models())[0].customReasoningEfforts,[]);assert.deepEqual((await runtime.models())[0].reasoningEfforts,['low','high']);
}));
test('statistics persist, failed/cancelled requests do not influence Magpie speed and failed includes cancellation',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'opencode-proxy-stats-'));try{const telemetry=new Telemetry(path.join(directory,'statistics.json'));await telemetry.load();const id=randomUUID();telemetry.begin({id,model:'m',startedAt:new Date().toISOString(),startedMs:Date.now()-7000,stream:true,clientFirstMs:2000,usage:{prompt_tokens:10,completion_tokens:500}});telemetry.finish(id,{httpStatus:200});await telemetry.close();assert.equal(telemetry.totals.generationTokens,500);assert.ok(telemetry.totals.generationMs>=5000);const cancelled=randomUUID();telemetry.begin({id:cancelled,model:'m',startedAt:new Date().toISOString(),startedMs:Date.now()-5000,stream:true,clientFirstMs:1000,cancelled:true});telemetry.finish(cancelled,{httpStatus:499});await telemetry.close();const restored=new Telemetry(telemetry.file);await restored.load();assert.equal(restored.totals.requests,2);assert.equal(restored.totals.failed,1);assert.equal(restored.totals.cancelled,1);assert.equal(restored.totals.ttftSamples,1);}finally{await rm(directory,{recursive:true,force:true});}
});
