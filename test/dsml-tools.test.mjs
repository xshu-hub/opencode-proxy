import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ToolTextRecovery} from '../lib/dsml-tools.mjs';
import {OpenCodeBridge} from '../lib/bridge.mjs';
import {nativeToolName,sseEvents,validateRequest} from '../lib/protocol.mjs';
import {toChatRequest,adaptResponse} from '../lib/outward-protocols.mjs';
import {nativeGeneration} from '../lib/generation.mjs';
import {toolCalls} from './tool-deltas.mjs';

const code='const g1 = await tools.grep({ pattern: "SessionRetry|Retry\\.policy|retryable\\(", path: "packages/opencode/src", include: "*.ts" })\nconsole.log(g1.matches.map(m=>m.path+":"+m.lineNumber+": "+m.line).join("\\n"))';
const description='Find retry policy usage sites';
const parameters={type:'object',properties:{code:{type:'string'},description:{type:'string'}},required:['code','description'],additionalProperties:false};
const name='run_code',native=nativeToolName(name);
const definitions=[{name:native,parameters}];
const batch=(tool=native,values={code,description},token='｜｜DSML｜｜',root='calls')=>`<${token} ${root}> ${Object.entries(values).length?`<${token} invoke name="${tool}"> ${Object.entries(values).map(([name,value])=>`<${token} parameter name="${name}" string="${typeof value==='string'}">${typeof value==='string'?value:JSON.stringify(value)}</${token} parameter>`).join(' ')} </${token} invoke>`:''} </${token} ${root}>`;
const sample=batch();

test('DSH DSML preserves code literally across every streaming split and canonical dialects',()=>{
  for(const token of ['｜DSML｜','｜｜DSML｜｜','|DSML|','||DSML||'])for(const root of ['calls','tool_calls','function_calls']){
    const text=batch(native,{code,description},token,root);
    for(let split=0;split<=text.length;split++){
      const recovery=new ToolTextRecovery(definitions);
      assert.equal(recovery.push(text.slice(0,split)),'');assert.equal(recovery.push(text.slice(split)),'');
      const calls=recovery.finish().calls;assert.equal(calls.length,1);assert.equal(calls[0].name,native);assert.deepEqual({...calls[0].input},{code,description});
    }
  }
});

test('DSML values preserve types, raw whitespace and prototype keys without executing or decoding text',()=>{
  const values=JSON.parse('{"text":"  &lt;tag&gt;\\n  ","object":{"count":3},"array":[1,false],"count":2,"flag":true,"empty":null,"__proto__":{"polluted":true}}');
  const recovery=new ToolTextRecovery([{name:native,parameters:{type:'object'}}]);
  for(const char of batch(native,values,'｜DSML｜','tool_calls').replaceAll('｜DSML｜ ','｜DSML｜'))recovery.push(char);
  assert.deepEqual(JSON.parse(JSON.stringify(recovery.finish().calls[0].input)),values);assert.equal({}.polluted,undefined);
});

test('DSML rejects truncated, unknown, duplicate, invalid, mixed and oversized call batches atomically',()=>{
  const bad=[sample.slice(0,-20),sample.replace(native,'bridge_unknown'),sample.replace('string="true"','string="false"'),sample.replace('</｜｜DSML｜｜ invoke>',`<｜｜DSML｜｜ parameter name="code" string="true">duplicate</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>`),batch(native,{code:7,description}),batch(native,{code}),batch(native,{code,description,extra:true}),sample+' ordinary tail',sample.replace(' calls>',' unsupported>'),sample.replace(/<｜｜DSML｜｜ invoke.*<\/｜｜DSML｜｜ invoke>/s,'')];
  for(const text of bad){const recovery=new ToolTextRecovery(definitions);recovery.push(text);assert.throws(()=>recovery.finish(),e=>e.status===502);}
  assert.throws(()=>new ToolTextRecovery(definitions,{limit:20}).push(sample),e=>e.status===502);
  const invoke=sample.slice(sample.indexOf('<｜｜DSML｜｜ invoke'),sample.indexOf('</｜｜DSML｜｜ invoke>')+'</｜｜DSML｜｜ invoke>'.length);
  const tooMany=new ToolTextRecovery(definitions);tooMany.push('<｜｜DSML｜｜ calls>'+invoke.repeat(129)+'</｜｜DSML｜｜ calls>');assert.throws(()=>tooMany.finish(),e=>e.status===502);
});

