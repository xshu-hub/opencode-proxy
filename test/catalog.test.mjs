import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelCatalog } from '../lib/models.mjs';
import { workerConfig } from '../lib/config.mjs';
import { normalizeConfig } from '../lib/bridge.mjs';
import { toolPermissions, nativeToolName } from '../lib/protocol.mjs';

test('short model IDs preserve exact upstream routes, collision safety and explicit aliases',()=>{
  const entries=['xshu/gpt-6.1-sol','a/shared','b/shared','a/b/nested','b/nested','x/oc-default','x/constructor','x/__proto__'];
  const discovered=Object.fromEntries(entries.map(model=>[model,{model,context:100,output:10}]));
  const configured={'oc-default':{context:200,output:20},'friendly':{model:'a/shared',context:100,output:10}};
  const {models,accepted}=modelCatalog(discovered,configured);
  assert.ok(Object.hasOwn(models,'gpt-6.1-sol'));
  assert.equal(models['gpt-6.1-sol'].model,'xshu/gpt-6.1-sol');
  assert.ok(!Object.hasOwn(models,'xshu/gpt-6.1-sol'));
  assert.equal(accepted['xshu/gpt-6.1-sol'].model,'xshu/gpt-6.1-sol');
  assert.ok(!Object.hasOwn(models,'shared'),'Ambiguous bare IDs must never pick a provider');
  assert.equal(models['a/shared'].model,'a/shared'); assert.equal(models['b/shared'].model,'b/shared');
  assert.equal(models['a/b/nested'].model,'a/b/nested','A shortened name cannot shadow another qualified ID');
  assert.equal(accepted['b/nested'].model,'b/nested');
  assert.equal(models['oc-default'].model,undefined);
  assert.equal(models['x/oc-default'].model,'x/oc-default');
  assert.equal(models.friendly.model,'a/shared');
  assert.equal(models.__proto__.model,'x/__proto__');
  assert.equal(models.constructor.model,'x/constructor');
  assert.deepEqual(Object.keys(modelCatalog(discovered,configured,'qualified').models),[...entries,...Object.keys(configured)]);
  const custom=modelCatalog(discovered,{'gpt-6.1-sol':{model:'a/shared',context:100,output:10}});
  assert.equal(custom.models['gpt-6.1-sol'].model,'a/shared');
  assert.equal(custom.accepted['xshu/gpt-6.1-sol'].model,'xshu/gpt-6.1-sol');
  assert.throws(()=>normalizeConfig({mode:'global',modelIdStyle:'bad'}),/modelIdStyle/);
});

test('inline OpenCode JSONC retains providers/plugins/options without weakening worker overrides',()=>{
  const overrides={permission:{'*':'deny'},plugin:['file:///worker.mjs'],mcp:{bridge:{enabled:true}},agent:{bridge:{mode:'primary'}}};
  const source='{ // comment\n "provider":{"x":{"options":{"baseURL":"http://example.invalid/v1","marker":"a,} // /*","escaped":"quote\\\""}}}, "plugin":["file:///global.mjs",], /* block */ "mcp":{"old":{"enabled":true}}, "permission":{"*":"allow"}, "agent":{"custom":{}},}';
  const config=workerConfig(source,overrides);
  assert.equal(config.provider.x.options.marker,'a,} // /*');
  assert.equal(config.provider.x.options.escaped,'quote"');
  assert.deepEqual(config.plugin,['file:///global.mjs','file:///worker.mjs']);
  assert.deepEqual(config.permission,{'*':'deny'});
  assert.ok(config.mcp.old); assert.ok(config.mcp.bridge); assert.ok(config.agent.custom);
  assert.deepEqual(workerConfig('',overrides),overrides);
  for(const invalid of ['null','[]','{','{/*','{"plugin":true}','{"provider":1,,}']) assert.throws(()=>workerConfig(invalid,overrides),e=>e.code==='opencode_config');
});

test('tool permissions allow only exact registered client names and none disables every tool',()=>{
  const body={tools:[{type:'function',function:{name:'weather'}},{type:'function',function:{name:'clock'}}]};
  assert.deepEqual(toolPermissions(body),{'*':'deny',[nativeToolName('weather')]:'allow',[nativeToolName('clock')]:'allow'});
  assert.deepEqual(toolPermissions({...body,tool_choice:'none'}),{'*':'deny'});
  assert.deepEqual(toolPermissions({}),{'*':'deny'});
});
