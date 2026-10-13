/* OpenCode backend adaptation for the real Magpie frontend. MIT.
 * Original page renderers remain in app.js/caller-keys.js. No Magpie server,
 * credentials, or provider HTTP calls are used by this adapter. */
let proxyState=null,proxyModels=[],proxyReading=0;
const magpieLoadProviders=loadProviders;
const proxyDetails=new Map();
const proxyDesktop=()=>window.go?.main?.Desktop;
async function proxyRequest(route,body){
  const method=body===undefined?'GET':'POST';let code,data;
  if(proxyDesktop()){const out=JSON.parse(await proxyDesktop().Request(method,route,body===undefined?'':JSON.stringify(body)));code=out.status;data=out.data;}
  else{const r=await fetch(route,{method,headers:{authorization:'Bearer '+document.querySelector('meta[name=admin-token]').content,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});code=r.status;data=await r.json();}
  if(code>=400)throw Error(data.error?.message||'操作失败（'+code+'）');return data;
}
async function proxyRead(models=false){const n=++proxyReading;const result=await Promise.all([proxyRequest('/admin/state'),models?proxyRequest('/admin/models'):Promise.resolve(null)]);if(n===proxyReading||!proxyState)proxyState=result[0];if(result[1])proxyModels=result[1].models;providers=proxyProviders();state={agents:[],profiles:[],settings:proxyPrefs()};}
function proxyPrefs(){return{theme:localStorage.getItem('opencode-proxy.theme')||'system',lang:'zh',textSize:Number(localStorage.getItem('opencode-proxy.size')||100),plainNames:'plain',currency:'usd',dir:proxyState?.configFile,version:'0.6.0',web:true};}
window.purposeOptions=()=>[];
function proxyKeys(){return{keys:(proxyState?.settings.apiKeys||[]).map(k=>({id:k.id,name:k.name,off:!k.enabled,masked:k.key.slice(0,5)+'…'+k.key.slice(-4)}))};}
function proxyCall(r){return{...r,time:r.startedAt,agent:r.client,model:r.model,from:r.protocol,to:r.protocol,status:r.httpStatus??0,error:r.errorCode,ms:r.elapsedMs,ttft:r.ttftMs,...proxyDetails.get(r.id)};}
function proxyProviders(){
  const groups=new Map();
  for(const m of proxyModels){const id=m.target.split('/')[0];if(!groups.has(id))groups.set(id,{id,name:id,host:'全局 OpenCode',icon:'opencode',openCode:true,key:{set:false},ready:true,agents:[],models:[],fallback:[],headers:{},picked:[],api:'openai',unlisted:false});const p=groups.get(id);p.models.push({id:m.id,name:m.id,default:m.target.split('/').slice(1).join('/'),on:m.enabled,context:m.context,output:m.output,efforts:m.reasoningEfforts,raw:m});if(m.enabled)p.picked.push(m.id);}
  const ps=[...groups.values()];for(const p of ps)p.off=!p.models.some(m=>m.on);
  const s=proxyState;return{providers:ps,presets:[],gateway:{running:!!s?.running,mine:true,lan:true,url:s?.endpoint?.replace(/\/v1$/,'')||'http://127.0.0.1:'+(s?.settings.port||8787),models:proxyModels.filter(m=>m.enabled).length,groups:[],calls:[...(s?.statistics.active||[]),...(s?.statistics.rows||[])].map(proxyCall)}};
}
function proxyTotal(b={}){return{calls:b.requests||0,errors:b.failed||0,input:b.inputTokens||0,output:b.outputTokens||0,cache_read:b.cachedTokens||0,cache_write:b.cacheWriteTokens||0,reasoning:b.reasoningTokens||0,timed:b.ttftSamples||0,ttft_ms:b.ttftSum||0,decode_ms:b.generationMs||0,decode_out:b.generationTokens||0,unpriced:b.requests||0,cost:0};}
function proxySum(xs){const t=proxyTotal();for(const x of xs)for(const k of Object.keys(t))t[k]+=x[k]||0;return t;}
function proxyDate(d){return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
function proxyRows(q){const cut=new Date();cut.setHours(0,0,0,0);const p=q.get('period');if(p==='7d')cut.setDate(cut.getDate()-6);if(p==='30d')cut.setDate(cut.getDate()-29);return(proxyState.statistics.rows||[]).filter(r=>(p==='all'||new Date(r.startedAt)>=cut)&&(!q.get('day')||proxyDate(new Date(r.startedAt))===q.get('day'))&&(!q.get('failed')||r.httpStatus>=400)&&(!q.get('agent')||r.client===q.get('agent'))&&(!q.get('provider')||r.target?.split('/')[0]===q.get('provider'))&&(!q.get('model')||r.model===q.get('model'))&&(!q.get('q')||[r.model,r.target,r.client,r.id,r.protocol,r.errorCode].join(' ').toLowerCase().includes(q.get('q').toLowerCase())));}
function proxyRow(r){return{id:r.id,t:r.startedAt,agent:r.client,agentName:r.client,req:r.model,model:r.target?.split('/').slice(1).join('/')||r.model,effort:r.reasoningEffort,providerName:r.target?.split('/')[0]||'OpenCode',provider:r.target?.split('/')[0]||'OpenCode',ep:r.endpoint,status:r.httpStatus,err:r.errorCode||'',ms:r.elapsedMs,ttft_ms:r.ttftMs,first_text_ms:r.firstTextMs,flow_ms:r.flowMs,in:r.inputTokens||0,out:r.outputTokens||0,cache_read:r.cacheRead||0,cache_write:r.cacheWrite||0,reasoning:r.reasoningTokens||0,source:'gateway',session:r.id,priced:false};}
function proxyAggregateRows(rows){const total=proxyTotal();for(const r of rows){total.calls++;if(r.httpStatus>=400)total.errors++;total.input+=r.inputTokens||0;total.output+=r.outputTokens||0;total.cache_read+=r.cacheRead||0;total.cache_write+=r.cacheWrite||0;total.reasoning+=r.reasoningTokens||0;if(r.ttftMs&&r.status==='completed'){total.timed++;total.ttft_ms+=r.ttftMs;}total.decode_ms+=r.generationMs||0;total.decode_out+=r.generationTokens||0;total.unpriced++;}return total;}
function proxyGroups(rows,key){const map=new Map();for(const r of rows){const id=key(r)||'未知';if(!map.has(id))map.set(id,[]);map.get(id).push(r);}return[...map].map(([id,rs])=>({id,name:id,...proxyAggregateRows(rs)}));}
function proxyModelAt(rs){return proxyGroups(rs,r=>(r.target?.split('/')[0]||'OpenCode')+'/'+r.model);}
const proxyBaseLedger=proxyLedger;
proxyLedger=function(q){const l=proxyBaseLedger(q);l.by.modelAt=proxyModelAt(proxyRows(q));for(const point of l.series){const rs=proxyRows(new URLSearchParams({...Object.fromEntries(q),day:point.time.slice(0,10)}));point.by.modelAt=Object.fromEntries(proxyModelAt(rs).map(x=>[x.id,x]));}return l;};
function proxyLedger(q){const rs=proxyRows(q),all=proxyState.statistics.rows,offset=Number(q.get('offset')||0),tot=proxyAggregateRows(rs),day=new Map();for(const r of rs){const id=proxyDate(new Date(r.startedAt));if(!day.has(id))day.set(id,[]);day.get(id).push(r);}return{...tot,total:rs.length,offset,rows:rs.slice(offset,offset+100).map(proxyRow),agents:[...new Set(all.map(r=>r.client))].map(id=>({id,name:id})),providers:[...new Set(all.map(r=>r.target?.split('/')[0]).filter(Boolean))].map(id=>({id,name:id})),accounts:[],callerKeys:[],purposes:[],computers:[],through:tot,direct:proxyTotal(),bucket:'day',day:q.get('day')||'',by:{model:proxyGroups(rs,r=>r.model),agent:proxyGroups(rs,r=>r.client),provider:proxyGroups(rs,r=>r.target?.split('/')[0])},series:[...day].sort(([a],[b])=>a.localeCompare(b)).map(([time,rs])=>({time:time+'T12:00:00',...proxyAggregateRows(rs),by:{model:Object.fromEntries(proxyGroups(rs,r=>r.model).map(g=>[g.id,g])),agent:Object.fromEntries(proxyGroups(rs,r=>r.client).map(g=>[g.id,g])),provider:Object.fromEntries(proxyGroups(rs,r=>r.target?.split('/')[0]).map(g=>[g.id,g]))}}))};}
function proxyUsage(q){const s=proxyState.statistics,p=q.get('period')||'today',from=new Date();from.setHours(0,0,0,0);if(p==='7d')from.setDate(from.getDate()-6);if(p==='30d')from.setDate(from.getDate()-29);const series=Object.entries(s.byDay).filter(([d])=>p==='all'||d>=proxyDate(from)).sort(([a],[b])=>a.localeCompare(b)).map(([d,b])=>({time:d+'T12:00:00',label:d,...proxyTotal(b)}));const total=p==='all'?proxyTotal(s.totals):proxySum(series);return{...total,series,bucket:'day',models:p==='all'?Object.entries(s.byModel).map(([id,b])=>({name:id,...proxyTotal(b)})):[],agents:[],accounts:[],callerKeys:[],path:'statistics.json（累计统计持久化；请求明细保留最近 250 条）'};}
api=async function(path,body){
  const [route,search='']=path.split('?'),q=new URLSearchParams(search);
  if(route==='open'){window.open(body.url,'_blank','noopener');return{};}
  if(route==='state'){await proxyRead();return state;}
  if(route==='providers'){if(!proxyState||!proxyModels.length)await proxyRead(true);else await proxyRead();return providers;}
  if(route==='sync'||route==='provider/models'){await proxyRequest('/admin/refresh',{});await proxyRead(true);return route==='sync'?state:{count:proxyModels.filter(m=>m.target.startsWith(body.id+'/')).length};}
  if(route==='provider/on'||route==='provider/off'){const targets=proxyModels.filter(m=>m.target.startsWith(body.id+'/')).map(m=>m.target);await proxyRequest('/admin/model',{targets,patch:{enabled:route.endsWith('/on')}});await proxyRead(true);return providers;}
  if(route==='provider/test'){const results=[];for(const id of body.test||[]){const now=performance.now();try{await proxyRequest('/admin/test',{model:id,prompt:'Reply with OK.',protocol:'chat'});results.push({model:id,ok:true,ms:performance.now()-now,protocol:'openai'});}catch(e){results.push({model:id,ok:false,error:e.message,protocol:'openai'});}}return{results};}
  if(route==='gateway/restart'){await proxyRequest('/admin/stop',{});await proxyRequest('/admin/start',{});await proxyRead();return{ok:true};}
  if(route==='caller-keys'){if(!proxyState)await proxyRead();return proxyKeys();}
  if(route.startsWith('caller-keys/')){
    await proxyRead();const keys=structuredClone(proxyState.settings.apiKeys),action=route.split('/')[1],key=keys.find(k=>k.id===body.key);
    if(action==='copy-key'){if(!key)throw Error('Key 已移除');return{secret:key.key};}
    if(action==='add-key'){const bytes=crypto.getRandomValues(new Uint8Array(24));keys.push({id:crypto.randomUUID(),name:body.name?.trim()||'新客户端',key:body.secret||'ocp_'+Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join(''),enabled:true});}
    else{if(!key)throw Error('Key 已移除');if(action==='rename-key')key.name=body.name;if(action==='on-key'||action==='off-key')key.enabled=action==='on-key';if(action==='remove-key')keys.splice(keys.indexOf(key),1);if(action==='rotate-key')key.key='ocp_'+Array.from(crypto.getRandomValues(new Uint8Array(24)),x=>x.toString(16).padStart(2,'0')).join('');}
    proxyState=await proxyRequest('/admin/config',{...proxyState.settings,apiKeys:keys});return proxyKeys();
  }
  if(route==='usage'){await proxyRead();return proxyUsage(q);}
  if(route==='usage/requests'){await proxyRead();return proxyLedger(q);}
  if(route==='usage/quotas')return[];
  if(route==='usage/quotas/history')return{};
  if(route==='usage/heatmap'){await proxyRead();const rs=proxyRows(new URLSearchParams({...Object.fromEntries(q),period:'all'}));const ds=proxyGroups(rs,r=>proxyDate(new Date(r.startedAt))).sort((a,b)=>a.id.localeCompare(b.id));return{from:ds[0]?.id,to:ds.at(-1)?.id,days:ds.map(d=>({...d,date:d.id,tokens:d.input+d.output+d.cache_read+d.cache_write}))};}
  if(route==='settings')return proxyPrefs();
  if(route==='window/quit'){if(proxyDesktop())await proxyDesktop().Quit();else await proxyRequest('/admin/shutdown',{});return{};}
  // These original background readers concern removed Magpie modules.
  if(['upstream','lanes','drift','plugins/updates'].includes(route))return route==='lanes'?[]:{};
  throw Error('此操作不适用于 OpenCode Proxy：'+route);
};
copy=async function(value,label,button){try{if(proxyDesktop())await proxyDesktop().CopyText(value);else await navigator.clipboard.writeText(value);status((label||'内容')+'已复制','ok');}catch(e){status(e.message,'err');}};
// Actual original provider list, modal, model chips, search, bulk selection,
// Names & levels, tests, keyboard and scroll-preserving renderers are retained.
drawEditor=function(p){
  draft=draft||{id:p.id,chosen:p.models.filter(m=>m.on).map(m=>m.id),typed:'',modelPrefs:{},proxyUpdates:{},extra:[],headers:[],api:'openai',unlisted:false};
  const ed=el('div','editor'),head=el('div','ehead');head.append(icon('opencode'),el('b','',p.name),el('span','grow'));const x=el('button','text',t('Cancel'));x.onclick=()=>cancelEdit();head.append(x);ed.append(head,el('p','proxy-note','读取全局 OpenCode 的供应商与凭证。选中的模型对外启用；在“名称与级别”中配置别名、思考强度和默认参数。'));
  const models=renderModels(p);ed.append(...field(t('Models'),models));
  const bar=el('div','bar'),err=el('span','hint err'),cancel=el('button','text',t('Cancel')),save=el('button','text primary',t('Save'));cancel.onclick=()=>cancelEdit();
  save.onclick=async()=>{save.disabled=true;err.textContent='';try{const updates=p.models.map(m=>{const staged=draft.modelPrefs?.[m.id]||{},patch={...(draft.proxyUpdates?.[m.raw.target]||{}),enabled:draft.chosen.includes(m.id)};if(Object.hasOwn(staged,'name'))patch.alias=staged.name||null;return{target:m.raw.target,patch};});await proxyRequest('/admin/models/batch',{updates});draft=null;editing=null;await proxyRead(true);renderProviders();status('模型配置已保存','ok');}catch(e){err.textContent=e.message;save.disabled=false;}};
  bar.append(err,el('span','grow'),cancel,save);ed.append(bar);return ed;
};
providerDirty=function(){
  if(!draft||typeof editing!=='string'||!proxyState)return false;
  const p=providers.providers.find(p=>p.id===editing);if(!p)return false;
  if([...draft.chosen].sort().join('\n')!==p.models.filter(m=>m.on).map(m=>m.id).sort().join('\n'))return true;
  for(const m of p.models){const pref=draft.modelPrefs?.[m.id];if(pref&&Object.hasOwn(pref,'name')&&(pref.name||m.default)!==m.id)return true;const patch=draft.proxyUpdates?.[m.raw.target];if(!patch)continue;const saved=proxyState.settings.modelOverrides[m.raw.target]||{};for(const [key,v] of Object.entries(patch)){if(key==='defaults'){for(const [k,value] of Object.entries(v))if((value??undefined)!==saved.defaults?.[k])return true;}else if(JSON.stringify(v??undefined)!==JSON.stringify(saved[key]))return true;}}
  return false;
};
function proxyModelParameters(m){
  const model=m.raw,override=proxyState.settings.modelOverrides[model.target]||{};draft.proxyUpdates??={};const patch=draft.proxyUpdates[model.target]??={};const defaults=patch.defaults??={...model.defaults};const box=el('div','proxy-params');
  const numeric=(title,key,saved,placeholder,commit)=>{const label=el('label','',title),i=input(saved??'',placeholder||'跟随 OpenCode');i.inputMode='decimal';i.setAttribute('aria-label',model.id+' '+title);i.oninput=()=>{const text=i.value.trim(),n=Number(text);commit(text===''?null:Number.isFinite(n)?n:text);};label.append(i);box.append(label);return i;};
  numeric('上下文上限','context',patch.context??override.context,model.nativeContext?String(model.nativeContext):'',v=>patch.context=v);
  numeric('输出上限','output',patch.output??override.output,model.nativeOutput?String(model.nativeOutput):'',v=>patch.output=v);
  if(model.temperature)numeric('Temperature','temperature',defaults.temperature,'供应商默认',v=>defaults.temperature=v);
  numeric('Top P','top_p',defaults.top_p,'供应商默认',v=>defaults.top_p=v);
  numeric('默认输出 Token','max_tokens',defaults.max_tokens,'不覆盖客户端',v=>defaults.max_tokens=v);
  const label=el('label','wide','默认思考强度'),choice=el('button','sess-pick');label.append(choice);box.append(label);
  const legacy=override.reasoningVariants||{},preset=structuredClone(patch.reasoningPreset??override.reasoningPreset??{type:'native'});let preserveLegacy=!override.reasoningPreset&&Object.keys(legacy).length>0;
  if(preserveLegacy&&model.reasoningAdapter==='effort'&&Object.entries(legacy).every(([k,v])=>Object.keys(v).length===1&&v.reasoningEffort===k)){preset.type='effort';preset.levels=Object.keys(legacy);preserveLegacy=false;}
  const allowed=()=>preset.type==='native'?model.nativeReasoningEfforts:[...new Set([...(model.nativeReasoningEfforts||[]),...(preset.levels||[])])];
  const paint=()=>{const now=defaults.reasoning_effort||'';choice.replaceChildren(el('span','',now?t(now):'跟随 OpenCode'),svg(CHEV,11,1.6));choice.onclick=()=>openProtoMenu(choice,[{v:'',name:'跟随 OpenCode',literalName:true},...allowed().map(v=>({v,name:t(v),literalName:true}))],now,v=>{defaults.reasoning_effort=v||null;paint();},'默认思考强度','sess-menu');};paint();
  if(model.reasoning&&(model.reasoningAdapter==='effort'||model.reasoningAdapter==='budget')){
    const section=el('div','wide'),modeSeg=segs([['native','原生级别'],['custom','自定义级别']],preset.type==='native'&&!preserveLegacy?'native':'custom',v=>{preserveLegacy=false;preset.type=v==='native'?'native':model.reasoningAdapter;preset.levels??=[...(model.nativeReasoningEfforts||[])];commit();draw();});section.append(el('span','','可选思考强度'),modeSeg);const levels=el('div','proxy-levels');section.append(levels);box.append(section);
    const commit=()=>{patch.reasoningPreset=structuredClone(preset);patch.reasoningVariants=null;if(defaults.reasoning_effort&&!allowed().includes(defaults.reasoning_effort))defaults.reasoning_effort=null;paint();};
    const draw=()=>{levels.replaceChildren();levels.hidden=preset.type==='native';if(levels.hidden)return;if(preserveLegacy)levels.append(el('span','hint','已有高级映射已保留；修改选择后将替换为此处的配置。'));
      for(const level of ['none','minimal','low','medium','high','xhigh','max']){const [tk,cb]=tick(t(level),(preset.levels||Object.keys(legacy)).includes(level));cb.onchange=()=>{preserveLegacy=false;const selected=new Set(preset.levels||Object.keys(legacy));if(cb.checked)selected.add(level);else selected.delete(level);preset.levels=[...selected];commit();};levels.append(tk);if(model.reasoningAdapter==='budget'&&level!=='none'){const i=input(preset.budgets?.[level]??'',level+' Token 预算');i.inputMode='numeric';i.setAttribute('aria-label',level+' 思考 Token 预算');i.oninput=()=>{preserveLegacy=false;(preset.budgets??={})[level]=Number(i.value);commit();};levels.append(i);}}
    };draw();
  }
  return box;
}
function proxyResetModel(m){draft.proxyUpdates[m.raw.target]={context:null,output:null,reasoningPreset:{type:'native'},reasoningVariants:null,defaults:{temperature:null,top_p:null,max_tokens:null,reasoning_effort:null}};queueMicrotask(()=>draft?.onModelPrefs?.());}
// Exported model IDs stay short, while internal provider/model identity survives.
gatewayModels=function(){return providers.providers.flatMap(p=>p.models.filter(m=>m.on).map(m=>({id:m.id,name:m.name,provider:p,context:m.context,output:m.output,efforts:m.efforts,images:false})));};
for(const k of Object.keys(FLAVORS))if(!['openai','responses','anthropic'].includes(k))delete FLAVORS[k];
if(!FLAVORS[flavor])flavor='openai';
const proxyRenderGateway=renderGateway;
renderGateway=function(){proxyRenderGateway();$('#gateway .sub').textContent=proxyModels.filter(m=>m.enabled).length+' 个模型 · 三种 API · 由全局 OpenCode 推理';const stop=el('button','text action',proxyState.running?'停止网关':'启动网关');stop.onclick=async()=>{stop.disabled=true;try{await proxyRequest(proxyState.running?'/admin/stop':'/admin/start',{});await proxyRead();renderGatewayView();}catch(e){status(e.message,'err');stop.disabled=false;}};$('#gateway .who').append(stop);};
const proxyRenderConnect=renderConnect;
renderConnect=function(){if(!providers)return;proxyRenderConnect();for(const e of $('#connect').querySelectorAll('.hint')){if(e.textContent.includes('provider/model'))e.textContent='使用下方纯模型名或别名。点击模型即可放入示例。';if(e.textContent.includes('magpie'))e.textContent=e.textContent.replaceAll('magpie','OpenCode Proxy');}};
const proxyRenderActivity=renderActivity;
renderActivity=function(){proxyRenderActivity();for(const c of providers.gateway.calls){const key=c.id;if(expandedCalls.has(key)&&!proxyDetails.has(c.id)){proxyDetails.set(c.id,{requestBody:'读取中…'});proxyRequest('/admin/request/'+c.id).then(d=>{const info={requestBody:JSON.stringify(d.requestedBody,null,2),responseBody:d.responsePreview||'',responseTruncated:d.responseTruncated};proxyDetails.set(c.id,info);Object.assign(c,info);if(view==='gateway')proxyRenderActivity();},e=>{proxyDetails.set(c.id,{requestBody:e.message});Object.assign(c,proxyDetails.get(c.id));proxyRenderActivity();});}}};
ledLoadContent=async function(r){try{const d=await proxyRequest('/admin/request/'+r.id);return{found:true,raw:d};}catch(e){return{found:false,why:'read',error:e.message};}};
const proxyContentBox=ledContentBox;
ledContentBox=function(c){if(!c.raw)return proxyContentBox(c);const box=el('div','cx');box.append(callBodyPanel('Request Body',JSON.stringify(c.raw.requestedBody,null,2),false),callBodyPanel('生效请求',JSON.stringify(c.raw.effectiveBody,null,2),false),callBodyPanel('Response Body',c.raw.responsePreview||'',c.raw.responseTruncated,'details-'+c.raw.responseHeaders?.requestId));return box;};
loadQuotas=async()=>{quotas=[];};
renderArchive=()=>{};
loadCLIs=loadInstalls=cliBehindOnce=whatsNewOnce=renderUpdateBadge=loadUpstream=refreshLanes=async()=>{};
markUpstream=renderMovable=renderExcluded=renderProviderDiscovery=discoverLocalProviders=renderAgents=renderAgentsLoading=()=>{};
setGatewayMode=()=>{};
load=async function(){try{if(view==='gateway'||view==='providers'&&!editing)await magpieLoadProviders();else if(view==='usage')await refreshUsage();else if(view==='settings')await loadSettings();applyPrefs(proxyPrefs());}catch(e){status(e.message,'err');}};
loadProviders=magpieLoadProviders;
loadSettings=async function(){await proxyRead();prefs=proxyPrefs();renderSettings();};
renderSettings=function(){
  const page=$('#view-settings');page.querySelectorAll('.set-page').forEach(p=>p.hidden=true);let host=$('#setPage-general');host.hidden=false;host.replaceChildren();const tabs=$('#setTabs');tabs.replaceChildren();
  for(const [id,name] of [['general','常规'],['opencode','OpenCode'],['network','网络'],['about','关于']]){const b=el('button',setShown===id?'on':'',name);b.setAttribute('role','tab');b.setAttribute('aria-selected',String(setShown===id));b.onclick=()=>{setShown=id;renderSettings();syncURL();};tabs.append(b);}if(!['general','opencode','network','about'].includes(setShown)){setShown='general';return renderSettings();}
  const list=el('div','list prefs');host.append(list);
  const row=(name,sub,control)=>{const r=el('div','row pref proxy-settings-row'),who=el('div','who');who.append(el('div','name',name),el('div','sub',sub));r.append(who,control);list.append(r);return r;};
  const saveSetting=async(change)=>{proxyState=await proxyRequest('/admin/config',{...proxyState.settings,...change});proxyModels=[];status('配置已保存','ok');};
  const edit=(name,sub,key,numeric=false)=>{const i=input(proxyState.settings[key]??'',key==='command'?'opencode':'');i.setAttribute('aria-label',name);const save=el('button','text action',t('Save'));save.onclick=async()=>{save.disabled=true;try{if(numeric&&!Number.isFinite(Number(i.value)))throw Error('请输入有效数字。');await saveSetting({[key]:numeric?Number(i.value):key==='command'?(i.value.trim()||'opencode'):i.value});}catch(e){status(e.message,'err');}finally{save.disabled=false;}};const r=row(name,sub,i);r.append(save);return{i,r};};
  if(setShown==='general'){
    row('外观','跟随系统或手动选择',segs([['system','系统'],['light','浅色'],['dark','深色']],proxyPrefs().theme,v=>{localStorage.setItem('opencode-proxy.theme',v);applyPrefs(proxyPrefs());}));
    row('文字大小','Magpie 原始文字与布局缩放',segs([[90,'90%'],[100,'100%'],[110,'110%'],[120,'120%']],proxyPrefs().textSize,v=>{localStorage.setItem('opencode-proxy.size',v);document.documentElement.style.setProperty('--zoom',v/100);}));
    const bg=el('button','text action','隐藏到托盘');bg.disabled=!proxyDesktop();bg.onclick=()=>proxyDesktop().HideToTray();row('后台运行',proxyDesktop()?'关闭窗口后继续在托盘提供服务。退出请使用下方“退出程序”。':'Linux / 浏览器由服务进程提供后台运行。',bg);
    const quit=el('button','text action','退出程序');quit.onclick=()=>api('window/quit',{});row('退出','停止网关并退出后台进程',quit);
  }
  if(setShown==='opencode'){
    const command=edit('OpenCode 程序','默认自动查找全局安装；不限制版本。','command');if(Array.isArray(proxyState.settings.command)){command.i.value=proxyState.settings.command.join(' ');if(proxyState.settings.command.length>1){command.i.disabled=true;command.r.querySelector('button').disabled=true;command.r.querySelector('.sub').textContent='当前为多参数命令；保留原配置。';}}
    const dir=edit('工作目录','留空使用默认目录；读取该目录和全局 OpenCode 配置。','workingDirectory');const browse=el('button','text action','选择目录');browse.disabled=!proxyDesktop();browse.onclick=async()=>{const value=await proxyDesktop().SelectDirectory();if(value)dir.i.value=value;};dir.r.append(browse);
    edit('启动超时（毫秒）','OpenCode 启动并准备就绪的等待时间。','startupTimeoutMs',true);
    edit('首输出超时（毫秒）','等待真实模型首输出的时间；0 为不限。','firstOutputTimeoutMs',true);
    edit('空闲超时（毫秒）','输出过程中无事件的等待时间；0 为不限。','idleTimeoutMs',true);
    edit('总超时（毫秒）','0 为不限。','timeoutMs',true);
    row('工作进程复用','空闲 OpenCode 工作进程可复用；不限制请求并发。',segs([[false,'关闭'],[true,'开启']],proxyState.settings.workerReuse,v=>saveSetting({workerReuse:v}).catch(e=>status(e.message,'err'))));
  }
  if(setShown==='network'){edit('监听地址','127.0.0.1 为本机；0.0.0.0 允许局域网通过访问 Key 连接。','host');edit('API 端口','三种协议共用该端口。','port',true);edit('并发上限','0 为不限；默认不限并发。','maxConcurrent',true);}
  if(setShown==='about'){row('OpenCode Proxy','0.6.0 · 独立 OpenCode 反向代理',el('span','mono','Windows / Linux'));row('配置文件',proxyState.configFile,el('span',''));row('前端来源','在 Magpie 原始前端上修改精简；保留其 MIT 许可证。',el('span','mono','210234a5'));row('请求记录','保留完整提示词、工具参数、请求及响应；最近 250 条。',el('span',''));}
};
// Remove unrelated original pages after their initialization has finished.
for(const id of ['agents','routing','sessions','library','plugins']){$('#view-'+id)?.remove();$(`#nav button[data-view="${id}"]`)?.remove();}
$('.brand').lastElementChild.textContent='OpenCode Proxy';
$('#prefs').title='设置';
$('#ledExport').onclick=()=>{const rows=proxyRows(new URLSearchParams(ledParams())).map(proxyRow);const keys=['t','agent','req','providerName','status','ms','ttft_ms','in','out','cache_read','cache_write','reasoning'];const csv='\uFEFF'+[keys,...rows.map(r=>keys.map(k=>r[k]??''))].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'})),a=el('a');a.href=url;a.download='opencode-proxy-requests.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
gatewayLimitBadge=()=>el('span','');gatewayModelsBadge=()=>el('span','');
const originalLedger=renderLedger;renderLedger=function(){originalLedger();$('#ledVia').hidden=true;$('#ledQ').placeholder='搜索模型、供应商、客户端或请求 ID';$('#ledNote').textContent='请求明细保留最近 250 条；累计用量见“概览”。Token、首字和输出速度采用 Magpie 的统计计算。';};
const originalUsage=renderUsage;renderUsage=function(){originalUsage();for(const id of ['usageAgents','usageModels']){const node=$('#'+id);if(!node.childElementCount){node.hidden=true;if(node.previousElementSibling?.classList.contains('row-head'))node.previousElementSibling.hidden=true;}}};
const originalUsageEvery=renderUsageEvery;renderUsageEvery=function(...args){originalUsageEvery(...args);$('#usageReload').title='刷新网关用量与请求记录';};
for(const [id,text] of [['usageScope','累计网关请求与 Token 统计持久化；费用和订阅剩余额度未提供。'],['ledScope','最近 250 条网关请求明细（包含失败和本地拒绝）；筛选与 CSV 作用于保留的明细。']]){const e=$('#'+id);e.dataset.en=text;e.textContent=text;}
const proxyApplyPrefs=applyPrefs;applyPrefs=function(...args){const changed=proxyApplyPrefs(...args);document.documentElement.style.setProperty('--zoom',proxyPrefs().textSize/100);return changed;};
if(['general','opencode','network','about'].includes(params.get('tab')))setShown=params.get('tab');
view='gateway';
(async()=>{try{await proxyRead(true);applyPrefs(proxyPrefs());connectKeyID=proxyState.settings.apiKeys.find(k=>k.enabled)?.id||'';await loadGatewayKeys();show(['providers','gateway','usage','settings'].includes(params.get('view'))?params.get('view'):'gateway');await load();}catch(e){status(e.message,'err');}})();
setInterval(()=>{if(!document.hidden&&(view==='gateway'||view==='providers'&&!editing))load();},3000);