test('normal text, fenced examples, embedded markup and unavailable tools remain text',()=>{
  for(const text of ['ordinary text','<html>hello</html>','```xml\n'+sample+'\n```','Example: '+sample,'<','   ']){
    const recovery=new ToolTextRecovery(definitions);let output='';for(const char of text)output+=recovery.push(char);output+=recovery.finish().text??'';assert.equal(output,text);
  }
  const none=new ToolTextRecovery([]);assert.equal(none.push(sample),sample);assert.equal(none.finish().text,'');
  assert.equal(new ToolTextRecovery(definitions).push('Hello'),'Hello');
});

test('parallel DSML calls are all validated before any call can be returned', () => {
  const invoke = sample.slice(
    sample.indexOf('<｜｜DSML｜｜ invoke'),
    sample.indexOf('</｜｜DSML｜｜ invoke>') + '</｜｜DSML｜｜ invoke>'.length
  );
  const recovery = new ToolTextRecovery(definitions);
  recovery.push('<｜｜DSML｜｜ calls>' + invoke + invoke + '</｜｜DSML｜｜ calls>');
  assert.equal(recovery.finish().calls.length, 2);
  const invalid = new ToolTextRecovery(definitions);
  invalid.push('<｜｜DSML｜｜ calls>' + invoke + invoke.replace(native, 'unknown') + '</｜｜DSML｜｜ calls>');
  assert.throws(
    () => invalid.finish(),
    (e) => e.status === 502
  );
});

const introduction = "I'll start by exploring the directory to understand what rule set files we're working with.\n\n";
const command =
  String.raw`Get-ChildItem -LiteralPath 'D:\f30079819\Downloads\规则集' -Recurse | Select-Object FullName, Length, Extension` +
  ' | Format-Table -AutoSize';
const shellParameters = {
  type: 'object',
  properties: { command: { type: 'string' }, description: { type: 'string' } },
  required: ['command', 'description'],
  additionalProperties: false
};
const shellTool = { type: 'function', function: { name: 'pwsh', parameters: shellParameters } };
const withAliases = [...definitions, { name: nativeToolName('pwsh'), aliases: ['pwsh'], parameters: shellParameters }];
const invocation = (text) =>
  text.slice(
    text.indexOf('<｜｜DSML｜｜ invoke'),
    text.indexOf('</｜｜DSML｜｜ invoke>') + '</｜｜DSML｜｜ invoke>'.length
  );
const parallel =
  '<｜｜DSML｜｜ calls>' +
  invocation(batch('pwsh', { command, description: 'List files in the rule set directory' })) +
  invocation(sample) +
  '</｜｜DSML｜｜ calls>';

test('prefixed DSML streams prose immediately and recovers every split/dialect without leaking markup', () => {
  for (const prefix of [
    introduction,
    '我先检查规则集目录。🙂\r\n\r\n',
    'I will inspect sample files and syntax definitions.\n',
    '我先检查格式和语法，再读取示例文件。\n',
    "I'll read `example.json` before calling the tool.\n",
    '“规则集”目录需要检查。\n',
    "'规则集' directory needs inspection.\n"
  ])
    for (const token of ['｜DSML｜', '｜｜DSML｜｜', '|DSML|', '||DSML||'])
      for (const root of ['calls', 'tool_calls', 'function_calls']) {
        const text = prefix + batch(native, { code, description }, token, root);
        for (let split = 0; split <= text.length; split++) {
          const recovery = new ToolTextRecovery(definitions),
            output = recovery.push(text.slice(0, split)) + recovery.push(text.slice(split)),
            result = recovery.finish();
          assert.equal(output, prefix);
          assert.equal(result.calls.length, 1);
          assert.deepEqual({ ...result.calls[0].input }, { code, description });
        }
      }
  const live = new ToolTextRecovery(withAliases);
  assert.equal(live.push(introduction), introduction, 'No waiting for a future DSML batch');
  for (const char of parallel) assert.equal(live.push(char), '');
  assert.deepEqual(
    live.finish().calls.map((c) => c.name),
    [nativeToolName('pwsh'), native]
  );
});

