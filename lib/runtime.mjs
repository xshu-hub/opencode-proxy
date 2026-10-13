import path from 'node:path';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {OpenCodeBridge,normalizeConfig} from './bridge.mjs';
import {ApiError} from './protocol.mjs';
import {validateSettings,applyModelOverrides,withModelDefaults,atomicJSON,checkDirectory} from './settings.mjs';
import {Telemetry} from './telemetry.mjs';
import {createProxyServer} from './http-server.mjs';
import {RequestStore} from './request-store.mjs';
import {protocolFor,toChatRequest,adaptResponse,observation,protocolError} from './outward-protocols.mjs';

export class ProxyRuntime{
  constructor({file,settings,Bridge=OpenCodeBridge}){this.file=file;this.settings=settings;this.Bridge=Bridge;this.telemetry=new Telemetry(path.join(path.dirname(file),'statistics.json'));this.requests=new RequestStore(path.join(path.dirname(file),'requests'));this.generations=new Set();this.current=this.generation(settings);this.changes=Promise.resolve();}
  generation(settings){
    const config=normalizeConfig(settings,path.dirname(this.file));
    if(process.env.OPENCODE_PROXY_RESOURCES)config.workerPluginPath=path.join(process.env.OPENCODE_PROXY_RESOURCES,'worker-plugin.mjs');
    config.onDiagnostics=report=>this.telemetry.report(report);
    const generation={bridge:new this.Bridge(config),settings:structuredClone(settings),active:0};this.generations.add(generation);return generation;
  }
  async initialize(){await this.telemetry.load();}
  authenticate(req){const supplied=Buffer.from(req.headers.authorization??(protocolFor((req.url??'').split('?')[0])==='anthropic'&&typeof req.headers['x-api-key']==='string'?'Bearer '+req.headers['x-api-key']:''));for(const key of this.settings.apiKeys){if(!key.enabled)continue;const expected=Buffer.from('Bearer '+key.key);if(supplied.length===expected.length&&timingSafeEqual(supplied,expected))return {id:key.id,name:key.name};}return false;}
  async catalog(generation=this.current){
    generation.catalog??=(async()=>{await generation.bridge.loadModels();const catalog=applyModelOverrides(generation.bridge,generation.settings.modelOverrides??{});if(generation.bridge.config.discoverModels&&!generation.settings.models&&Object.keys(catalog).length>1&&!catalog['oc-default']?.model){delete catalog['oc-default'];delete generation.bridge.acceptedModels['oc-default'];}generation.bridge.config.models=Object.fromEntries(Object.entries(catalog).filter(([,model])=>model.enabled!==false));return catalog;})().catch(e=>{generation.catalog=undefined;throw e;});
    return generation.catalog;
  }
  async models(){const models=await this.catalog();return Object.entries(models).map(([id,model])=>({id,target:model.model??id,name:model.name??id,enabled:model.enabled!==false,context:model.context,output:model.output,nativeContext:model.nativeContext??model.context,nativeOutput:model.nativeOutput??model.output,temperature:model.temperature!==false,toolcall:model.toolcall!==false,reasoning:model.reasoning===true,reasoningEfforts:model.reasoningEfforts??[],nativeReasoningEffort:model.nativeReasoningEffort,defaults:model.defaults??{}}));}
  async release(g){g.active--;if(g.retired&&g.active===0){await g.bridge.close();this.generations.delete(g);}}
  async fetch(url,init={},_unused,client={name:'管理页面'}){
    const generation=this.current;generation.active++;
    const endpoint=new URL(url).pathname.replace(/\/$/,''),protocol=protocolFor(endpoint);
    let row,done=false,requestId=randomUUID(),clientBody;
    const finish=async(details={})=>{if(done)return;done=true;if(row){await this.requests.finish(requestId).catch(()=>{row.detailsError='request_log_write_failed';});const expired=this.telemetry.finish(requestId,details);for(const id of expired??[])await this.requests.remove(id).catch(()=>{});}await this.release(generation);};
    try{
      if(protocol&&init.method==='POST'){
        let body;try{body=JSON.parse(init.body);}catch{throw new ApiError('Malformed JSON request.',400);}
        if(!body||typeof body!=='object'||Array.isArray(body))throw new ApiError('Request must be a JSON object.',400);
        clientBody=body;
        row={id:requestId,protocol,endpoint,startedAt:new Date().toISOString(),startedMs:Date.now(),model:typeof body.model==='string'?body.model.slice(0,128):'未知模型',client:client?.name??'客户端',stream:body.stream===true,status:'running',flowMarks:[],flowBytes:0};
        this.telemetry.begin(row);
        await this.requests.start(requestId,{method:init.method,endpoint,headers:init.headers,requestedBody:body}).then(()=>{row.detailsAvailable=true;},()=>{row.detailsError='request_log_write_failed';});
        init.signal?.addEventListener('abort',()=>{row.cancelled=true;},{once:true});
        body=toChatRequest(protocol,body);
        await this.catalog(generation);
        const model=generation.bridge.acceptedModels[body.model];
        row.target=model?.model;
        if(model?.enabled===false)throw new ApiError('该模型已停用，请在模型页面重新启用。',403,'model','model_disabled');
        body=withModelDefaults(body,model);
        if(row.detailsAvailable)await this.requests.effective(requestId,body).catch(()=>{row.detailsError='request_log_write_failed';});
        init={...init,requestId,body:JSON.stringify(body)};
        url=new URL('/v1/chat/completions',url).href;
      }else await this.catalog(generation);
      const response=await adaptResponse(clientBody?protocol:undefined,await generation.bridge.fetch(url,init),clientBody);
      if(row)row.httpStatus=response.status;
      if(row?.detailsAvailable)await this.requests.openResponse(requestId,response.headers).catch(()=>{row.detailsError='request_log_write_failed';});
      if(!response.body){await finish({httpStatus:response.status});return response;}
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',errorCode;
      const streaming=response.headers.get('content-type')?.includes('text/event-stream');
      const observe=(data,size=0)=>{
        if(!row)return;
        data=observation(protocol,data);
        if(data.error){errorCode=typeof data.error.code==='string'?data.error.code:'upstream_error';return;}
        if(data.usage)row.usage=data.usage;
        const choice=data.choices?.[0],delta=choice?.delta??choice?.message;
        const content=delta?.content||delta?.reasoning_content||delta?.tool_calls?.length;
        const at=Math.max(1,Date.now()-row.startedMs);
        if(streaming&&row.clientFirstMs===undefined&&content)row.clientFirstMs=at;
        if(streaming&&row.firstTextMs===undefined&&delta?.content)row.firstTextMs=at;
        if(streaming&&(content||row.firstTextMs!==undefined&&choice?.delta)&&row.flowMarks.length<65536){row.flowBytes+=size;const mark=row.flowMarks.at(-1);if(mark?.at===at)mark.sum=row.flowBytes;else row.flowMarks.push({at,sum:row.flowBytes});}
        if(choice?.finish_reason){row.outputEndMs=Date.now()-row.startedMs;row.finishReason=choice.finish_reason;}
      };
      const consume=(chunk,last=false)=>{
        if(!row)return;
        buffer+=decoder.decode(chunk,{stream:!last});
        if(buffer.length>16*1024*1024){buffer='';return;}
        if(streaming){let match;while((match=/\r?\n\r?\n/.exec(buffer))){const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data&&data!=='[DONE]')try{observe(JSON.parse(data),Buffer.byteLength(frame));}catch{}}}
        else if(last)try{observe(JSON.parse(buffer));}catch{}
      };
      const body=new ReadableStream({
        pull:async controller=>{try{const next=await reader.read();if(next.done){consume(new Uint8Array(),true);await finish({httpStatus:response.status,errorCode});controller.close();}else{consume(next.value);if(row?.detailsAvailable)await this.requests.append(requestId,next.value).catch(()=>{row.detailsError='request_log_write_failed';});controller.enqueue(next.value);}}catch(e){await finish({httpStatus:row?.cancelled?499:502,errorCode:row?.cancelled?'request_cancelled':'stream_error'});controller.error(e);}},
        async cancel(reason){if(row)row.cancelled=true;try{await reader.cancel(reason);}finally{await finish({httpStatus:499,errorCode:'request_cancelled'});}},
      });
      return new Response(body,{status:response.status,headers:response.headers});
    }catch(error){await finish({httpStatus:init.signal?.aborted?499:error.status??502,errorCode:init.signal?.aborted?'request_cancelled':error.code??'request_failed'});if(error instanceof ApiError)return Response.json(protocolError(protocol,error.body(),error.status,requestId),{status:error.status});return Response.json(protocolError(protocol,new ApiError('OpenCode 服务不可用，请检查程序路径和全局配置。',502,null,'opencode_unavailable').body(),502,requestId),{status:502});}
  }
  state(){return {settings:this.settings,configFile:this.file,running:!!this.gateway?.listening,endpoint:this.gateway?.listening?'http://'+(this.settings.host==='0.0.0.0'?'127.0.0.1':this.settings.host)+':'+this.gateway.address().port+'/v1':undefined,startError:this.startError,statistics:this.telemetry.snapshot()};}
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
    if(!targets.length||targets.length>10000||targets.some(t=>typeof t!=='string')||!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['enabled','alias','context','output','defaults'].includes(k))||(targets.length>1&&Object.keys(patch).some(k=>k!=='enabled')))throw new ApiError('模型配置无效。',400);
    // Read the latest settings when the operation actually executes: two quick
    // model switches must not overwrite each other or other saved settings.
    return this.save((settings,catalog)=>{const input=structuredClone(settings);for(const target of targets){if(!catalog.some(m=>m.target===target))throw new ApiError('模型不在全局 OpenCode 列表中。',404,'model','model_not_found');const previous=input.modelOverrides[target]??{},next={...previous,...patch};for(const key of ['alias','context','output'])if(next[key]===null)delete next[key];if(patch.defaults!==undefined){if(!patch.defaults||typeof patch.defaults!=='object'||Array.isArray(patch.defaults))throw new ApiError('默认参数必须是对象。',400);next.defaults={...previous.defaults,...patch.defaults};for(const key of Object.keys(next.defaults))if(next.defaults[key]===null)delete next.defaults[key];}input.modelOverrides[target]=next;}return input;});
  }
  async refresh(){const operation=this.changes.then(async()=>{const next=this.generation(this.settings);try{await this.catalog(next);}catch(e){await next.bridge.close();this.generations.delete(next);throw e;}const old=this.current;this.current=next;old.retired=true;if(old.active===0){await old.bridge.close();this.generations.delete(old);}return this.models();});this.changes=operation.catch(()=>{});return operation;}
  async close(){await this.changes;await this.stopGateway();await Promise.allSettled([...this.generations].map(g=>g.bridge.close()));for(const id of this.telemetry.active.keys())this.telemetry.finish(id,{httpStatus:499,errorCode:'request_cancelled'});await this.requests.close();await this.telemetry.close();}
}
