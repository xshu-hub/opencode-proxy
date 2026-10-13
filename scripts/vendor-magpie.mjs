// Refresh the explicitly reused Magpie frontend source. Never build Magpie.
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=process.argv[2];if(!root)throw Error('Pass the Magpie checkout path.');
const dir=path.join(root,'internal/gui/assets'),dest='frontend/src/magpie';await mkdir(dest,{recursive:true});
const js=(await readFile(path.join(dir,'app.js'),'utf8')).replaceAll('\r\n','\n');
const extract=name=>{const start=js.indexOf('function '+name+'('),end=js.indexOf('\n}',start)+2;if(start<0||end<2)throw Error('Missing Magpie function: '+name);return js.slice(start,end);};
const names=['el','svg','effortName','effortStops','effortLit','effortIcon','effortBars','effortSeg','providerSwitch'];
let reused=names.map(extract).join('\n\n');
reused=reused.replace('state = await api("set", { agent: a.id, field: f.key, value: o.value });\n      effortSaid(a, f, o);','await a.commit(o.value);').replace('status(e.message, "err"); renderAgents();','a.failed(e);').replace('box.closest(".row")?.querySelector(".ag-sum .eff")?.replaceWith(effortBars(f));','');
reused=reused.replace('s.onclick = (e) => { e.stopPropagation(); switchProvider(p, !on, s); };','s.onclick = (e) => { e.stopPropagation(); p.commit(!on, s); };');
await writeFile(path.join(dest,'controls.js'),`/* Derived from Magpie app.js, MIT (c) 2026 yetone. Source: 210234a5f33e0f2643f82b4337e249cf0fe81371.\n * Original DOM/effort/pointer/keyboard controls; backend callbacks adapted. */\nconst t=(s,vars={})=>Object.entries(vars).reduce((v,[k,x])=>v.replaceAll('{'+k+'}',x),({default:'跟随 OpenCode',none:'关闭思考',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最高'}[s]??s));\nconst EFFORT_ORDER=['off','none','minimal','low','medium','high','xhigh','max'];\nconst optionFor=(f,value)=>(f.options??[]).find(o=>o.value===value);\n${reused}\nexport {${names.join(',')}};\n`);
await cp(path.join(dir,'app.css'),path.join(dest,'app.css'));
const lib=(await readFile(path.join(dir,'library.css'),'utf8')).replaceAll('\r\n','\n');
await writeFile(path.join(dest,'switch.css'),'/* Magpie library.css switches, MIT (c) 2026 yetone. */\n'+lib.split('\n').filter(l=>l.startsWith('.lib-switch ' )||l.startsWith('.lib-switch.on ')).join('\n')+'\n');
await cp(path.join(dir,'icons/opencode.svg'),path.join(dest,'opencode.svg'));
const files=['app.css','app.js','index.html','library.css'];
await writeFile(path.join(dest,'SOURCE.json'),JSON.stringify({repository:'https://github.com/xshu-hub/magpie',commit:'210234a5f33e0f2643f82b4337e249cf0fe81371',license:'MIT',files:Object.fromEntries(await Promise.all(files.map(async f=>[f,createHash('sha256').update(await readFile(path.join(dir,f))).digest('hex')]))),functions:names,adaptations:'Remove unrelated Magpie pages/runtime calls; keep CSS, DOM controls, effort logic; connect to OpenCode Proxy admin API.'},null,2)+'\n');
