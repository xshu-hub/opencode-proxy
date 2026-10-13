import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {timingSafeEqual,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ApiError} from './protocol.mjs';

export function createAdminServer({runtime,token=randomBytes(32).toString('hex'),assets=path.resolve(fileURLToPath(new URL('../frontend/dist/',import.meta.url))),shutdown}){
  const equal=(a,b)=>{const x=Buffer.from(a??''),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
  const server=http.createServer(async(req,res)=>{
    const respond=(status,data)=>res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}).end(JSON.stringify(data));
    try{
      const address=server.address();
      const hosts=new Set(['127.0.0.1:'+address.port,'localhost:'+address.port,'[::1]:'+address.port]);
      if(!hosts.has(req.headers.host)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return respond(403,{error:{message:'管理界面仅允许本机访问。',code:'local_admin_only'}});
      if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host)return respond(403,{error:{message:'管理请求来源无效。',code:'invalid_origin'}});
      const url=new URL(req.url,'http://'+req.headers.host),endpoint=url.pathname;
      if(endpoint.startsWith('/admin/')){
        if(!equal(req.headers.authorization,'Bearer '+token))return respond(401,{error:{message:'管理会话无效，请刷新页面。',code:'admin_unauthorized'}});
        let input={};
        if(req.method==='POST'){
          let text='',size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw new ApiError('管理请求过大。',413);text+=chunk;}
          try{input=text?JSON.parse(text):{};}catch{throw new ApiError('JSON 格式错误。',400);}
        }
        if(endpoint==='/admin/state'&&req.method==='GET')return respond(200,runtime.state());
        if(endpoint==='/admin/models'&&req.method==='GET')return respond(200,{models:await runtime.models()});
        if(endpoint.startsWith('/admin/request/')&&req.method==='GET')return respond(200,await runtime.requests.detail(endpoint.slice('/admin/request/'.length)));
        if(endpoint==='/admin/config'&&req.method==='POST')return respond(200,await runtime.save(input));
        if(endpoint==='/admin/refresh'&&req.method==='POST')return respond(200,{models:await runtime.refresh()});
        if(endpoint==='/admin/start'&&req.method==='POST'){await runtime.startGateway();return respond(200,runtime.state());}
        if(endpoint==='/admin/stop'&&req.method==='POST'){await runtime.stopGateway();return respond(200,runtime.state());}
        if(endpoint==='/admin/test'&&req.method==='POST'){
          if(typeof input.model!=='string'||typeof input.prompt!=='string'||input.prompt.length>4000)throw new ApiError('请选择模型并输入不超过 4000 字的测试内容。',400);
          const response=await runtime.fetch('http://proxy/v1/chat/completions',{method:'POST',body:JSON.stringify({model:input.model,messages:[{role:'user',content:input.prompt}],stream:false})},undefined,{name:'管理页面测试'});
          return respond(response.status,await response.json());
        }
        if(endpoint==='/admin/shutdown'&&req.method==='POST'&&shutdown){respond(200,{ok:true});setTimeout(()=>{void shutdown();},20);return;}
        return respond(404,{error:{message:'未知管理接口。',code:'not_found'}});
      }
      if(req.method!=='GET')return respond(405,{error:{message:'请求方法不支持。'}});
      const relative=endpoint==='/'?'index.html':decodeURIComponent(endpoint).slice(1);
      const file=path.resolve(assets,relative);
      if(file!==path.join(assets,'index.html')&&!file.startsWith(path.resolve(assets)+path.sep))return respond(404,{error:{message:'文件不存在。'}});
      let bytes=await readFile(file).catch(()=>{throw new ApiError('管理页面资源不存在，请先构建前端。',404);});
      if(relative==='index.html')bytes=Buffer.from(bytes.toString('utf8').replace('__ADMIN_TOKEN__',token));
      const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
      res.writeHead(200,{'content-type':types[path.extname(file)]??'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"});res.end(bytes);
    }catch(error){respond(error.status??500,{error:{message:error instanceof ApiError?error.message:'管理操作失败，请检查配置或端口。',code:error.code??'admin_error'}});}
  });
  return {server,token};
}
