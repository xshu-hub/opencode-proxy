import {test} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,readFile,rm,readdir,writeFile} from 'node:fs/promises';
import http from 'node:http';
import {validateSettings,withModelDefaults,readSettings} from '../lib/settings.mjs';
import {ProxyRuntime} from '../lib/runtime.mjs';
import {createAdminServer} from '../lib/admin-server.mjs';
import {sseEvents,validateRequest} from '../lib/protocol.mjs';

const config=()=>({mode:'global',host:'127.0.0.1',port:0,diagnostics:false,apiKeys:[{id:'test',name:'测试客户端',key:'fixture-access-key',enabled:true}],modelOverrides:{}});
class Bridge{
  constructor(config){this.config=config;this.config.models={mock:{model:'fixture/mock',name:'模型',context:100000,output:1000,reasoning:true,reasoningEfforts:['low','high'],reasoningAdapter:'effort'}};this.acceptedModels={'fixture/mock':this.config.models.mock,...this.config.models};}
  async loadModels(){return this.config.models;}
  async close(){this.closed=true;}
  async fetch(_url,init){const body=JSON.parse(init.body);this.body=body;this.config.onDiagnostics?.({requestId:init.requestId,status:'completed',timings:{catalogMs:0,firstModelEvent:10,completion:1010},usage:{prompt_tokens:15,completion_tokens:8,prompt_tokens_details:{cached_tokens:5},completion_tokens_details:{reasoning_tokens:2}},tokens:{input:10,output:6,reasoning:2,cache:{read:5,write:0}}});return Response.json({id:'test',choices:[{message:{content:'fixture answer'},finish_reason:'stop'}],usage:{prompt_tokens:15,completion_tokens:8,prompt_tokens_details:{cached_tokens:5},completion_tokens_details:{reasoning_tokens:2}}});}
}
async function fixture(run){const directory=await mkdtemp(path.join(os.tmpdir(),'opencode-proxy-admin-'));let runtime,server;try{const settings=validateSettings(config(),directory).settings;runtime=new ProxyRuntime({file:path.join(directory,'config.json'),settings,Bridge});await runtime.initialize();server=createAdminServer({runtime,token:'fixture-admin-key'}).server;await new Promise(r=>server.listen(0,'127.0.0.1',r));await run({runtime,server,directory,base:'http://127.0.0.1:'+server.address().port});}finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await runtime?.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}}
test('admin rejects wrong keys, cross-origin posts and DNS-rebinding hosts',async()=>fixture(async({base})=>{
  assert.equal((await fetch(base+'/admin/state')).status,401);
  assert.equal((await fetch(base+'/admin/config',{method:'POST',headers:{authorization:'Bearer fixture-admin-key',origin:'http://foreign.example'},body:'{}'})).status,403);
  const rejected=await new Promise(resolve=>{http.get(base+'/admin/state',{headers:{authorization:'Bearer fixture-admin-key',host:'foreign.example'}},res=>{res.resume();resolve(res.statusCode);});});assert.equal(rejected,403);
  const state=await(await fetch(base+'/admin/state',{headers:{authorization:'Bearer fixture-admin-key'}})).json();assert.equal(state.settings.apiKeys[0].name,'测试客户端');
}));

