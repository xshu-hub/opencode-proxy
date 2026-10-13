import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const frontend=path.resolve(import.meta.dirname,'../frontend');
for(const f of ['app.js','proxy-adapter.js','caller-keys.js','boot.js']){const result=spawnSync(process.execPath,['--check',path.join(frontend,'public',f)],{stdio:'inherit'});if(result.status!==0)process.exit(result.status);}
const output=path.join(frontend,'dist');
// Fixed build-owned directory; it contains no user configuration.
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
for(const file of ['app.js','app.css','i18n.js','caller-keys.js','purposes.js','compat.js','layout.js','fonts.js','theme.js','omarchy.js','omarchy.css','library.css','proxy.css','proxy-adapter.js','boot.js','SOURCE.json'])await cp(path.join(frontend,'public',file),path.join(output,file));
await mkdir(path.join(output,'icons'),{recursive:true});
for(const icon of ['favicon.svg','opencode.svg'])await cp(path.join(frontend,'public/icons',icon),path.join(output,'icons',icon));
await writeFile(path.join(output,'index.html'),await readFile(path.join(frontend,'index.html')));
console.log('Built the Magpie-derived OpenCode Proxy frontend.');
