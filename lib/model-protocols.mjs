import {ApiError} from './protocol.mjs';

// Both representations use the enabled alias catalog discovered through OpenCode.
export function modelResponse(url,protocol,models){
  const {pathname,searchParams}=new URL(url),route=pathname.replace(/\/$/,'');
  if(route!=='/v1/models'&&!/^\/v1\/models\/[^/]+$/.test(route))return;
  const anthropic=protocol==='anthropic';
  const json=value=>Response.json(value,{headers:{'cache-control':'no-store',vary:'authorization, x-api-key, anthropic-version'}});
  const entries=Object.entries(models).sort(([a],[b])=>a<b?-1:a>b?1:0);
  const item=([id,model])=>anthropic
    ?{id,type:'model',display_name:model.name??id,created_at:'1970-01-01T00:00:00Z',capabilities:null,lifecycle:'active',line:null,deprecated_at:null,retires_at:null,max_input_tokens:model.context??null,max_tokens:model.output??null}
    :{id,object:'model',created:0,owned_by:'opencode-bridge'};
  if(route!=='/v1/models'){
    let id;try{id=decodeURIComponent(route.slice('/v1/models/'.length));}catch{throw new ApiError('Invalid model ID.',400,'model');}
    const entry=entries.find(([name])=>name===id);
    if(!entry)throw new ApiError('Unknown or disabled model.',404,'model','model_not_found');
    return json(item(entry));
  }
  if(!anthropic)return json({object:'list',data:entries.map(item)});
  const invalid=param=>{throw new ApiError('Invalid model pagination parameter.',400,param);};
  for(const key of searchParams.keys())if(!['limit','before_id','after_id'].includes(key)||searchParams.getAll(key).length!==1)invalid(key);
  const rawLimit=searchParams.get('limit'),limit=rawLimit===null?20:Number(rawLimit);
  if((rawLimit!==null&&!/^\d+$/.test(rawLimit))||!Number.isInteger(limit)||limit<1||limit>1000)invalid('limit');
  const before=searchParams.get('before_id'),after=searchParams.get('after_id');
  if(before!==null&&after!==null)invalid('before_id');
  let start=0,end=entries.length;
  if(before!==null||after!==null){const cursor=before??after,index=entries.findIndex(([id])=>id===cursor);if(index<0)invalid(before!==null?'before_id':'after_id');if(before!==null)end=index;else start=index+1;}
  const selected=before!==null?entries.slice(Math.max(start,end-limit),end):entries.slice(start,Math.min(end,start+limit));
  const data=selected.map(item);
  return json({data,has_more:end-start>selected.length,first_id:data[0]?.id??null,last_id:data.at(-1)?.id??null});
}