test('retired upstream channels are backed up locally before removal and cannot be configured again',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'opencode-retired-config-')),file=path.join(directory,'config.json');
 try{
  const original=JSON.stringify({...config(),channels:[{id:'retired',keys:[{key:'retired-fixture-secret'}]}]},null,2);
  await writeFile(file,original);const settings=await readSettings(file);
  assert.equal(Object.hasOwn(settings,'channels'),false);assert.equal(settings.apiKeys[0].key,'fixture-access-key');
  const files=await readdir(directory),backup=files.find(name=>name.startsWith('config.json.before-local-only.'));
  assert.ok(backup);assert.equal(await readFile(path.join(directory,backup),'utf8'),original);
  assert.ok(!(await readFile(file,'utf8')).includes('retired-fixture-secret'));
  await readSettings(file);assert.deepEqual((await readdir(directory)).sort(),files.sort());
  assert.throws(()=>validateSettings({...settings,channels:[]},directory),/未知配置字段/);
  assert.equal(settings.workerSharing,false);assert.throws(()=>validateSettings({...settings,workerSharing:true},directory),/真实工作目录/);assert.equal(validateSettings({...settings,workingDirectory:directory,workerSharing:true},directory).settings.workerSharing,true);
 }finally{await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('removed channel management endpoint returns 404 without exposing any channel status',async()=>fixture(async({runtime,base})=>{
 assert.equal(Object.hasOwn(runtime.state(),'channelStatus'),false);
 const response=await fetch(base+'/admin/channels/reset-key',{method:'POST',headers:{authorization:'Bearer fixture-admin-key','content-type':'application/json'},body:'{}'});
 assert.equal(response.status,404);
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
test('gateway accepts DSH inventory for normal and streaming requests on all three routes',async()=>fixture(async({runtime})=>{
  const seen=[];
  runtime.current.bridge.fetch=async(url,init)=>{
    const body=JSON.parse(init.body);validateRequest(body,runtime.current.bridge.acceptedModels);seen.push({url,body});
    if(!body.stream)return Response.json({choices:[{message:{content:'fixture answer'},finish_reason:'stop'}]});
    const chunks=[{choices:[{index:0,delta:{content:'fixture answer'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]}];
    return new Response(chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  await runtime.startGateway();const base=runtime.state().endpoint;
  const headers={authorization:'Bearer fixture-access-key','content-type':'application/json'};
  for(const [route,request,completion] of [
    ['chat/completions',{messages:[{role:'user',content:'hello'}]},undefined],
    ['responses',{input:'hello'},'response.completed'],
    ['messages',{messages:[{role:'user',content:'hello'}],max_tokens:100},'message_stop'],
  ])for(const stream of [false,true]){
    const body={model:'mock',...request,stream,dsh_plugin_packages:{version:1,packages:[{name:'@deepseek-ai/dsh-example',version:'0.1.1-rc.2'}]}};
    const response=await fetch(base+'/'+route,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,200);
    if(stream){const events=[];for await(const event of sseEvents(response.body))events.push(event);assert.match(JSON.stringify(events),/fixture answer/);if(completion)assert.equal(events.at(-1).type,completion);else assert.equal(events.at(-1).choices[0].finish_reason,'stop');}
    else assert.match(JSON.stringify(await response.json()),/fixture answer/);
    assert.equal(Object.hasOwn(seen.at(-1).body,'dsh_plugin_packages'),false);assert.equal(new URL(seen.at(-1).url).pathname,'/v1/chat/completions');
  }
  assert.equal(seen.length,6);assert.equal(runtime.current.active,0);
  const unauthorized=await fetch(base+'/responses',{method:'POST',body:JSON.stringify({model:'mock',input:'hello',dsh_plugin_packages:{version:1,packages:[]}})});assert.equal(unauthorized.status,401);await unauthorized.text();assert.equal(seen.length,6);
}));

test('model discovery supports Anthropic keys, pagination and retrieval with the same enabled aliases',async()=>fixture(async({runtime})=>{
  runtime.Bridge=class extends Bridge{
    constructor(config){super(config);for(const id of ['second','third']){const model={model:'fixture/'+id,name:id,context:100000,output:1000};this.config.models[id]=model;this.acceptedModels[id]=model;this.acceptedModels[model.model]=model;}}
  };
  await runtime.refresh();await runtime.updateModel('fixture/mock',{alias:'friendly'});await runtime.updateModel('fixture/third',{enabled:false});
  let inferred=0;runtime.current.bridge.fetch=async()=>{inferred++;throw new Error('Discovery must not infer.');};
  await runtime.startGateway();const base=runtime.state().endpoint;
  const native={'x-api-key':'fixture-access-key','anthropic-version':'2023-06-01'},bearer={authorization:'Bearer fixture-access-key'};
  const get=async(suffix,headers=native)=>{const response=await fetch(base+suffix,{headers});assert.equal(response.status,200,await(response.status===200?Promise.resolve(''):response.text()));assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('vary'),/anthropic-version/);return response.json();};
  const all=await get('/models');assert.deepEqual(all.data.map(m=>m.id),['friendly','second']);assert.equal(all.has_more,false);assert.equal(all.first_id,'friendly');assert.equal(all.last_id,'second');assert.equal(all.data[0].type,'model');assert.equal(all.data[0].display_name,'模型');assert.equal(all.data[0].max_input_tokens,100000);assert.equal(all.data[0].max_tokens,1000);assert.equal(all.data[0].capabilities,null);assert.ok(!JSON.stringify(all).includes('fixture/'));
  const first=await get('/models?limit=1');assert.equal(first.has_more,true);assert.deepEqual(first.data.map(m=>m.id),['friendly']);
  const second=await get('/models?after_id=friendly&limit=1');assert.equal(second.has_more,false);assert.deepEqual(second.data.map(m=>m.id),['second']);
  assert.deepEqual((await get('/models?before_id=second&limit=1')).data,first.data);
  const empty=await get('/models?after_id=second');assert.deepEqual(empty,{data:[],has_more:false,first_id:null,last_id:null});
  assert.deepEqual(await get('/models/friendly'),all.data[0]);assert.deepEqual(await get('/models',{'x-api-key':'fixture-access-key'}),all);
  assert.deepEqual(await get('/models',{...bearer,'anthropic-version':'2023-06-01'}),all);
  const openai=await get('/models',bearer);assert.equal(openai.object,'list');assert.deepEqual(openai.data.map(m=>m.id),['friendly','second']);assert.equal(openai.data[0].object,'model');assert.equal((await get('/models/friendly',bearer)).object,'model');
  for(const suffix of ['/models?limit=0','/models?limit=1001','/models?limit=1.5','/models?limit=1&limit=2','/models?after_id=missing','/models?before_id=friendly&after_id=second']){
    const response=await fetch(base+suffix,{headers:native});assert.equal(response.status,400);assert.equal((await response.json()).error.type,'invalid_request_error');
  }
  for(const id of ['missing','third','mock','fixture%2Fmock']){const response=await fetch(base+'/models/'+id,{headers:native});assert.equal(response.status,404);assert.equal((await response.json()).error.type,'not_found_error');}
  for(const headers of [native,bearer]){const response=await fetch(base+'/messages/count_tokens',{method:'POST',headers,body:JSON.stringify({model:'friendly',messages:[{role:'user',content:'hello'}]})});assert.equal(response.status,501);const error=await response.json();assert.equal(error.type,'error');assert.match(error.error.message,/no token-count endpoint/);}
  assert.equal(inferred,0);assert.equal(runtime.current.active,0);
  await runtime.updateModel(['fixture/mock','fixture/second'],{enabled:false});const disabled=await get('/models');assert.deepEqual(disabled,{data:[],has_more:false,first_id:null,last_id:null});assert.deepEqual((await get('/models',bearer)).data,[]);
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
  assert.deepEqual(withModelDefaults({thinking:{type:'disabled'}},{defaults:{reasoning_effort:'high',temperature:0.2}}),{thinking:{type:'disabled'},temperature:0.2});
  assert.deepEqual(withModelDefaults({thinking:{type:'enabled'}},{defaults:{reasoning_effort:'none',temperature:0.2}}),{thinking:{type:'enabled'},temperature:0.2});
  assert.equal(withModelDefaults({thinking:{type:'enabled'}},{defaults:{reasoning_effort:'low'}}).reasoning_effort,'low');
  assert.equal(withModelDefaults({thinking:{type:'enabled'},reasoning_effort:'low'},{defaults:{reasoning_effort:'high'}}).reasoning_effort,'low');
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
