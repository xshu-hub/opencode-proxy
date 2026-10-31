import path from 'node:path';
import {readFile,writeFile,stat,realpath} from 'node:fs/promises';
import {sharedContract} from './shared-contract.mjs';

export const sessionPath=(root,id)=>{
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw new Error('Invalid native session identity.');
  return path.join(root,'requests',id);
};
const samePath=(a,b)=>process.platform==='win32'?a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase():a===b;

// One registry per real-directory instance. No process-wide current request.
export async function sharedSessions(root,directory){
  const group=JSON.parse(await readFile(path.join(root,'shared.json'),'utf8'));
  if(group.version!==2||!samePath(await realpath(directory),group.directory))throw new Error('OpenCode instance does not own this process group.');
  const pending=new Map();let disposed=false;
  const binding=async id=>{
    const home=sessionPath(root,id),request=JSON.parse(await readFile(path.join(home,'request.json'),'utf8'));
    if(request.sessionID!==id||request.groupID!==group.groupID||sharedContract(request.body).hash!==group.contract.hash)throw new Error('OpenCode session does not own this request.');
    return {home,request};
  };
  return {
    group,
    async get(id){
      if(disposed)throw new Error('OpenCode instance has been disposed.');
      sessionPath(root,id);
      if(!pending.has(id)){
        const loading=(async()=>{
          const {home,request}=await binding(id);
          if(await stat(path.join(home,'closing')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw new Error('OpenCode request has been closed.');
          return {home,request,injected:false,systemTransformed:false,closed:false,stopped:Promise.withResolvers()};
        })();
        pending.set(id,loading);
        void loading.catch(()=>{if(pending.get(id)===loading)pending.delete(id);});
      }
      const state=await pending.get(id);
      if(disposed||state.closed)throw new Error('OpenCode request has been closed.');
      return state;
    },
    async release(id){
      // Native deletion events for unbound sessions are harmless.
      const state=await pending.get(id)?.catch(()=>undefined);
      let bound;try{bound=state?.request?{home:state.home,request:state.request}:await binding(id);}catch{return;}
      if(state){state.closed=true;state.request=undefined;state.stopped.resolve();}
      pending.delete(id);
      const {sessionID,requestID,groupID}=bound.request;
      await writeFile(path.join(bound.home,'released.json'),JSON.stringify({sessionID,requestID,groupID}),{mode:0o600});
    },
    async dispose(){disposed=true;await Promise.allSettled([...pending.values()].map(async loading=>{const state=await loading;state.closed=true;state.request=undefined;state.stopped.resolve();}));pending.clear();},
  };
}
