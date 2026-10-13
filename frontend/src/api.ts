declare global{interface Window{go?:{main?:{Desktop?:{Request:(method:string,path:string,body:string)=>Promise<string>;SelectDirectory:()=>Promise<string>;SelectExecutable:()=>Promise<string>;CopyText:(text:string)=>Promise<void>}}}}}
export async function api(path:string,method='GET',body?:unknown){
  const desktop=window.go?.main?.Desktop;
  let status:number,data:any;
  if(desktop){const response=JSON.parse(await desktop.Request(method,path,body===undefined?'':JSON.stringify(body)));status=response.status;data=response.data;}
  else{const token=document.querySelector<HTMLMetaElement>('meta[name=admin-token]')?.content;const response=await fetch(path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});status=response.status;data=await response.json();}
  if(status>=400)throw new Error(data.error?.message??'操作失败（'+status+'）');
  return data;
}
export async function copy(text:string){if(window.go?.main?.Desktop)await window.go.main.Desktop.CopyText(text);else await navigator.clipboard.writeText(text);}
export const selectDirectory=()=>window.go?.main?.Desktop?.SelectDirectory();
export const selectExecutable=()=>window.go?.main?.Desktop?.SelectExecutable();
export const desktopMode=()=>!!window.go?.main?.Desktop;
