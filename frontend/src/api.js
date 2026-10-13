// Adapter replacing Magpie's own API/runtime; browser and Wails use one UI.
export const desktop=()=>window.go?.main?.Desktop;
export async function api(route,method='GET',body){
  let status,data;
  if(desktop()){const reply=JSON.parse(await desktop().Request(method,route,body===undefined?'':JSON.stringify(body)));status=reply.status;data=reply.data;}
  else{const token=document.querySelector('meta[name=admin-token]')?.content;const response=await fetch(route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});status=response.status;data=await response.json();}
  if(status>=400)throw new Error(data.error?.message??`操作失败（${status}）`);return data;
}
export async function copy(value){if(desktop())await desktop().CopyText(value);else await navigator.clipboard.writeText(value);}
