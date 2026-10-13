import path from 'node:path';
import os from 'node:os';
import {mkdir,readFile,writeFile,rename,stat,rm} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {normalizeConfig} from './bridge.mjs';
import {ApiError,REASONING_EFFORTS} from './protocol.mjs';
import {validateReasoningVariants} from './reasoning.mjs';

export const defaultConfigFile=()=>path.join(process.platform==='win32'?(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData','Local')):(process.env.XDG_CONFIG_HOME??path.join(os.homedir(),'.config')),'OpenCodeProxy','config.json');
export const newKey=()=> 'ocp_'+randomBytes(24).toString('hex');
export async function atomicJSON(file,value){
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,file);}
  finally{await rm(temp,{force:true});}
}
const fail=message=>{throw new ApiError(message,400,null,'invalid_configuration');};
export function validateSettings(input,directory){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('配置必须是对象。');
  const allowed=new Set(['mode','command','workingDirectory','host','port','apiKeys','modelOverrides','modelIdStyle','timeoutMs','startupTimeoutMs','firstOutputTimeoutMs','idleTimeoutMs','workerReuse','maxIdleWorkers','workerIdleMs','diagnostics','discoverModels','maxConcurrent','warmupModels','models']);
  for(const name of Object.keys(input))if(!allowed.has(name))fail('未知配置字段：'+name);
  if(input.mode!==undefined&&input.mode!=='global')fail('桌面管理使用全局 OpenCode 模式。');
  const value={mode:'global',host:'127.0.0.1',port:8787,maxConcurrent:0,timeoutMs:0,modelOverrides:{},...structuredClone(input)};
  if(value.workingDirectory==='')delete value.workingDirectory;
  const core=normalizeConfig(value,directory);
  if(typeof value.host!=='string'||!value.host||!Number.isInteger(value.port)||value.port<0||value.port>65535)fail('监听地址或端口无效。');
  if(!Array.isArray(value.apiKeys)||!value.apiKeys.length||value.apiKeys.length>50)fail('请至少保留一个访问 Key。');
  const ids=new Set(),keys=new Set();
  for(const key of value.apiKeys){
    if(!key||typeof key.id!=='string'||!key.id||ids.has(key.id)||typeof key.name!=='string'||!key.name.trim()||key.name.length>80||typeof key.key!=='string'||key.key.length<8||key.key.length>256||/[\r\n]/.test(key.key)||keys.has(key.key)||typeof key.enabled!=='boolean')fail('访问 Key 的名称、值或 ID 无效/重复。');
    ids.add(key.id);keys.add(key.key);
  }
  if(!value.apiKeys.some(k=>k.enabled))fail('请至少启用一个访问 Key。');
  if(!value.modelOverrides||Array.isArray(value.modelOverrides)||typeof value.modelOverrides!=='object')fail('模型配置无效。');
  const aliases=new Set();
  for(const [id,model] of Object.entries(value.modelOverrides)){
    if(!id||!model||typeof model!=='object'||Array.isArray(model))fail('模型配置无效。');
    for(const k of Object.keys(model))if(!['alias','enabled','context','output','defaults','reasoningVariants'].includes(k))fail('未知模型配置字段：'+k);
    if(model.reasoningVariants!==undefined)validateReasoningVariants(model.reasoningVariants);
    if(model.enabled!==undefined&&typeof model.enabled!=='boolean')fail('模型启用状态必须是布尔值。');
    if(model.alias!==undefined){if(typeof model.alias!=='string'||!model.alias.trim()||model.alias.length>128||aliases.has(model.alias))fail('模型别名无效或重复。');aliases.add(model.alias);}
    for(const k of ['context','output'])if(model[k]!==undefined&&(!Number.isSafeInteger(model[k])||model[k]<=0))fail('模型上限必须是正整数。');
    const d=model.defaults??{};
    if(!d||typeof d!=='object'||Array.isArray(d))fail('模型默认参数无效。');
    for(const k of Object.keys(d))if(!['temperature','top_p','max_tokens','reasoning_effort'].includes(k))fail('未知模型默认参数：'+k);
    if(d.temperature!==undefined&&(typeof d.temperature!=='number'||!Number.isFinite(d.temperature)||d.temperature<0||d.temperature>2))fail('temperature 应在 0–2。');
    if(d.top_p!==undefined&&(typeof d.top_p!=='number'||!Number.isFinite(d.top_p)||d.top_p<0||d.top_p>1))fail('top_p 应在 0–1。');
    if(d.max_tokens!==undefined&&(!Number.isSafeInteger(d.max_tokens)||d.max_tokens<=0))fail('max_tokens 必须为正整数。');
    if(d.reasoning_effort!==undefined&&!REASONING_EFFORTS.includes(d.reasoning_effort))fail('思考强度无效。');
  }
  for(const key of ['command','modelIdStyle','startupTimeoutMs','firstOutputTimeoutMs','idleTimeoutMs','timeoutMs','maxConcurrent','workerReuse','maxIdleWorkers','workerIdleMs','diagnostics','discoverModels','warmupModels'])value[key]=core[key];
  if(core.workingDirectory)value.workingDirectory=core.workingDirectory;
  return {settings:value,core};
}
export async function readSettings(file,overrides={}){
  let value;
  try{value=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));}
  catch(error){if(error.code!=='ENOENT')throw error;value={mode:'global'};}
  value.apiKeys??=[{id:randomUUID(),name:'默认客户端',key:process.env.OPENCODE_PROXY_API_KEY??process.env.BRIDGE_API_KEY??newKey(),enabled:true}];
  const result=validateSettings({...value,...overrides},path.dirname(file));
  await atomicJSON(file,result.settings);
  return result.settings;
}
export async function checkDirectory(settings,directory){
  if(!settings.workingDirectory)return;
  const full=path.resolve(directory,settings.workingDirectory);
  const info=await stat(full).catch(()=>fail('工作目录不存在：'+full));
  if(!info.isDirectory())fail('工作目录必须是文件夹。');
}
export function applyModelOverrides(bridge,overrides){
  const visible={...bridge.config.models},accepted={...bridge.acceptedModels};
  for(const [target,override] of Object.entries(overrides)){
    const original=accepted[target]??Object.values(accepted).find(m=>m.model===target);
    if(!original)throw new ApiError('模型已不在 OpenCode 列表中：'+target,400,'model','model_not_found');
    const name=Object.keys(visible).find(k=>visible[k].model===original.model)??target;
    const alias=override.alias??name;
    if(visible[alias]&&visible[alias].model!==original.model)throw new ApiError('别名与另一个模型冲突：'+alias,400,'model','duplicate_alias');
    const model={...original,...override,nativeContext:original.context,nativeOutput:original.output};
    model.nativeReasoningEfforts=original.reasoningEfforts??[];
    model.reasoningEfforts=REASONING_EFFORTS.filter(e=>(original.reasoningEfforts??[]).includes(e)||Object.hasOwn(override.reasoningVariants??{},e));
    model.reasoning=original.reasoning===true||model.reasoningEfforts.length>0;
    for(const k of ['context','output'])if(override[k]!==undefined&&override[k]>original[k])throw new ApiError('配置上限不能超过 OpenCode 报告的 '+k+'：'+original[k],400,k,'model_limit');
    if(model.defaults?.max_tokens>model.output)throw new ApiError('默认 max_tokens 超过该模型的输出上限。',400,'max_tokens','model_limit');
    if(model.defaults?.reasoning_effort!==undefined&&!model.reasoningEfforts.includes(model.defaults.reasoning_effort))throw new ApiError('该模型未提供思考强度 '+model.defaults.reasoning_effort+'；请配置自定义映射，或选择：'+(model.reasoningEfforts.join(', ')||'无')+'。',400,'reasoning_effort','unsupported_reasoning_effort');
    for(const [id,entry] of Object.entries(accepted))if(entry===original||(original.model&&entry.model===original.model))accepted[id]=model;
    if(alias!==name){delete visible[name];if(name!==original.model)delete accepted[name];}
    visible[alias]=model;accepted[alias]=model;
  }
  bridge.config.models=Object.fromEntries(Object.entries(visible).filter(([,model])=>model.enabled!==false));bridge.acceptedModels={...accepted,...visible};
  return visible;
}
export function withModelDefaults(body,model){
  const defaults={...(model?.defaults??{})};
  if(body.max_completion_tokens!==undefined||body.max_tokens!==undefined)delete defaults.max_tokens;
  return {...defaults,...body};
}
