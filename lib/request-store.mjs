import path from 'node:path';
import {mkdir,open,readFile,rm} from 'node:fs/promises';
import {atomicJSON} from './settings.mjs';
import {ApiError} from './protocol.mjs';
export class RequestStore{
  constructor(directory){this.directory=directory;this.handles=new Map();}
  file(id,suffix){if(!/^[a-f0-9-]{36}$/i.test(id))throw new ApiError('请求 ID 无效。',400);return path.join(this.directory,id+'.'+suffix);}
  async start(id,detail){await atomicJSON(this.file(id,'json'),detail);}
  async effective(id,body){const file=this.file(id,'json');const detail=JSON.parse(await readFile(file,'utf8'));detail.effectiveBody=body;await atomicJSON(file,detail);}
  async openResponse(id,headers){await mkdir(this.directory,{recursive:true,mode:0o700});const handle=await open(this.file(id,'response'),'w',0o600);this.handles.set(id,handle);const file=this.file(id,'json');const detail=JSON.parse(await readFile(file,'utf8'));detail.responseHeaders={contentType:headers.get('content-type'),requestId:headers.get('x-opencode-request-id')};await atomicJSON(file,detail);}
  async append(id,bytes){await this.handles.get(id)?.write(bytes);}
  async finish(id){const handle=this.handles.get(id);this.handles.delete(id);await handle?.close();}
  async remove(id){await this.finish(id);await Promise.all([rm(this.file(id,'json'),{force:true}),rm(this.file(id,'response'),{force:true})]);}
  async detail(id){const detail=JSON.parse(await readFile(this.file(id,'json'),'utf8').catch(()=>{throw new ApiError('该请求明细未保存或已超出保留范围。',404);}));const handle=await open(this.file(id,'response'),'r').catch(()=>undefined);if(handle){try{const info=await handle.stat(),bytes=Buffer.alloc(Math.min(info.size,2*1024*1024));await handle.read(bytes,0,bytes.length,0);detail.responsePreview=bytes.toString('utf8');detail.responseTruncated=info.size>bytes.length;detail.responseBytes=info.size;detail.responseFile=this.file(id,'response');}finally{await handle.close();}}return detail;}
  async close(){await Promise.allSettled([...this.handles.keys()].map(id=>this.finish(id)));}
}
