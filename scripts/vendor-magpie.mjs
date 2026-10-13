// Import the actual Magpie frontend, never build Magpie. All edits below are
// checked against the pinned source so an upstream change cannot silently drift.
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=process.argv[2];if(!root)throw Error('Pass the Magpie checkout path.');
const source=path.join(root,'internal/gui/assets'),dest='frontend/public';
await mkdir(dest,{recursive:true});
const files=['app.js','app.css','index.html','i18n.js','caller-keys.js','purposes.js','compat.js','layout.js','fonts.js','theme.js','omarchy.js','omarchy.css','library.css'];
const hashes={};
for(const file of files){const bytes=await readFile(path.join(source,file));hashes[file]=createHash('sha256').update(bytes).digest('hex');if(file!=='index.html')await writeFile(path.join(dest,file),bytes);}
await mkdir(path.join(dest,'icons'),{recursive:true});
for(const icon of ['favicon.svg','opencode.svg'])await cp(path.join(source,'icons',icon),path.join(dest,'icons',icon));
let app=(await readFile(path.join(dest,'app.js'),'utf8')).replaceAll('\r\n','\n');
function edit(from,to){if(!app.includes(from))throw Error('Magpie source changed: '+from.slice(0,80));app=app.replace(from,to);}
edit('const USAGE_TABS = [["usage", "Overview"], ["requests", "Requests"], ["sessions", "Sessions"], ["context", "Context"]];','const USAGE_TABS = [["usage", "Overview"], ["requests", "Requests"]];');
edit('$("#view-" + id).hidden = v !== id;','if ($("#view-" + id)) $("#view-" + id).hidden = v !== id;');
edit('draft.chosen.length || decideOnly(p) || draft.unlisted ? new Set()','true ? new Set()');
edit('const ids = draft.chosen.length ? draft.chosen : p.models.filter((m) => m.on).map((m) => m.id);\n    if (!ids.length)', 'const ids = p.models.map((m) => m.id);\n    if (!ids.length)');
edit('row.append(who);\n      // the model of other providers', 'row.append(who);\n      row.append(proxyModelParameters(m));\n      // the model of other providers');
edit('row.append(sameBox);','// No Magpie grouping override.');
edit('row.append(priceBox);','// Prices are not reported by this OpenCode adapter.');
edit('row.append(img);','// Image capability is inherited from OpenCode.');
edit('names.append(sfx);','// Exported IDs are always short aliases.');
edit('if (levels.length > 1) {\n        const lv','if (false) {\n        const lv');
edit('foot.append(add, addOne, refresh);','foot.append(refresh);');
edit('p.off ? icon(p.icon || "generic") : providerHandle(p, row)','icon(p.icon || "generic")');
edit('if (p.account && lapsed) {\n      key', 'if (p.openCode) { key = el("span", "key on acct", "全局配置"); key.title = "复用全局 OpenCode 登录与供应商配置"; } else if (p.account && lapsed) {\n      key');
edit('prefs[id] = {};\n        if (draft.priceTyped)', 'prefs[id] = {};\n        proxyResetModel(m);\n        if (draft.priceTyped)');
edit('if (!decideOnly(p)) box.append(tk);','// Routing groups are not exposed by this independent proxy.');
edit('if (!remote) options.unshift({ v: "", name: "This computer", note: t("Any key · no key attribution") });','// Every OpenCode Proxy request requires an enabled key, including localhost.');
edit('if (remote && !connectKeyID && keys.length)', 'if (!connectKeyID && keys.length)');
edit('const id = `${c.time}|${c.agent}|${c.model}`;', 'const id = c.id || `${c.time}|${c.agent}|${c.model}`;');
edit('else if (p.models.length) foot.append(el("span", "hint", t(p.account ? "magpie\'s list · Refresh asks the vendor" : decideOnly(p) ? "Jev\'s names · Refresh asks the vendor" : "from models.dev · Refresh asks the vendor")));','else if (p.models.length) foot.append(el("span", "hint", "全局 OpenCode 模型列表"));');
const boot=app.lastIndexOf('if (mode === "window" && ["providers", "gateway", "routing", "usage", "sessions", "library", "plugins", "settings"].includes');
if(boot<0)throw Error('Magpie boot marker changed');app=app.slice(0,boot);
await writeFile(path.join(dest,'app.js'),app);
let html=(await readFile(path.join(source,'index.html'),'utf8')).replace('<title>magpie</title>','<title>OpenCode Proxy</title>').replace('<head>','<head>\n<meta name="admin-token" content="__ADMIN_TOKEN__">');
html=html.replace('<link rel="stylesheet" href="routing.css">','').replace(/<link rel="stylesheet" href="(?:plugins|sessions|context)\.css">/g,'');
html=html.replace(/<script src="(?:routing|library|plugins|sessions|context)\.js"><\/script>/g,'');
html=html.replace('</head>','<link rel="stylesheet" href="proxy.css">\n</head>').replace('</body>','<script src="proxy-adapter.js"></script>\n</body>');
html=html.replace('Create a gateway key for each client. Usage is counted separately for each key.','为不同客户端配置独立访问密钥。所有接口均需提供已启用的 Key。').replace('Daily usage over the last 53 weeks','最近保留请求的每日用量');
await writeFile('frontend/index.html',html);
await writeFile(path.join(dest,'SOURCE.json'),JSON.stringify({repository:'https://github.com/yetone/magpie',commit:'210234a5f33e0f2643f82b4337e249cf0fe81371',license:'MIT',files:hashes,base:'Full index.html, app.js, i18n.js, caller-keys.js and styles; renderer overrides live in proxy-adapter.js. Non-proxy views are pruned after original event initialization.',patches:'See scripts/vendor-magpie.mjs; checked substitutions preserve original provider/model/gateway/usage/ledger/modal/menu rendering.'},null,2)+'\n');