test('only declared aliases resolve to canonical tools; collisions and unknown names never become calls', () => {
  const recovery = new ToolTextRecovery(withAliases);
  assert.equal(recovery.push(introduction + parallel), introduction);
  const calls = recovery.finish().calls;
  assert.equal(calls[0].input.command, command);
  assert.equal(calls[1].input.code, code);
  const missing = new ToolTextRecovery(definitions);
  missing.push(introduction + parallel);
  assert.throws(
    () => missing.finish(),
    (e) => e.code === 'unregistered_tool'
  );
  for (const definitions of [
    [
      { name: 'a', aliases: ['shared'] },
      { name: 'b', aliases: ['shared'] }
    ],
    [{ name: 'a', aliases: ['b'] }, { name: 'b' }],
    [
      { name: 'a', aliases: ['b'] },
      { name: 'b', aliases: ['a'] }
    ]
  ]) {
    const ambiguous = new ToolTextRecovery(definitions);
    ambiguous.push(introduction + batch(definitions[0].aliases[0], { x: 1 }));
    assert.throws(
      () => ambiguous.finish(),
      (e) => e.code === 'unregistered_tool'
    );
  }
});

test('prefixed invalid parallel batches fail atomically, including truncation, tails and second batches', () => {
  for (const text of [
    parallel.slice(0, -12),
    parallel.replace(native, 'unknown'),
    parallel.replace('string="true"', 'string="false"'),
    parallel + ' trailing prose',
    parallel + sample
  ]) {
    const recovery = new ToolTextRecovery(withAliases);
    assert.equal(recovery.push(introduction + text), introduction);
    assert.throws(
      () => recovery.finish(),
      (e) => e.status === 502
    );
  }
  const bytes = Buffer.byteLength(parallel),
    exact = new ToolTextRecovery(withAliases, { limit: bytes });
  assert.equal(exact.push(introduction + parallel), introduction);
  assert.equal(exact.finish().calls.length, 2);
  const limited = new ToolTextRecovery(withAliases, { limit: bytes - 1 });
  assert.throws(
    () => limited.push(introduction + parallel),
    (e) => e.code === 'invalid_dsml_tool_call'
  );
  const maximum = new ToolTextRecovery(definitions);
  maximum.push(introduction + '<｜｜DSML｜｜ calls>' + invocation(sample).repeat(128) + '</｜｜DSML｜｜ calls>');
  assert.equal(maximum.finish().calls.length, 128);
  const many = '<｜｜DSML｜｜ calls>' + invocation(sample).repeat(129) + '</｜｜DSML｜｜ calls>',
    recovery = new ToolTextRecovery(definitions);
  recovery.push(introduction + many);
  assert.throws(
    () => recovery.finish(),
    (e) => e.status === 502
  );
});

