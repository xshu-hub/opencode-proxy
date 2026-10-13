import {mkdir,cp,writeFile,readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const platform=process.argv[2]??(process.platform==='win32'?'windows':'linux');
if(!['windows','linux'].includes(platform))throw new Error('Unknown package platform.');
const dist=path.resolve('dist',platform);
await mkdir(path.join(dist,'resources','ui'),{recursive:true});
await cp('frontend/dist',path.join(dist,'resources','ui'),{recursive:true});
await cp('lib',path.join(dist,'resources'),{recursive:true});
await writeFile(path.join(dist,'resources','package.json'),JSON.stringify({type:'module'}));
for(const file of ['README.md','LICENSE','NOTICE.txt'])await cp(file,path.join(dist,file));
await cp('docs',path.join(dist,'docs'),{recursive:true});
const bun=process.env.BUN_EXECUTABLE??'bun';
const binary=path.join(dist,platform==='windows'?'opencode-proxy-server.exe':'opencode-proxy-server');
const compiled=spawnSync(bun,['build','bin/serve.mjs','--compile','--target=bun-'+platform+'-x64','--outfile',binary],{stdio:'inherit',windowsHide:true});
if(compiled.status!==0)throw new Error('Server executable build failed.');
if(platform==='windows'){
  await mkdir('desktop/ui',{recursive:true});await cp('frontend/dist','desktop/ui',{recursive:true});
  const go=process.env.GO_EXECUTABLE??'go';
  const build=spawnSync(go,['build','-mod=mod','-tags','production','-trimpath','-ldflags','-s -w -H windowsgui','-o',path.join(dist,'opencode-proxy.exe'),'.'],{cwd:'desktop',stdio:'inherit',windowsHide:true,env:{...process.env,CGO_ENABLED:'0'}});
  if(build.status!==0)throw new Error('Desktop executable build failed.');
}
const list=[];for(const entry of await readdir(dist,{recursive:true,withFileTypes:true}))if(entry.isFile()&&entry.name!=='SHA256SUMS'){const file=path.join(entry.parentPath??entry.path,entry.name);list.push(createHash('sha256').update(await readFile(file)).digest('hex')+'  '+path.relative(dist,file).replaceAll('\\','/'));}
await writeFile(path.join(dist,'SHA256SUMS'),list.sort().join('\n')+'\n');
console.log('Packaged '+platform+' at '+dist);
