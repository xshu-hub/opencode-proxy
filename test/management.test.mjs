import {test} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import http from 'node:http';
import {validateSettings,withModelDefaults} from '../lib/settings.mjs';
import {ProxyRuntime} from '../lib/runtime.mjs';
import {createAdminServer} from '../lib/admin-server.mjs';

const config=()=>({mode:'global',host:'127.0.0.1',port:0,diagnostics:false,apiKeys:[{id:'test',name:'测试客户端',key:'fixture-access-key',enabled:true}],modelOverrides:{}});
class Bridge{
  constructor(config){this.config=config;this.config.models={mock:{model:'fixture/mock',name:'模型',context:100000,output:1000,reasoning:true,reasoningEfforts:['low','high'],reasoningAdapter:'effort'}};this.acceptedModels={'fixture/mock':this.config.models.mock,...this.config.models};}
  async loadModels(){return this.config.models;}
  async close(){this.closed=true;}
  async fetch(_url,init){const body=JSON.parse(init.body);this.body=body;this.config.onDiagnostics?.({requestId:init.requestId,status:'completed',timings:{catalogMs:0,firstModelEvent:10,completion:1010},usage:{prompt_tokens:15,completion_tokens:8,prompt_tokens_details:{cached_tokens:5},completion_tokens_details:{reasoning_tokens:2}},tokens:{input:10,output:6,reasoning:2,cache:{read:5,write:0}}});return Response.json({id:'test',choices:[{message:{content:'fixture answer'},finish_reason:'stop'}],usage:{prompt_tokens:15,completion_tokens:8,prompt_tokens_details:{cached_tokens:5},completion_tokens_details:{reasoning_tokens:2}}});}
}
async function fixture(run){const directory=await mkdtemp(path.join(os.tmpdir(),'opencode-proxy-admin-'));let runtime,server;try{const settings=validateSettings(config(),directory).settings;runtime=new ProxyRuntime({file:path.join(directory,'config.json'),settings,Bridge});await runtime.initialize();server=createAdminServer({runtime,token:'fixture-admin-key'}).server;await new Promise(r=>server.listen(0,'127.0.0.1',r));await run({runtime,server,directory,base:'http://127.0.0.1:'+server.address().port});}finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await runtime?.close();await rm(directory,{recursive:true,force:true});}}
test('admin rejects wrong keys, cross-origin posts and DNS-rebinding hosts',async()=>fixture(async({base})=>{
  assert.equal((await fetch(base+'/admin/state')).status,401);
  assert.equal((await fetch(base+'/admin/config',{method:'POST',headers:{authorization:'Bearer fixture-admin-key',origin:'http://foreign.example'},body:'{}'})).status,403);
  const rejected=await new Promise(resolve=>{http.get(base+'/admin/state',{headers:{authorization:'Bearer fixture-admin-key',host:'foreign.example'}},res=>{res.resume();resolve(res.statusCode);});});assert.equal(rejected,403);
  const state=await(await fetch(base+'/admin/state',{headers:{authorization:'Bearer fixture-admin-key'}})).json();assert.equal(state.settings.apiKeys[0].name,'测试客户端');
}));
test('model aliases/defaults, key changes survive atomic save without killing active generations',async()=>fixture(async({runtime,directory})=>{
  const settings=structuredClone(runtime.settings);settings.modelOverrides={'fixture/mock':{alias:'short-name',defaults:{temperature:0.3,max_tokens:100}}};
  const old=runtime.current;old.active++;await runtime.save(settings);assert.equal(old.bridge.closed,undefined);
  const catalog=await runtime.models();assert.ok(catalog.some(m=>m.id==='short-name'));assert.equal(catalog.some(m=>m.id==='mock'),false);
  const body={model:'short-name',messages:[{role:'system',content:'full prompt sentinel'},{role:'user',content:'hello'}],temperature:0.7,max_completion_tokens:50,tools:[{type:'function',function:{name:'weather',parameters:{type:'object'}}}]};
  const response=await runtime.fetch('http://proxy/v1/chat/completions',{method:'POST',body:JSON.stringify(body)},undefined,{name:'客户端'});await response.text();
  assert.equal(runtime.current.bridge.body.temperature,0.7);assert.equal(runtime.current.bridge.body.max_tokens,undefined);
  const file=await readFile(path.join(directory,'config.json'),'utf8');assert.ok(file.includes('short-name'));
  assert.equal('statistics' in runtime.state(),false);assert.deepEqual((await readdir(directory)).sort(),['config.json']);
  await runtime.release(old);assert.equal(old.bridge.closed,true);
}));
test('stale model overrides do not block the catalog and return when OpenCode lists the model again',async()=>fixture(async({runtime,base,directory})=>{
  const retired={alias:'retired-short',enabled:false,output:500,defaults:{temperature:0.6}};
  await runtime.save({...runtime.settings,modelOverrides:{'fixture/retired':retired,'fixture/mock':{alias:'friendly',defaults:{temperature:0.4}}}});
  const saved=await readFile(path.join(directory,'config.json'),'utf8');
  const response=await fetch(base+'/admin/models',{headers:{authorization:'Bearer fixture-admin-key'}});
  assert.equal(response.status,200);
  const {models}=await response.json();assert.deepEqual(models.map(m=>m.id),['friendly']);
  assert.equal(models[0].defaults.temperature,0.4);assert.equal(runtime.current.bridge.acceptedModels['fixture/retired'],undefined);
  await assert.rejects(()=>runtime.updateModel('fixture/retired',{enabled:true}),e=>e.code==='model_not_found');
  await runtime.refresh();assert.deepEqual(runtime.settings.modelOverrides['fixture/retired'],retired);
  assert.equal(await readFile(path.join(directory,'config.json'),'utf8'),saved);
  runtime.Bridge=class extends Bridge{
    constructor(config){super(config);const model={model:'fixture/retired',name:'返回的模型',context:100000,output:1000};this.config.models.retired=model;this.acceptedModels.retired=model;this.acceptedModels['fixture/retired']=model;}
  };
  const restored=(await runtime.refresh()).find(m=>m.target==='fixture/retired');
  assert.equal(restored.id,'retired-short');assert.equal(restored.enabled,false);assert.equal(restored.output,500);assert.equal(restored.defaults.temperature,0.6);
  assert.equal(await readFile(path.join(directory,'config.json'),'utf8'),saved);
}));