test('Markdown examples, quotes, indentation and illustrative prose never trigger calls at any split', () => {
  const examples = [
    introduction + '```xml\n' + sample + '\n```',
    introduction + '~~~xml\n' + sample + '\n~~~',
    '````xml\n```\n' + sample + '\n````',
    '   ```xml\r\n' + sample + '\r\n   ```',
    introduction + '    ' + sample,
    introduction + '\t' + sample,
    introduction + '> ' + sample,
    '> Quoted tool syntax\n' + sample,
    'Here is an example:\n\n' + sample,
    'Examples of tools\nwith a wrapped description:\n' + sample,
    '下面是调用示例：\n' + sample,
    "Don't execute this:\n" + sample,
    'The literal syntax is:\n' + sample,
    introduction + '`' + sample + '`',
    'Inline explanation: ' + sample,
    'A quoted value: `\n' + sample + '\n`',
    'A quoted value: ``\n' + sample + '\n``',
    '<blockquote>\n' + sample + '\n</blockquote>',
    '<pre>\n' + sample + '\n</pre>',
    '"\n' + sample + '\n"'
  ];
  for (const text of examples)
    for (let split = 0; split <= text.length; split++) {
      const recovery = new ToolTextRecovery(definitions),
        output = recovery.push(text.slice(0, split)) + recovery.push(text.slice(split)),
        result = recovery.finish();
      assert.equal(output + (result.text ?? ''), text);
      assert.equal(result.calls, undefined);
    }
  const recovery = new ToolTextRecovery(definitions),
    prefix = '```xml\n' + sample + '\n```\n\nI will now inspect the files.\n';
  assert.equal(recovery.push(prefix + sample), prefix);
  assert.equal(recovery.finish().calls.length, 1, 'Only the actual batch outside the closed code fence is recovered');
});

test('long ordinary prose remains streamable and unavailable tools remain literal', () => {
  const text = 'A long ordinary response. '.repeat(50000) + '\n',
    recovery = new ToolTextRecovery(definitions, { limit: 100 });
  assert.equal(recovery.push(text), text);
  assert.equal(recovery.finish().text, '');
  const boundary = new ToolTextRecovery(definitions),
    allowed = 'A'.repeat(4096) + '\n';
  assert.equal(boundary.push(allowed + sample), allowed);
  assert.equal(boundary.finish().calls.length, 1);
  for (const prefix of ['A'.repeat(4097) + '\n', '`'.repeat(4097) + '\n```\nI will inspect the files.\n']) {
    const conservative = new ToolTextRecovery(definitions);
    assert.equal(conservative.push(prefix + sample), prefix + sample);
    assert.equal(conservative.finish().calls, undefined);
  }
  const disabled = new ToolTextRecovery([]);
  assert.equal(disabled.push(introduction + parallel), introduction + parallel);
  assert.equal(disabled.finish().text, '');
});

function simulatedBridge({
  text = sample,
  reason = 'stop',
  reasoning = false,
  nativeCall = false,
  streamError = false,
  beforeBatch
} = {}) {
  const bridge = new OpenCodeBridge({ mode: 'global', discoverModels: false });
  bridge.prepare = async (body) => {
    validateRequest(body, { 'oc-default': { output: 4096 } });
    return {
      sessionID: 's',
      signal: new AbortController().signal,
      cleanup: async () => {},
      abort: async () => {},
      events: (async function* () {
        yield { type: 'message.updated', properties: { info: { id: 'm', sessionID: 's', role: 'assistant' } } };
        if (reasoning)
          yield {
            type: 'message.part.updated',
            properties: { part: { id: 'r', sessionID: 's', messageID: 'm', type: 'reasoning', text: 'thinking' } }
          };
        yield {
          type: 'message.part.updated',
          properties: { part: { id: 'p', sessionID: 's', messageID: 'm', type: 'text', text: '' } }
        };
        let offset = 0;
        for (const delta of text) {
          if (beforeBatch && offset === introduction.length) await beforeBatch;
          yield {
            type: 'message.part.delta',
            properties: { sessionID: 's', messageID: 'm', partID: 'p', field: 'text', delta }
          };
          offset += delta.length;
        }
        // Final snapshots must not duplicate streamed deltas.
        yield {
          type: 'message.part.updated',
          properties: { part: { id: 'p', sessionID: 's', messageID: 'm', type: 'text', text } }
        };
        if (streamError) throw new Error('Disconnected during the DSML batch');
        if (nativeCall)
          yield {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 't',
                sessionID: 's',
                messageID: 'm',
                type: 'tool',
                tool: native,
                callID: 'native-call',
                state: { status: 'running', input: { code, description } }
              }
            }
          };
        yield {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'f',
              sessionID: 's',
              messageID: 'm',
              type: 'step-finish',
              reason,
              tokens: { input: 10, output: 5 }
            }
          }
        };
      })()
    };
  };
  return bridge;
}
const tool = { type: 'function', function: { name, parameters } };
const send = async (bridge, body) =>
  bridge.fetch('http://bridge/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'oc-default',
      messages: [{ role: 'user', content: 'Find retry policy usage sites' }],
      tools: [tool],
      ...body
    })
  });

