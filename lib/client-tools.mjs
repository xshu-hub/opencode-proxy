import {createHash} from 'node:crypto';
import {ApiError} from './protocol.mjs';

const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const fail=(message,param)=>{throw new ApiError(message,400,param,'unsupported_parameter');};
function fields(value,allowed,param){if(!object(value))fail('Expected a tool object.',param);for(const key of Object.keys(value))if(!allowed.includes(key))fail('Unsupported tool parameter: '+key,param+'.'+key);}
function identity(type,name,namespace,param){
  if(typeof name!=='string'||!name.length||name.length>128||!/^[a-zA-Z0-9_-]+$/.test(name))fail('Invalid client tool name.',param+'.name');
  if(namespace!==undefined&&(typeof namespace!=='string'||!namespace.length||namespace.length>128||!/^[a-zA-Z0-9_-]+$/.test(namespace)))fail('Invalid tool namespace.',param+'.namespace');
  const wire=type==='function'&&namespace===undefined&&name.length<=64?name:'client_'+createHash('sha256').update(JSON.stringify([type,namespace??null,name])).digest('hex').slice(0,40);
  return{type,name,...(namespace!==undefined?{namespace}:{}),wire};
}

// OpenCode executes only native JSON function tools. Keep the reversible client
// identity outside its request, including when replaying stateless history.
export function responseTools(request){
  const byWire=new Map(),declared=new Map();
  const register=(type,name,namespace,param)=>{
    const item=identity(type,name,namespace,param),previous=byWire.get(item.wire);
    if(previous&&JSON.stringify(previous)!==JSON.stringify(item))fail('Client tool alias collision.',param);
    byWire.set(item.wire,item);return item;
  };
  const tools=[];
  const leaf=(tool,namespace,param)=>{
    fields(tool,['type','name','description','parameters','strict','format','defer_loading'],param);
    if(!['function','custom'].includes(tool.type))fail('Only client function and custom text tools can be mapped to OpenCode.',param+'.type');
    if(tool.defer_loading!==undefined&&tool.defer_loading!==false)fail('Deferred tool discovery requires native tool search.',param+'.defer_loading');
    if(tool.description!==undefined&&typeof tool.description!=='string')fail('Tool description must be text.',param+'.description');
    if(tool.type==='function'&&tool.format!==undefined)fail('Function tools cannot specify a custom format.',param+'.format');
    if(tool.type==='custom'){
      if(tool.parameters!==undefined||tool.strict!==undefined)fail('Custom tools use text input, not a JSON parameter schema.',param);
      if(tool.format!==undefined){fields(tool.format,['type','syntax','definition'],param+'.format');if(tool.format.type!=='text')fail('OpenCode cannot enforce custom grammar formats; use text input.',param+'.format');if(tool.format.syntax!==undefined||tool.format.definition!==undefined)fail('Text custom tools cannot specify grammar options.',param+'.format');}
    }
    const item=register(tool.type,tool.name,namespace,param);
    if(declared.has(item.wire))fail('Duplicate client tool identity.',param+'.name');
    declared.set(item.wire,item);
    tools.push({type:'function',function:{name:item.wire,...(tool.description!==undefined?{description:tool.description}:{}),...(tool.type==='custom'?{description:(tool.description??'')+'\nPass the exact freeform tool input in the input string.',parameters:{type:'object',properties:{input:{type:'string'}},required:['input'],additionalProperties:false},strict:true}:{...(tool.parameters!==undefined?{parameters:tool.parameters}:{}),...(tool.strict!==undefined?{strict:tool.strict}:{})})}});
    if(item.wire!==item.name)tools.at(-1).function.description=`Client tool ${namespace?namespace+'.':''}${item.name}.\n${tools.at(-1).function.description??''}`;
  };
  if(request.tools!==undefined){
    if(!Array.isArray(request.tools))fail('tools must be an array.','tools');
    for(const [i,tool] of request.tools.entries()){
      const p=`tools[${i}]`;
      if(tool?.type==='namespace'){
        fields(tool,['type','name','description','tools'],p);identity('function','namespace',tool.name,p);
        if(!Array.isArray(tool.tools)||!tool.tools.length)fail('Namespaces require client tools.',p+'.tools');
        if(tool.description!==undefined&&typeof tool.description!=='string')fail('Namespace description must be text.',p+'.description');
        for(const [j,child] of tool.tools.entries()){
          leaf(child,tool.name,p+`.tools[${j}]`);
          if(tool.description)tools.at(-1).function.description=`Namespace ${tool.name}: ${tool.description}\n${tools.at(-1).function.description??''}`;
        }
      }else leaf(tool,undefined,p);
    }
  }
  for(const [i,item] of (Array.isArray(request.input)?request.input:[]).entries())if(['function_call','custom_tool_call'].includes(item?.type))register(item.type==='custom_tool_call'?'custom':'function',item.name,item.namespace,`input[${i}]`);
  let choice=request.tool_choice;
  if(object(choice)){
    fields(choice,['type','name','namespace'],'tool_choice');
    if(!['function','custom'].includes(choice.type))fail('Unsupported client tool choice.','tool_choice');
    const item=identity(choice.type,choice.name,choice.namespace,'tool_choice');
    if(!declared.has(item.wire))fail('Selected tool must be declared.','tool_choice');
    choice={type:'function',function:{name:item.wire}};
  }else if(choice!==undefined&&!['auto','none','required'].includes(choice))fail('Invalid tool choice.','tool_choice');
  return{tools,choice,byWire,call:(item,param)=>{
    const type=item.type==='custom_tool_call'?'custom':'function',mapped=register(type,item.name,item.namespace,param);
    if(type==='custom'&&typeof item.input!=='string')fail('Custom tool input must be text.',param+'.input');
    return{id:item.call_id,type:'function',function:{name:mapped.wire,arguments:type==='custom'?JSON.stringify({input:item.input}):item.arguments}};
  }};
}
