import {ApiError} from './protocol.mjs';

// Explicit store=true conversation state only. Never written to disk or logs.
export class ResponseStore {
  constructor({ttlMs=30*60*1000,maxEntries=256,maxBytes=32*1024*1024,maxEntryBytes=4*1024*1024,now=Date.now}={}) {
    Object.assign(this,{ttlMs,maxEntries,maxBytes,maxEntryBytes,now});this.entries=new Map();this.bytes=0;
  }
  remove(id){const entry=this.entries.get(id);if(entry){this.bytes-=entry.bytes;this.entries.delete(id);}return entry;}
  prune(){for(const [id,entry] of this.entries)if(entry.expires<=this.now())this.remove(id);}
  owner(owner){if(typeof owner!=='string'||!owner)throw new ApiError('Stored Responses require an authenticated gateway client.',401,null,'invalid_api_key');return owner;}
  get(id,owner){this.owner(owner);this.prune();const entry=this.entries.get(id);if(!entry||entry.owner!==owner)throw new ApiError('Response not found or expired.',404,'previous_response_id','response_not_found');return structuredClone(entry.value);}
  expand(body,owner){
    if(body.store===true)this.owner(owner);
    if(body.previous_response_id==null)return body;
    if(typeof body.previous_response_id!=='string'||!body.previous_response_id)throw new ApiError('previous_response_id must be a response ID.',400,'previous_response_id');
    const previous=this.get(body.previous_response_id,owner),input=body.input===undefined?[]:typeof body.input==='string'?[{role:'user',content:body.input}]:body.input;
    if(!Array.isArray(input))throw new ApiError('input must be text or history items.',400,'input');
    // Instructions and generation options belong to this request, not its parent.
    return {...body,model:body.model??previous.response.model,input:[...previous.input,...previous.response.output,...input]};
  }
  put(response,input,owner,session){
    this.owner(owner);this.prune();
    const value={response,input:typeof input==='string'?[{role:'user',content:input}]:input??[],...(session?{session}:{})},bytes=Buffer.byteLength(JSON.stringify(value));
    if(bytes>this.maxEntryBytes||bytes>this.maxBytes)throw new ApiError('Stored response exceeds the in-memory conversation limit; use store=false and send full history.',413,'store','response_store_limit');
    this.remove(response.id);
    while(this.entries.size>=this.maxEntries||this.bytes+bytes>this.maxBytes)this.remove(this.entries.keys().next().value);
    this.entries.set(response.id,{owner,value:structuredClone(value),bytes,expires:this.now()+this.ttlMs});this.bytes+=bytes;
  }
  delete(id,owner){this.get(id,owner);this.remove(id);return {id,object:'response.deleted',deleted:true};}
  clear(){this.entries.clear();this.bytes=0;}
}
