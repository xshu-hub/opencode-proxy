import {ApiError} from './protocol.mjs';
import {assertSchema} from './schema.mjs';

// DeepSeek's internal tool syntax sometimes escapes provider parsing as text.
// Recover only a whole, leading call batch for tools advertised on this request.
const tokens=['｜DSML｜','｜｜DSML｜｜','|DSML|','||DSML||'];
const invalid=()=>new ApiError('OpenCode returned malformed or incomplete DSML tool calls.',502,null,'invalid_dsml_tool_call');
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function parse(text,definitions){
  let position=0;
  const take=pattern=>{const match=new RegExp('\\s*(?:'+pattern+')','y');match.lastIndex=position;const found=match.exec(text);if(!found)throw invalid();position=match.lastIndex;return found;};
  const root=take('<('+tokens.map(escape).join('|')+')\\s*(calls|tool_calls|function_calls)>');
  const token=escape(root[1]),end='</'+token+'\\s*';
  const calls=[];
  while(!new RegExp('^\\s*'+end+root[2]+'>').test(text.slice(position))){
    if(calls.length>=128)throw invalid();
    const name=take('<'+token+'\\s*invoke\\s+name="([^"<>]+)"\\s*>')[1];
    const definition=definitions.get(name);
    if(!definition)throw new ApiError('OpenCode DSML attempted an unregistered tool.',502,null,'unregistered_tool');
    const input=Object.create(null);
    while(!new RegExp('^\\s*'+end+'invoke>').test(text.slice(position))){
      const parameter=take('<'+token+'\\s*parameter\\s+name="([^"<>]+)"\\s+string="(true|false)"\\s*>');
      if(Object.hasOwn(input,parameter[1]))throw invalid();
      const close=new RegExp(end+'parameter>','g');close.lastIndex=position;const found=close.exec(text);if(!found)throw invalid();
      const raw=text.slice(position,found.index);position=close.lastIndex;
      try{input[parameter[1]]=parameter[2]==='true'?raw:JSON.parse(raw);}catch{throw invalid();}
    }
    take(end+'invoke>');
    try{assertSchema(definition.parameters??{type:'object'},input,'tools');}catch(error){if(error.status===400)throw invalid();throw error;}
    calls.push({name,input});
  }
  take(end+root[2]+'>');
  if(!calls.length||text.slice(position).trim())throw invalid();
  return calls;
}

export class ToolTextRecovery{
  constructor(definitions,{limit=1024*1024}={}){this.definitions=new Map(definitions.map(d=>[d.name,d]));this.mode=this.definitions.size?'probe':'text';this.pending='';this.limit=limit;}
  push(delta){
    if(this.mode==='text')return delta;
    this.pending+=delta;
    const start=this.pending.trimStart();
    if(this.mode==='probe'){
      const markers=tokens.map(token=>'<'+token);
      if(markers.some(marker=>start.startsWith(marker)))this.mode='calls';
      else if(!markers.some(marker=>marker.startsWith(start))||this.pending.length>4096){this.mode='text';const text=this.pending;this.pending='';return text;}
    }
    if(Buffer.byteLength(this.pending)>this.limit)throw new ApiError('OpenCode DSML tool batch exceeds the recovery limit.',502,null,'invalid_dsml_tool_call');
    return '';
  }
  finish(){
    if(this.mode==='calls')return {calls:parse(this.pending,this.definitions)};
    const text=this.pending;this.pending='';return {text};
  }
}
