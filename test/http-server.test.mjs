import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProxyServer} from '../lib/http-server.mjs';

async function fixture(bridge,run) {
  const server=createProxyServer({bridge,apiKey:'fixture-client-key'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {await run('http://127.0.0.1:'+server.address().port);}
  finally {await server.shutdown();}
}
const auth={authorization:'Bearer fixture-client-key'};

test('browser preflight allows SDK headers while actual requests still require a key',async()=>{
  let calls=0;
  await fixture({close:async()=>{},fetch:async()=>{calls++;return Response.json({ok:true});}},async base=>{
    const response=await fetch(base+'/v1/messages',{method:'OPTIONS',headers:{origin:'http://localhost:3000','access-control-request-method':'POST','access-control-request-headers':'content-type,x-api-key,anthropic-version,x-stainless-lang'}});
    assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),'*');assert.match(response.headers.get('access-control-allow-headers'),/x-stainless-lang/);assert.equal(calls,0);
    const rejected=await fetch(base+'/v1/messages',{method:'POST',headers:{origin:'http://localhost:3000'},body:'{}'});assert.equal(rejected.status,401);assert.equal(rejected.headers.get('access-control-allow-origin'),'*');await rejected.text();assert.equal(calls,0);
    const accepted=await fetch(base+'/v1/messages',{method:'POST',headers:{origin:'http://localhost:3000','x-api-key':'fixture-client-key'},body:'{}'});assert.equal(accepted.status,200);await accepted.text();assert.equal(calls,1);assert.equal(accepted.headers.get('access-control-allow-credentials'),null);
  });
});

test('x-api-key authenticates model discovery and never overrides a supplied invalid Bearer key',async()=>{
  let calls=0;
  await fixture({close:async()=>{},fetch:async()=>{calls++;return Response.json({});}},async base=>{
    const response=await fetch(base+'/v1/models',{headers:{'x-api-key':'fixture-client-key'}});assert.equal(response.status,200);await response.text();assert.equal(calls,1);
    for(const headers of [{'x-api-key':'wrong-key'},{'x-api-key':'fixture-client-key',authorization:'Bearer wrong-key'}]){
      const rejected=await fetch(base+'/v1/models',{headers});assert.equal(rejected.status,401);assert.equal((await rejected.json()).error.type,'authentication_error');
    }
    assert.equal(calls,1);
  });
});
test('HTTP authentication rejects requests before reaching OpenCode',async()=>{
  let calls=0;
  await fixture({close:async()=>{},fetch:async()=>{calls++;return Response.json({});}},async base=>{
    for(const authorization of [undefined,'Bearer wrong-key']){
      const response=await fetch(base+'/v1/models',{headers:authorization?{authorization}:{}});
      assert.equal(response.status,401);assert.equal((await response.json()).error.code,'invalid_api_key');
    }
    assert.equal(calls,0);
    assert.equal((await fetch(base+'/v1/models',{headers:auth})).status,200);
    assert.equal(calls,1);
  });
});
test('HTTP transport preserves request fields, model JSON, SSE boundaries and response diagnostics',async()=>{
  const seen=[];
  const sse='data: {"choices":[{"delta":{"content":"你好😀"}}]}\n\ndata: [DONE]\n\n';
  await fixture({close:async()=>{},fetch:async(url,init)=>{
    seen.push({url,init});
    return init.method==='GET'?Response.json({object:'list',data:[{id:'pure-model-name'}]}):new Response(sse,{headers:{'content-type':'text/event-stream','x-opencode-request-id':'fixture-id'}});
  }},async base=>{
    const models=await (await fetch(base+'/v1/models',{headers:auth})).json();assert.equal(models.data[0].id,'pure-model-name');
    const body={model:'pure-model-name',messages:[{role:'user',content:'hello'}],stream:true,reasoning_effort:'high',tools:[{type:'function',function:{name:'weather',parameters:{type:'object'}}}]};
    const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:auth,body:JSON.stringify(body)});
    assert.equal(response.headers.get('x-opencode-request-id'),'fixture-id');assert.equal(await response.text(),sse);
    assert.deepEqual(JSON.parse(seen[1].init.body),body);
  });
});
test('HTTP client cancellation aborts the request and releases the stream',async()=>{
  let signal, released=false;
  await fixture({close:async()=>{},fetch:async(_url,init)=>{
    signal=init.signal;
    return new Response(new ReadableStream({start(c){
      c.enqueue(new TextEncoder().encode('data: first\n\n'));
      signal.addEventListener('abort',()=>{released=true;c.error(new Error('cancelled'));},{once:true});
    },cancel(){released=true;}}));
  }},async base=>{
    const controller=new AbortController();
    const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:auth,body:'{}',signal:controller.signal});
    const reader=response.body.getReader();await reader.read();controller.abort();
    await reader.cancel().catch(()=>{});
    const deadline=Date.now()+2000;
    while(!signal.aborted&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert.equal(signal.aborted,true);
  });
  assert.equal(released,true);
});
