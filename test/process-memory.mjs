import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
export async function processMemory(pids) {
  if (!pids.length || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Expected owned process IDs.');
  if (process.platform === 'win32') {
    const script = '$selectedIds=@(' + pids.join(',') + '); $rows=@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $selectedIds -contains $_.IDProcess } | Select-Object IDProcess,WorkingSet,WorkingSetPrivate,PrivateBytes); ConvertTo-Json -InputObject $rows -Compress';
    const {stdout} = await run('powershell.exe',['-NoProfile','-Command',script],{
      windowsHide:true,timeout:10000,cwd:os.tmpdir(),
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
