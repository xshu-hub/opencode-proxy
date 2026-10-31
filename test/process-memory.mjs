import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
// Optional direct counters for hosts where the WMI performance provider stalls.
// QueryWorkingSet counts non-sharable resident pages; no process content is read.
const psapi = pids => `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OpenCodeMemory {
 [StructLayout(LayoutKind.Sequential)] public struct Counters {
  public uint cb, PageFaultCount;
  public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage;
 }
 public class Row { public int IDProcess; public ulong WorkingSet, WorkingSetPrivate, PrivateBytes; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int id);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("psapi.dll",SetLastError=true)] static extern bool GetProcessMemoryInfo(IntPtr handle,ref Counters counters,uint size);
 [DllImport("psapi.dll",SetLastError=true)] static extern bool QueryWorkingSet(IntPtr handle,IntPtr buffer,int size);
 static ulong PrivateResident(IntPtr handle) {
  for(int size=65536;size<=67108864;size*=2) {
   var buffer=Marshal.AllocHGlobal(size);
   try {
    if(!QueryWorkingSet(handle,buffer,size)){int error=Marshal.GetLastWin32Error();if(error==24)continue;throw new Win32Exception(error);}
    long count=IntPtr.Size==8?Marshal.ReadInt64(buffer):Marshal.ReadInt32(buffer);
    if(count<0||count>(size-IntPtr.Size)/IntPtr.Size)throw new Exception("Invalid working set entry count.");
    ulong pages=0;
    for(int i=0;i<count;i++){int offset=IntPtr.Size*(i+1);ulong flags=IntPtr.Size==8?unchecked((ulong)Marshal.ReadInt64(buffer,offset)):unchecked((uint)Marshal.ReadInt32(buffer,offset));if((flags&256UL)==0)pages++;}
    return pages*(ulong)Environment.SystemPageSize;
   } finally {Marshal.FreeHGlobal(buffer);}
  }
  throw new Exception("Working set metadata exceeded the sampler limit.");
 }
 public static Row Read(int id) {
  var handle=OpenProcess(0x410,false,id); if(handle==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
  try { var c=new Counters(); c.cb=(uint)Marshal.SizeOf(typeof(Counters));
   if(!GetProcessMemoryInfo(handle,ref c,c.cb))throw new Win32Exception(Marshal.GetLastWin32Error());
   var ws=c.WorkingSetSize.ToUInt64(); var own=PrivateResident(handle);
   if(own==0||own>ws)throw new Exception("Invalid private working set counter.");
   return new Row { IDProcess=id,WorkingSet=ws,WorkingSetPrivate=own,PrivateBytes=c.PrivateUsage.ToUInt64() };
  } finally { CloseHandle(handle); }
 }
}
'@
$rows=@(@(${pids.join(',')}) | ForEach-Object { [OpenCodeMemory]::Read($_) }); ConvertTo-Json -InputObject $rows -Compress`;
export async function processMemory(pids) {
  if (!pids.length || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Expected owned process IDs.');
  if (process.platform === 'win32') {
    const script = process.env.OPENCODE_PROXY_MEMORY_METHOD==='psapi'?psapi(pids):'$selectedIds=@(' + pids.join(',') + '); $rows=@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $selectedIds -contains $_.IDProcess } | Select-Object IDProcess,WorkingSet,WorkingSetPrivate,PrivateBytes); ConvertTo-Json -InputObject $rows -Compress';
    const {stdout} = await run('powershell.exe',['-NoProfile','-Command',script],{
      windowsHide:true,timeout:30000,cwd:os.tmpdir(),
      env:{...process.env,PSModuleAnalysisCachePath:path.join(os.tmpdir(),'opencode-proxy-memory-module-cache')},
    });
    const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));
    if(rows.length!==pids.length)throw new Error('Process memory counters did not include every owned process.');
    return {workingSetBytes:rows.reduce((n,r)=>n+Number(r.WorkingSet),0),privateResidentBytes:rows.reduce((n,r)=>n+Number(r.WorkingSetPrivate),0),privateCommittedBytes:rows.reduce((n,r)=>n+Number(r.PrivateBytes),0)};
  }
  if (process.platform === 'linux') {
    const rows=await Promise.all(pids.map(async pid=>{
      const raw=await readFile('/proc/'+pid+'/smaps_rollup','utf8');
      const kb=key=>Number(new RegExp('^'+key+':\\s+(\\d+)','m').exec(raw)?.[1]??0)*1024;
      return {workingSetBytes:kb('Rss'),privateResidentBytes:kb('Private_Clean')+kb('Private_Dirty')};
    }));
    return {workingSetBytes:rows.reduce((n,r)=>n+r.workingSetBytes,0),privateResidentBytes:rows.reduce((n,r)=>n+r.privateResidentBytes,0),privateCommittedBytes:null};
  }
  throw new Error('Memory comparison supports Windows and Linux.');
}
