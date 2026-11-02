// Translate constraints through OpenCode's public native structured-output API.
// The internal StructuredOutput function only captures JSON, never client actions.
export const CAPTURE_TOOL='bridge_structured_output';
export function nativeGeneration(body) {
  const capture=body.thinking?.type!=='disabled'&&body.reasoning_effort!=='none';
  const named=typeof body.tool_choice==='object'?body.tool_choice?.function?.name:undefined;
  const required=body.tool_choice==='required'||named!==undefined;
  const tools=(body.tools??[]).filter(t=>!named||t.function.name===named);
  if(body.tool_choice!=='none'&&tools.length&&(required||body.parallel_tool_calls===false)) {
    const scoped=(value,root)=>Array.isArray(value)?value.map(v=>scoped(v,root)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,v])=>[key,key==='$ref'&&typeof v==='string'&&(v==='#'||v.startsWith('#/'))?root+v.slice(1):scoped(v,root)])):value;
    const schema={type:'object',properties:{calls:{type:'array',minItems:required?1:0,maxItems:named||body.parallel_tool_calls===false?1:128,items:{anyOf:tools.map(({function:f},i)=>({type:'object',properties:{name:{const:f.name,description:f.description??''},arguments:scoped(f.parameters??{type:'object'},'#/properties/calls/items/anyOf/'+i+'/properties/arguments')},required:['name','arguments'],additionalProperties:false}))}},answer:{type:'string'}},required:['calls'],additionalProperties:false};
    return {kind:'tools',capture,format:{type:'json_schema',schema,retryCount:0}};
  }
  if(body.response_format?.type==='json_schema')return {kind:'json',capture,format:{type:'json_schema',schema:body.response_format.json_schema.schema,retryCount:0}};
  if(body.response_format?.type==='json_object')return {kind:'json',capture,format:{type:'json_schema',schema:{type:'object',additionalProperties:true},retryCount:0}};
}
