import {readFile} from 'node:fs/promises';
import {atomicJSON} from './settings.mjs';
import {ledDecode,flowMs} from './magpie-metrics.mjs';

const empty=()=>({requests:0,success:0,failed:0,cancelled:0,inputTokens:0,outputTokens:0,cachedTokens:0,cacheWriteTokens:0,reasoningTokens:0,usageSamples:0,ttftSum:0,ttftSamples:0,durationSum:0,generationMs:0,generationTokens:0});
export class Telemetry{
  constructor(file){this.file=file;this.rows=[];this.active=new Map();this.totals=empty();this.byModel={};this.byDay={};this.writing=Promise.resolve();}
  async load(){try{const data=JSON.parse(await readFile(this.file,'utf8'));this.rows=(data.rows??[]).slice(0,250);this.totals={...empty(),...data.totals};this.byModel=data.byModel??{};this.byDay=data.byDay??{};}catch(e){if(e.code!=='ENOENT')throw e;}}
  begin(row){this.active.set(row.id,row);}
  report(report){const row=this.active.get(report.requestId);if(!row)return;row.diagnostic=report;}
  finish(id,{httpStatus,errorCode}={}){
    const row=this.active.get(id);if(!row)return;
    this.active.delete(id);
    const d=row.diagnostic??{},t=d.timings??{};
    row.elapsedMs=Date.now()-row.startedMs;
    row.httpStatus=httpStatus??row.httpStatus??200;
    row.status=d.status==='cancelled'||row.cancelled?'cancelled':errorCode||row.httpStatus>=400||d.status==='failed'?'failed':'completed';
    row.errorCode=errorCode??d.errorCode;
    row.nativeFirstMs=t.firstModelEvent===undefined?undefined:(t.catalogMs??0)+t.firstModelEvent;
    row.ttftMs=row.stream?row.clientFirstMs:undefined;
    row.workerReused=d.workerReused;row.timeoutKind=d.timeoutKind;row.finishReason=d.finishReason;
    row.usage=d.usage??row.usage;
    if(d.usageKnown===false)delete row.usage;
    if(row.usage){row.cacheRead=d.tokens?.cache?.read??row.usage.prompt_tokens_details?.cached_tokens??0;row.cacheWrite=d.tokens?.cache?.write??0;row.inputTokens=d.tokens?.input??Math.max(0,(row.usage.prompt_tokens??0)-row.cacheRead-row.cacheWrite);row.outputTokens=row.usage.completion_tokens??0;row.reasoningTokens=d.tokens?.reasoning??row.usage.completion_tokens_details?.reasoning_tokens??0;}
    row.flowMs=flowMs(row.flowMarks??[],row.reasoningTokens>0?row.firstTextMs:row.ttftMs);
    const decode=ledDecode({status:row.httpStatus,err:row.status==='completed'?'':row.errorCode??row.status,ms:row.elapsedMs,ttft_ms:row.ttftMs,first_text_ms:row.firstTextMs,out:row.outputTokens??0,reasoning:row.reasoningTokens??0,flow_ms:row.flowMs});
    if(decode){row.generationMs=decode.w;row.generationTokens=decode.n;row.tokensPerSecond=decode.n/(decode.w/1000);}
    delete row.flowMarks;delete row.flowBytes;
    delete row.diagnostic;delete row.startedMs;delete row.cancelled;
    this.rows.unshift(row);const expired=this.rows.splice(250).map(r=>r.id);
    const date=new Date(row.startedAt),day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
    for(const bucket of [this.totals,this.byModel[row.model]??=(empty()),this.byDay[day]??=(empty())]){
      bucket.requests++;if(row.status==='completed')bucket.success++;else bucket.failed++;if(row.status==='cancelled')bucket.cancelled++;bucket.durationSum+=row.elapsedMs;
      if(row.ttftMs>0&&row.status==='completed'){bucket.ttftSum+=row.ttftMs;bucket.ttftSamples++;}
      if(row.usage){bucket.usageSamples++;bucket.inputTokens+=row.inputTokens;bucket.outputTokens+=row.outputTokens;bucket.cachedTokens+=row.cacheRead;bucket.cacheWriteTokens+=row.cacheWrite;bucket.reasoningTokens+=row.reasoningTokens;if(row.generationMs>0){bucket.generationMs+=row.generationMs;bucket.generationTokens+=row.generationTokens;}}
    }
    for(const day of Object.keys(this.byDay).sort().slice(0,-90))delete this.byDay[day];
    this.persist();
    return expired;
  }
  persist(){this.dirty=true;if(this.saving)return;this.saving=true;this.writing=(async()=>{try{do{this.dirty=false;await atomicJSON(this.file,structuredClone({rows:this.rows,totals:this.totals,byModel:this.byModel,byDay:this.byDay}));this.storageError=undefined;}while(this.dirty);}catch{this.storageError='statistics_write_failed';}finally{this.saving=false;}})();}
  snapshot(){return {timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,storageError:this.storageError,active:[...this.active.values()].map(({diagnostic,startedMs,flowMarks,flowBytes,...r})=>r),rows:this.rows,totals:this.totals,byModel:this.byModel,byDay:this.byDay};}
  async close(){await this.writing;}
}