for (const protocol of ['chat', 'responses', 'anthropic'])
  for (const stream of [false, true])
    test(`${protocol} DSML becomes standard calls and the client can return tool results (stream=${stream})`, async () => {
      const bridge = simulatedBridge(),
        client = {
          model: 'oc-default',
          stream,
          ...(protocol === 'responses'
            ? { input: 'Find retry policy usage sites', store: false, tools: [{ type: 'function', name, parameters }] }
            : {
                messages: [{ role: 'user', content: 'Find retry policy usage sites' }],
                tools: protocol === 'chat' ? [tool] : [{ name, input_schema: parameters }],
                ...(protocol === 'anthropic' ? { max_tokens: 100 } : {})
              })
        };
      const chat = toChatRequest(protocol, client),
        reply = await adaptResponse(protocol, await send(bridge, chat), client);
      assert.equal(reply.status, 200);
      const events = stream ? await Array.fromAsync(sseEvents(reply.body)) : [],
        result = stream ? undefined : await reply.json();
      let call, continuation;
      if (protocol === 'chat') {
        const message = stream
          ? {
              role: 'assistant',
              content: null,
              tool_calls: events.flatMap((e) => e.choices?.[0]?.delta.tool_calls ?? []).map(({ index, ...c }) => c)
            }
          : result.choices[0].message;
        assert.equal(
          stream
            ? events.find((e) => e.choices?.[0]?.finish_reason)?.choices[0].finish_reason
            : result.choices[0].finish_reason,
          'tool_calls'
        );
        call = message.tool_calls[0];
        assert.equal(call.function.name, name);
        assert.equal(JSON.parse(call.function.arguments).code, code);
        assert.equal(message.content ?? '', '');
        continuation = {
          ...client,
          messages: [
            ...client.messages,
            message,
            { role: 'tool', tool_call_id: call.id, content: 'retry policy found' }
          ]
        };
      } else if (protocol === 'responses') {
        const final = stream ? events.at(-1).response : result;
        assert.equal(final.status, 'completed');
        call = final.output.find((i) => i.type === 'function_call');
        assert.equal(call.name, name);
        assert.equal(JSON.parse(call.arguments).code, code);
        continuation = {
          ...client,
          input: [
            { role: 'user', content: client.input },
            ...final.output,
            { type: 'function_call_output', call_id: call.call_id, output: 'retry policy found' }
          ]
        };
      } else {
        const stop = stream ? events.find((e) => e.type === 'message_delta').delta.stop_reason : result.stop_reason;
        assert.equal(stop, 'tool_use');
        call = stream
          ? events.find((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use')?.content_block
          : result.content.find((b) => b.type === 'tool_use');
        assert.ok(call);
        assert.equal(call.name, name);
        const input = stream
          ? JSON.parse(
              events
                .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta')
                .map((e) => e.delta.partial_json)
                .join('')
            )
          : call.input;
        assert.equal(input.code, code);
        assert.equal(input.description, description);
        continuation = {
          ...client,
          messages: [
            ...client.messages,
            { role: 'assistant', content: [{ ...call, input }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'retry policy found' }] }
          ]
        };
      }
      assert.ok(!JSON.stringify(result ?? events).includes('DSML'));
      const next = toChatRequest(protocol, continuation);
      validateRequest(next, { 'oc-default': { output: 4096 } });
      assert.equal(next.messages.at(-1).role, 'tool');
      assert.equal(next.messages.at(-1).content, 'retry policy found');
    });

for (const protocol of ['chat', 'responses', 'anthropic'])
  for (const stream of [false, true])
    test(`${protocol} preserves live preamble and parallel DSML tools with registered client names (stream=${stream})`, async () => {
      const gate = Promise.withResolvers(),
        bridge = simulatedBridge({ text: introduction + parallel, beforeBatch: stream ? gate.promise : undefined }),
        chatTools = [shellTool, tool];
      const client = {
        model: 'oc-default',
        stream,
        ...(protocol === 'responses'
          ? { input: 'Inspect the rule set', tools: chatTools.map((t) => ({ type: 'function', ...t.function })) }
          : {
              messages: [{ role: 'user', content: 'Inspect the rule set' }],
              tools:
                protocol === 'chat'
                  ? chatTools
                  : chatTools.map((t) => ({ name: t.function.name, input_schema: t.function.parameters })),
              ...(protocol === 'anthropic' ? { max_tokens: 1000 } : {})
            })
      };
      try {
        const response = await adaptResponse(protocol, await send(bridge, toChatRequest(protocol, client)), client);
        assert.equal(response.status, 200);
        let result,
          events = [];
        if (stream) {
          const iterator = sseEvents(response.body);
          let prose = '';
          let timer;
          try {
            await Promise.race([
              (async () => {
                while (prose !== introduction) {
                  const { value, done } = await iterator.next();
                  assert.equal(done, false);
                  events.push(value);
                  prose +=
                    value.choices?.[0]?.delta.content ??
                    (value.type === 'response.output_text.delta'
                      ? value.delta
                      : value.delta?.type === 'text_delta'
                        ? value.delta.text
                        : '');
                  assert.equal(toolCalls(events).length, 0);
                  assert.ok(!value.item?.call_id && !value.content_block?.id);
                }
              })(),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Preamble was buffered until tool completion')), 2000);
                timer.unref();
              })
            ]);
          } finally {
            clearTimeout(timer);
          }
          gate.resolve();
          events.push(...(await Array.fromAsync(iterator)));
        } else result = await response.json();
        let calls, text, continuation;
        if (protocol === 'chat') {
          const message = stream
            ? {
                role: 'assistant',
                content: events.map((e) => e.choices?.[0]?.delta.content ?? '').join(''),
                tool_calls: toolCalls(events).map(({ index, ...call }) => call)
              }
            : result.choices[0].message;
          calls = message.tool_calls;
          text = message.content;
          assert.equal(
            stream
              ? events.find((e) => e.choices?.[0]?.finish_reason)?.choices[0].finish_reason
              : result.choices[0].finish_reason,
            'tool_calls'
          );
          continuation = {
            ...client,
            messages: [
              ...client.messages,
              message,
              ...calls.toReversed().map((c) => ({ role: 'tool', tool_call_id: c.id, content: 'done ' + c.id }))
            ]
          };
          calls = calls.map((c) => ({ id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) }));
        } else if (protocol === 'responses') {
          const final = stream ? events.at(-1).response : result;
          calls = final.output.filter((c) => c.type === 'function_call');
          text = final.output
            .filter((c) => c.type === 'message')
            .flatMap((c) => c.content)
            .map((c) => c.text)
            .join('');
          assert.equal(final.status, 'completed');
          continuation = {
            ...client,
            input: [
              { role: 'user', content: client.input },
              ...final.output,
              ...calls
                .toReversed()
                .map((c) => ({ type: 'function_call_output', call_id: c.call_id, output: 'done ' + c.call_id }))
            ]
          };
          calls = calls.map((c) => ({ id: c.call_id, name: c.name, input: JSON.parse(c.arguments) }));
        } else {
          const content = stream
            ? events
                .filter((e) => e.type === 'content_block_start')
                .map((e) => {
                  const b = { ...e.content_block },
                    deltas = events.filter((d) => d.type === 'content_block_delta' && d.index === e.index);
                  if (b.type === 'text') b.text = deltas.map((d) => d.delta.text ?? '').join('');
                  if (b.type === 'tool_use')
                    b.input = JSON.parse(deltas.map((d) => d.delta.partial_json ?? '').join(''));
                  return b;
                })
            : result.content;
          calls = content.filter((c) => c.type === 'tool_use');
          text = content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('');
          assert.equal(
            stream ? events.find((e) => e.type === 'message_delta').delta.stop_reason : result.stop_reason,
            'tool_use'
          );
          continuation = {
            ...client,
            messages: [
              ...client.messages,
              { role: 'assistant', content },
              {
                role: 'user',
                content: calls
                  .toReversed()
                  .map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'done ' + c.id }))
              }
            ]
          };
        }
        assert.equal(text, introduction);
        assert.deepEqual(
          calls.map((c) => c.name),
          ['pwsh', name]
        );
        assert.equal(new Set(calls.map((c) => c.id)).size, 2);
        assert.equal(calls[0].input.command, command);
        assert.equal(calls[1].input.code, code);
        assert.ok(!JSON.stringify(events.length ? events : result).includes('DSML'));
        const next = toChatRequest(protocol, continuation);
        validateRequest(next, { 'oc-default': { output: 4096 } });
        assert.equal(next.messages.filter((m) => m.role === 'tool').length, 2);
      } finally {
        gate.resolve();
        await bridge.close();
      }
    });

