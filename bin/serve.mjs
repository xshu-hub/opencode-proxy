#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { OpenCodeBridge, normalizeConfig } from '../lib/bridge.mjs';
import { createProxyServer } from '../lib/http-server.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(flag+' needs a value.');
  return args[index + 1];
};
if (args.includes('--help')) {
  console.log('Usage: opencode-proxy [--config config.json] [--port 8787] [--host 127.0.0.1] [--opencode /path/to/executable] [--working-directory /path/to/workspace]\nSet OPENCODE_PROXY_API_KEY for client authentication. Uses global OpenCode configuration and login by default.');
  process.exit(0);
}
const configFile = path.resolve(value('--config', 'config.json'));
const content = await readFile(configFile,'utf8').catch(error => {
  if(error.code==='ENOENT' && !args.includes('--config')) return '{"mode":"global"}';
  throw error;
});
const config = normalizeConfig(JSON.parse(content.replace(/^\uFEFF/,'')),path.dirname(configFile));
if(args.includes('--opencode')) config.command=[path.resolve(value('--opencode'))];
if(args.includes('--working-directory')) config.workingDirectory=path.resolve(value('--working-directory'));
const port=Number(value('--port','8787'));
if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port.');
const host=value('--host','127.0.0.1');
const apiKey=process.env.OPENCODE_PROXY_API_KEY ?? process.env.BRIDGE_API_KEY;
if(!apiKey)throw new Error('Set OPENCODE_PROXY_API_KEY before starting the server.');
const bridge=new OpenCodeBridge(config);
const server=createProxyServer({bridge,apiKey});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
console.log('OpenCode proxy listening on http://'+host+':'+server.address().port+'/v1');
void bridge.prewarm().catch(()=>{if(config.diagnostics)console.error('[opencode-proxy] Worker prewarm failed.');});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{void server.shutdown();});
