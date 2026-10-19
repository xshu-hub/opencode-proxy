// Reconstruct client-visible calls rather than treating every delta as a call.
export function toolCalls(chunks){
 const calls=new Map();
 for(const chunk of chunks)for(const delta of chunk.choices?.[0]?.delta?.tool_calls??[]){
  const call=calls.get(delta.index)??{index:delta.index,function:{name:'',arguments:''}};
  if(delta.id)call.id=delta.id;if(delta.type)call.type=delta.type;
  call.function.name+=delta.function?.name??'';call.function.arguments+=delta.function?.arguments??'';calls.set(delta.index,call);
 }
 return [...calls.values()].sort((a,b)=>a.index-b.index);
}