for (const protocol of ['chat', 'responses', 'anthropic'])
  for (const stream of [false, true])
    test(`${protocol} preserves illustrative DSML as literal output (stream=${stream})`, async () => {
      const text = 'Here is an example:\n\n' + sample,
        bridge = simulatedBridge({ text }),
        client = {
          model: 'oc-default',
          stream,
          ...(protocol === 'responses'
            ? { input: 'Explain the markup', tools: [{ type: 'function', name, parameters }] }
            : {
                messages: [{ role: 'user', content: 'Explain the markup' }],
                tools: protocol === 'chat' ? [tool] : [{ name, input_schema: parameters }],
                ...(protocol === 'anthropic' ? { max_tokens: 1000 } : {})
              })
        };
      try {
        const response = await adaptResponse(protocol, await send(bridge, toChatRequest(protocol, client)), client);
        assert.equal(response.status, 200);
        const events = stream ? await Array.fromAsync(sseEvents(response.body)) : undefined,
          result = stream ? undefined : await response.json();
        const output =
          protocol === 'chat'
            ? stream
              ? events.map((e) => e.choices?.[0]?.delta.content ?? '').join('')
              : result.choices[0].message.content
            : protocol === 'responses'
              ? (stream ? events.at(-1).response : result).output
                  .flatMap((i) => i.content ?? [])
                  .map((p) => p.text ?? '')
                  .join('')
              : stream
                ? events
                    .filter((e) => e.delta?.type === 'text_delta')
                    .map((e) => e.delta.text)
                    .join('')
                : result.content.map((b) => b.text ?? '').join('');
        assert.equal(output, text);
        if (stream)
          assert.ok(
            !events.some(
              (e) =>
                e.choices?.[0]?.delta.tool_calls ||
                e.item?.type === 'function_call' ||
                e.content_block?.type === 'tool_use'
            )
          );
        else
          assert.ok(
            !result.choices?.[0]?.message.tool_calls &&
              !result.output?.some((i) => i.type === 'function_call') &&
              !result.content?.some((i) => i.type === 'tool_use')
          );
      } finally {
        await bridge.close();
      }
    });

