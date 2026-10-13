#!/usr/bin/env node
import path from 'node:path';
import {stat} from 'node:fs/promises';
import {defaultConfigFile,readSettings} from '../lib/settings.mjs';
import {ProxyRuntime} from '../lib/runtime.mjs';
import {createAdminServer} from '../lib/admin-server.mjs';

const args=process.argv.slice(2);
const value=(flag,fallback)=>{const index=args.indexOf(flag);if(index<0)return fallback;if(!args[index+1]||args[index+1].startsWith('--'))throw new Error(flag+' needs a value.');return args[index+1];};
if(args.includes('--help')){console.log('OpenCode Proxy\nUsage: opencode-proxy [--config file] [--port 8787] [--host 127.0.0.1] [--admin-port 8788] [--opencode executable] [--working-directory directory]\nManagement UI is local-only. Linux remote access: SSH port forwarding. OpenCode providers and login remain global.');process.exit(0);}
if(typeof Bun!=='undefined'){
  const resources=path.join(path.dirname(process.execPath),'resources');
  if(await stat(resources).then(s=>s.isDirectory(),()=>false))process.env.OPENCODE_PROXY_RESOURCES=resources;
}
const file=path.resolve(value('--config',defaultConfigFile()));
const overrides={};
if(args.includes('--port'))overrides.port=Number(value('--port'));
if(args.includes('--host'))overrides.host=value('--host');
if(args.includes('--opencode'))overrides.command=[path.resolve(value('--opencode'))];
if(args.includes('--working-directory'))overrides.workingDirectory=path.resolve(value('--working-directory'));
const settings=await readSettings(file,overrides);
const runtime=new ProxyRuntime({file,settings});await runtime.initialize();
const assets=process.env.OPENCODE_PROXY_RESOURCES?path.join(process.env.OPENCODE_PROXY_RESOURCES,'ui'):undefined;
let admin,closing,parentWatch;
const shutdown=()=>closing??=(async()=>{clearInterval(parentWatch);const stopped=new Promise(r=>admin.server.close(r));admin.server.closeAllConnections();await Promise.all([runtime.close(),stopped]);})();
admin=createAdminServer({runtime,token:process.env.OPENCODE_PROXY_ADMIN_KEY,assets,shutdown});
const port=Number(value('--admin-port',process.env.OPENCODE_PROXY_ADMIN_PORT??'8788'));
if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid management port.');
await new Promise((resolve,reject)=>{admin.server.once('error',reject);admin.server.listen(port,'127.0.0.1',resolve);});
try{await runtime.startGateway();}catch{console.error('[opencode-proxy] API port unavailable; correct it in the management UI.');}
console.log('OPENCODE_PROXY_READY '+JSON.stringify({adminURL:'http://127.0.0.1:'+admin.server.address().port,endpoint:runtime.state().endpoint,configFile:file}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void shutdown();});
const parent=Number(process.env.OPENCODE_PROXY_DESKTOP_PID);
if(parent>0){parentWatch=setInterval(()=>{try{process.kill(parent,0);}catch(error){if(error.code==='ESRCH')void shutdown();}},2000);parentWatch.unref?.();}
