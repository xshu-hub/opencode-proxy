import path from 'node:path';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {OpenCodeBridge,normalizeConfig} from './bridge.mjs';
import {ApiError} from './protocol.mjs';
import {validateSettings,applyModelOverrides,withModelDefaults,atomicJSON,checkDirectory} from './settings.mjs';
import {createProxyServer} from './http-server.mjs';
import {protocolFor,toChatRequest,adaptResponse,protocolError} from './outward-protocols.mjs';

export class ProxyRuntime{
  constructor({file,settings,Bridge=OpenCodeBridge}){this.file=file;this.settings=settings;this.Bridge=Bridge;this.generations=new Set();this.current=this.generation(settings);this.changes=Promise.resolve();}
  generation(settings){
    const config=normalizeConfig(settings,path.dirname(this.file));
    if(process.env.OPENCODE_PROXY_RESOURCES)config.workerPluginPath=path.join(process.env.OPENCODE_PROXY_RESOURCES,'worker-plugin.mjs');
    const generation={bridge:new this.Bridge(config),settings:structuredClone(settings),active:0};this.generations.add(generation);return generation;
  }
  async initialize(){}
  authenticate(req){const supplied=Buffer.from(req.headers.authorization??(protocolFor((req.url??'').split('?')[0])==='anthropic'&&typeof req.headers['x-api-key']==='string'?'Bearer '+req.headers['x-api-key']:''));for(const key of this.settings.apiKeys){if(!key.enabled)continue;const expected=Buffer.from('Bearer '+key.key);if(supplied.length===expected.length&&timingSafeEqual(supplied,expected))return {id:key.id,name:key.name};}return false;}
  async catalog(generation=this.current){
    generation.catalog??=(async()=>{await generation.bridge.loadModels();const catalog=applyModelOverrides(generation.bridge,generation.settings.modelOverrides??{});if(generation.bridge.config.discoverModels&&!generation.settings.models&&Object.keys(catalog).length>1&&!catalog['oc-default']?.model){delete catalog['oc-default'];delete generation.bridge.acceptedModels['oc-default'];}generation.bridge.config.models=Object.fromEntries(Object.entries(catalog).filter(([,model])=>model.enabled!==false));return catalog;})().catch(e=>{generation.catalog=undefined;throw e;});
    return generation.catalog;
  }
  async models(){const models=await this.catalog();return Object.entries(models).map(([id,model])=>({id,target:model.model??id,name:model.name??id,enabled:model.enabled!==false,context:model.context,output:model.output,nativeContext:model.nativeContext??model.context,nativeOutput:model.nativeOutput??model.output,temperature:model.temperature!==false,toolcall:model.toolcall!==false,reasoning:model.reasoning===true,reasoningEfforts:model.reasoningEfforts??[],reasoningAdapter:model.reasoningAdapter??'native',nativeReasoningEffort:model.nativeReasoningEffort,nativeReasoningEfforts:model.nativeReasoningEfforts??model.reasoningEfforts??[],customReasoningEfforts:Object.keys(model.reasoningVariants??{}),defaults:model.defaults??{}}));}
  async release(g){g.active--;if(g.retired&&g.active===0){await g.bridge.close();this.generations.delete(g);}}
  async fetch(url,init={}){
    const generation=this.current;generation.active++;
    const protocol=protocolFor(new URL(url).pathname.replace(/\/$/,'')),requestId=randomUUID();
    let done=false,clientBody;
    const finish=async()=>{if(done)return;done=true;await this.release(generation);};
    try{
      if(protocol&&init.method==='POST'){
        let body;try{body=JSON.parse(init.body);}catch{throw new ApiError('Malformed JSON request.',400);}
        if(!body||typeof body!=='object'||Array.isArray(body))throw new ApiError('Request must be a JSON object.',400);
        clientBody=body;body=toChatRequest(protocol,body);await this.catalog(generation);
        const model=generation.bridge.acceptedModels[body.model];
        if(model?.enabled===false)throw new ApiError('该模型已停用，请在模型页面重新启用。',403,'model','model_disabled');
        body=withModelDefaults(body,model);init={...init,requestId,body:JSON.stringify(body)};
        url=new URL('/v1/chat/completions',url).href;
      }else await this.catalog(generation);
      const response=await adaptResponse(clientBody?protocol:undefined,await generation.bridge.fetch(url,init),clientBody);
      if(!response.body){await finish();return response;}
      // Forward bytes immediately; keep generation ownership until EOF or cancellation.
      // No SSE reparsing, statistics, request copies, or per-chunk disk writes.
      const reader=response.body.getReader();
      const body=new ReadableStream({
        pull:async controller=>{try{const next=await reader.read();if(next.done){await finish();controller.close();}else controller.enqueue(next.value);}catch(e){await finish();controller.error(e);}},
        async cancel(reason){try{await reader.cancel(reason);}finally{await finish();}},
      });
      return new Response(body,{status:response.status,headers:response.headers});
    }catch(error){await finish();if(error instanceof ApiError)return Response.json(protocolError(protocol,error.body(),error.status,requestId),{status:error.status});return Response.json(protocolError(protocol,new ApiError('OpenCode 服务不可用，请检查程序路径和全局配置。',502,null,'opencode_unavailable').body(),502,requestId),{status:502});}
  }
  state(){return {settings:this.settings,configFile:this.file,running:!!this.gateway?.listening,endpoint:this.gateway?.listening?'http://'+(this.settings.host==='0.0.0.0'?'127.0.0.1':this.settings.host)+':'+this.gateway.address().port+'/v1':undefined,startError:this.startError};}
  async startGateway(){if(this.gateway?.listening)return;this.startError=undefined;const gateway=createProxyServer({bridge:{fetch:(...args)=>this.fetch(...args),close:async()=>{}},authenticate:req=>this.authenticate(req)});try{await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(this.settings.port,this.settings.host,resolve);});this.gateway=gateway;}catch(error){this.startError=error.code??'listen_failed';await gateway.shutdown();throw error;}}
  async stopGateway(){const server=this.gateway;this.gateway=undefined;if(server)await server.shutdown();}
  async save(input){const operation=this.changes.then(async()=>{
    if(typeof input==='function')input=input(this.settings,await this.models());
    const {settings}=validateSettings(input,path.dirname(this.file));await checkDirectory(settings,path.dirname(this.file));
    const candidate=this.generation(settings);
    try{if(Object.keys(settings.modelOverrides??{}).length)await this.catalog(candidate);await atomicJSON(this.file,settings);}catch(e){await candidate.bridge.close();this.generations.delete(candidate);throw e;}
    const old=this.current,listenChanged=settings.host!==this.settings.host||settings.port!==this.settings.port,wasRunning=!!this.gateway?.listening;
    this.settings=settings;this.current=candidate;old.retired=true;if(old.active===0){await old.bridge.close();this.generations.delete(old);}
    if(listenChanged&&wasRunning){await this.stopGateway();try{await this.startGateway();}catch{/* UI remains reachable to correct the address. */}}
    return this.state();
  });this.changes=operation.catch(()=>{});return operation;}
  async updateModel(target,patch){
    const targets=Array.isArray(target)?target:[target];
    if(!targets.length||targets.length>10000||targets.some(t=>typeof t!=='string')||!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['enabled','alias','context','output','defaults','reasoningVariants','reasoningPreset'].includes(k))||(targets.length>1&&Object.keys(patch).some(k=>k!=='enabled')))throw new ApiError('模型配置无效。',400);
    // Read the latest settings when the operation actually executes: two quick
    // model switches must not overwrite each other or other saved settings.
    return this.save((settings,catalog)=>{const input=structuredClone(settings);for(const target of targets){if(!catalog.some(m=>m.target===target))throw new ApiError('模型不在全局 OpenCode 列表中。',404,'model','model_not_found');const previous=input.modelOverrides[target]??{},next={...previous,...patch};for(const key of ['alias','context','output','reasoningVariants','reasoningPreset'])if(next[key]===null)delete next[key];if(patch.defaults!==undefined){if(!patch.defaults||typeof patch.defaults!=='object'||Array.isArray(patch.defaults))throw new ApiError('默认参数必须是对象。',400);next.defaults={...previous.defaults,...patch.defaults};for(const key of Object.keys(next.defaults))if(next.defaults[key]===null)delete next.defaults[key];}input.modelOverrides[target]=next;}return input;});
  }
  async refresh(){const operation=this.changes.then(async()=>{const next=this.generation(this.settings);try{await this.catalog(next);}catch(e){await next.bridge.close();this.generations.delete(next);throw e;}const old=this.current;this.current=next;old.retired=true;if(old.active===0){await old.bridge.close();this.generations.delete(old);}return this.models();});this.changes=operation.catch(()=>{});return operation;}
  async updateModels(updates){
    if(!Array.isArray(updates)||!updates.length||updates.length>10000)throw new ApiError('模型配置无效。',400);
    return this.save((settings,catalog)=>{
      const input=structuredClone(settings),seen=new Set();
      for(const item of updates){
        if(!item||typeof item!=='object'||Array.isArray(item))throw new ApiError('模型配置无效。',400);
        const {target,patch}=item;
        if(typeof target!=='string'||seen.has(target)||!catalog.some(m=>m.target===target)||!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['enabled','alias','context','output','defaults','reasoningVariants','reasoningPreset'].includes(k)))throw new ApiError('模型配置无效或模型不存在。',400);
        seen.add(target);const previous=input.modelOverrides[target]??{},next={...previous,...patch};
        for(const k of ['alias','context','output','reasoningVariants','reasoningPreset'])if(next[k]===null)delete next[k];
        if(patch.defaults!==undefined){if(!patch.defaults||typeof patch.defaults!=='object'||Array.isArray(patch.defaults))throw new ApiError('模型默认参数无效。',400);next.defaults={...previous.defaults,...patch.defaults};for(const k of Object.keys(next.defaults))if(next.defaults[k]===null)delete next.defaults[k];}
        input.modelOverrides[target]=next;
      }
      return input;
    });
  }
  async close(){await this.changes;await this.stopGateway();await Promise.allSettled([...this.generations].map(g=>g.bridge.close()));}
}