for (const protocol of ['chat', 'responses', 'anthropic'])
  for (const stream of [false, true])
    test(`${protocol} rejects prefixed invalid/interrupted batches without returning partial tools (stream=${stream})`, async () => {
      for (const options of [
        { text: introduction + parallel.replace(native, 'unregistered') },
        { text: introduction + parallel.slice(0, -20), streamError: true },
        { text: introduction + parallel, reason: 'length' }
      ]) {
        const bridge = simulatedBridge(options),
          tools = [shellTool, tool],
          client = {
            model: 'oc-default',
            stream,
            ...(protocol === 'responses'
              ? { input: 'Inspect', tools: tools.map((t) => ({ type: 'function', ...t.function })) }
              : {
                  messages: [{ role: 'user', content: 'Inspect' }],
                  tools:
                    protocol === 'chat'
                      ? tools
                      : tools.map((t) => ({ name: t.function.name, input_schema: t.function.parameters })),
                  ...(protocol === 'anthropic' ? { max_tokens: 1000 } : {})
                })
          };
        try {
          const response = await adaptResponse(protocol, await send(bridge, toChatRequest(protocol, client)), client);
          assert.equal(response.status, stream ? 200 : 502);
          const result = stream ? await Array.fromAsync(sseEvents(response.body)) : await response.json();
          assert.ok(stream ? result.some((e) => e.error || e.type === 'error') : result.error);
          assert.ok(!JSON.stringify(result).includes('<｜｜DSML｜｜'));
          if (stream) {
            assert.ok(
              !result.some(
                (e) =>
                  e.choices?.[0]?.finish_reason ||
                  ['response.completed', 'response.incomplete', 'message_stop'].includes(e.type)
              )
            );
            assert.ok(
              !result.some(
                (e) =>
                  e.choices?.[0]?.delta.tool_calls ||
                  e.item?.type === 'function_call' ||
                  e.content_block?.type === 'tool_use'
              )
            );
          }
        } finally {
          await bridge.close();
        }
      }
    });