test('model validation rejects conflicting aliases and invalid defaults before persistence',async()=>fixture(async({runtime,directory})=>{
  await assert.rejects(()=>runtime.save({...runtime.settings,modelOverrides:{'fixture/mock':{output:2000}}}),e=>e.code==='model_limit');
  assert.throws(()=>validateSettings({...config(),modelOverrides:{'fixture/mock':{defaults:{temperature:3}}}},directory));
  assert.deepEqual(withModelDefaults({max_completion_tokens:50,temperature:0.9},{defaults:{max_tokens:100,temperature:0.2,top_p:0.8}}),{max_completion_tokens:50,temperature:0.9,top_p:0.8});
}));
test('Magpie model editor batch save is atomic, clears overrides, and preserves other settings',async()=>fixture(async({runtime,base,directory})=>{
  const headers={authorization:'Bearer fixture-admin-key','content-type':'application/json'};
  const send=updates=>fetch(base+'/admin/models/batch',{method:'POST',headers,body:JSON.stringify({updates})});
  let response=await send([{target:'fixture/mock',patch:{alias:'short',defaults:{temperature:0.4,reasoning_effort:'high'}}}]);assert.equal(response.status,200);await response.json();
  const saved=await readFile(path.join(directory,'config.json'),'utf8'),generation=runtime.current;
  response=await send([{target:'fixture/mock',patch:{alias:'would-be-partially-saved'}},{target:'missing/model',patch:{enabled:false}}]);assert.equal(response.status,400);
  assert.equal(await readFile(path.join(directory,'config.json'),'utf8'),saved);assert.equal(runtime.current,generation);
  response=await send([{target:'fixture/mock',patch:{output:2000}}]);assert.equal(response.status,400);assert.equal(runtime.current,generation);
  response=await send([{target:'fixture/mock',patch:{alias:null,defaults:{temperature:null,reasoning_effort:null},reasoningPreset:{type:'native'},reasoningVariants:null}}]);assert.equal(response.status,200);await response.json();
  assert.equal((await runtime.models())[0].id,'mock');assert.deepEqual(runtime.settings.modelOverrides['fixture/mock'].defaults,{});assert.equal(runtime.settings.apiKeys[0].key,'fixture-access-key');
}));
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

test('selection-only reasoning configuration persists and generates the same SDK mapping for all model IDs',async()=>fixture(async({runtime,directory})=>{
  await runtime.updateModel('fixture/mock',{reasoningPreset:{type:'effort',levels:['high','max']},defaults:{reasoning_effort:'max'}});
  assert.deepEqual(runtime.current.bridge.acceptedModels['fixture/mock'].reasoningVariants,{high:{reasoningEffort:'high'},max:{reasoningEffort:'max'}});assert.equal((await runtime.models())[0].reasoningAdapter,'effort');
  const persisted=JSON.parse(await readFile(path.join(directory,'config.json'),'utf8')).modelOverrides['fixture/mock'];assert.equal(persisted.reasoningVariants,undefined);assert.deepEqual(persisted.reasoningPreset,{type:'effort',levels:['high','max']});
  await assert.rejects(()=>runtime.updateModel('fixture/mock',{reasoningPreset:{type:'budget',levels:['high'],budgets:{high:8192}}}),/SDK/);
}));
test('removed request-record endpoint returns 404 and old records are preserved untouched',async()=>fixture(async({runtime,base,directory})=>{
  const sentinel=path.join(directory,'statistics.json');await (await import('node:fs/promises')).writeFile(sentinel,'existing-user-data');
  await runtime.initialize();assert.equal('statistics' in runtime.state(),false);
  const reply=await fetch(base+'/admin/request/old',{headers:{authorization:'Bearer fixture-admin-key'}});assert.equal(reply.status,404);
  assert.equal(await readFile(sentinel,'utf8'),'existing-user-data');
}));

test('untracked streams forward bytes before EOF and release retired generations on cancellation exactly once',async()=>fixture(async({runtime,directory})=>{
  const old=runtime.current;let cancelled=0,closed=0;
  old.bridge.close=async()=>{closed++;};
  const bytes=new TextEncoder().encode('data: {"text":"你好"}\n\n');
  old.bridge.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,18));c.enqueue(bytes.subarray(18));},cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}});
  const response=await runtime.fetch('http://proxy/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'mock',messages:[{role:'user',content:'hello'}],stream:true})});
  const reader=response.body.getReader();assert.deepEqual((await reader.read()).value,bytes.subarray(0,18));
  await runtime.save({...runtime.settings,modelOverrides:{'fixture/mock':{alias:'new'}}});assert.equal(closed,0);assert.equal(old.active,1);
  assert.deepEqual((await reader.read()).value,bytes.subarray(18));await reader.cancel();assert.equal(cancelled,1);assert.equal(closed,1);assert.equal(old.active,0);assert.equal(runtime.generations.has(old),false);
  assert.deepEqual((await readdir(directory)).sort(),['config.json']);
}));
