import {createHash} from 'node:crypto';
import {clientToolNames,toolName,nativeToolName,toolPermissions} from './protocol.mjs';
import {nativeGeneration} from './generation.mjs';

// Object member order is irrelevant; array order (including schema tuples) is not.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const contractHash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function mcpToolDefinitions(body){
  const allowed=new Set(clientToolNames(body));
  const tools=(body.tools??[]).filter(t=>allowed.has(nativeToolName(t.function.name))).map(({function:f})=>({name:toolName(f.name),description:`Client function: ${f.name}. Use this registered tool when client instructions refer to ${f.name}.\n\n${f.description??''}`,inputSchema:f.parameters??{type:'object',properties:{}}}));
  const generation=nativeGeneration(body);
  if(generation?.capture)tools.push({name:'structured_output',description:'Return the final constrained JSON value through this tool. For function selection return the calls array with client function names and arguments. This captures data only.',inputSchema:generation.format.schema});
  return tools;
}
export function sharedContract(body){
  const compare=(a,b)=>a<b?-1:a>b?1:0;
  const value={clientTools:[...(body.tool_choice==='none'?[]:body.tools??[])].sort((a,b)=>compare(a.function.name,b.function.name)),tools:mcpToolDefinitions(body).sort((a,b)=>compare(a.name,b.name)),permission:toolPermissions(body)};
  return {...structuredClone(value),hash:contractHash(value)};
}