test('DSML forced/serial tools and structured capture obey their existing constraints', async () => {
  for (const disabled of [false, true]) {
    const body = {
        model: 'oc-default',
        messages: [{ role: 'user', content: 'call' }],
        tools: [tool],
        tool_choice: 'required',
        parallel_tool_calls: false,
        ...(disabled ? { thinking: { type: 'disabled' } } : {})
      },
      plan = nativeGeneration(body);
    const text = batch(plan.capture ? 'bridge_structured_output' : 'StructuredOutput', {
      calls: [{ name, arguments: { code, description } }]
    });
    const response = await send(simulatedBridge({ text }), body),
      result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.choices[0].finish_reason, 'tool_calls');
    assert.equal(result.choices[0].message.tool_calls[0].function.name, name);
  }
});

for (const stream of [false, true])
  test(`invalid DSML never emits success or leaks markup (stream=${stream})`, async () => {
    for (const options of [
      { text: sample.slice(0, -20) },
      { text: sample, reason: 'length' },
      { text: sample, reason: 'content-filter' },
      { text: sample.replace(native, 'unknown') },
      { text: sample, nativeCall: true },
      { text: introduction + sample.slice(0, -20) },
      { text: introduction + sample, reason: 'length' },
      { text: introduction + sample, reason: 'content-filter' },
      { text: introduction + sample.replace(native, 'unknown') },
      { text: introduction + sample, nativeCall: true },
      { text: introduction + sample.slice(0, -20), streamError: true }
    ]) {
      const response = await send(simulatedBridge({ ...options, reasoning: stream }), { stream });
      const result = stream ? await Array.fromAsync(sseEvents(response.body)) : await response.json();
      assert.equal(response.status, stream ? 200 : 502);
      assert.ok(stream ? result.some((e) => e.error) : result.error);
      assert.ok(!JSON.stringify(result).includes('DSML｜'));
      if (stream) assert.ok(!result.some((e) => e.choices?.[0]?.finish_reason));
    }
  });
