import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReasoning, publicReasoning, validateReasoningVariants,reasoningPresetVariants } from '../lib/reasoning.mjs';

test('custom effort mappings override native variants, merge SDK budgets, and leave defaults untouched',()=>{
  const model={api:{npm:'custom-native-sdk'},variants:{high:{thinking:{type:'enabled',budgetTokens:1024}}}};
  const options={thinking:{type:'enabled',budgetTokens:256},nested:{keep:true}};
  const custom={high:{thinking:{budgetTokens:8192}},max:{thinking:{budgetTokens:16000}}};
  assert.equal(applyReasoning(model,options,undefined,custom),options);
  assert.deepEqual(applyReasoning(model,options,'high',custom),{thinking:{type:'enabled',budgetTokens:8192},nested:{keep:true}});
  assert.equal(options.thinking.budgetTokens,256);
  assert.equal(applyReasoning(model,options,'max',custom).thinking.budgetTokens,16000);
  assert.throws(()=>validateReasoningVariants(JSON.parse('{"high":{"__proto__":{"polluted":true}}}')),/无效字段/);
  assert.throws(()=>validateReasoningVariants({arbitrary:{reasoningEffort:'high'}}),/标准强度/);
  assert.throws(()=>validateReasoningVariants({high:{}}),/非空/);
  assert.throws(()=>validateReasoningVariants({high:{budget:Infinity}}),/数值无效/);
});

test('public effort levels follow Magpie slider order even when native variants are declared in reverse',()=>{
  const model={api:{npm:'custom-native-sdk'},variants:{max:{level:4},high:{level:3},low:{level:1},medium:{level:2},none:{level:0}},options:{reasoningEffort:'medium'}};
  assert.deepEqual(publicReasoning(model),{reasoning:true,reasoningEfforts:['none','low','medium','high','max'],reasoningAdapter:'native',nativeReasoningEffort:'medium'});
});

test('reasoning preserves defaults when omitted and explicit SDK effort overrides without changing shared options', () => {
  const options = { reasoningEffort: 'xhigh', nested: { keep: true } };
  const model = { api: { npm: '@ai-sdk/openai-compatible' } };
  assert.equal(applyReasoning(model, options, undefined), options);
  assert.deepEqual(applyReasoning(model, options, 'high'), { reasoningEffort: 'high', nested: { keep: true } });
  assert.equal(options.reasoningEffort, 'xhigh');
  const zero = applyReasoning(model, options, 'none');
  assert.equal(zero.reasoningEffort, 'none');
});

test('native variants retain nested settings and unknown SDKs do not guess thinking budgets', () => {
  const variant = { disabled: false, thinking: { type: 'enabled', budgetTokens: 2048 }, nested: { choose: 'variant' } };
  const model = { api: { npm: 'custom-native-sdk' }, capabilities: { reasoning: true }, variants: { high: variant, private: { token: 'private-option' } } };
  assert.deepEqual(applyReasoning(model, { nested: { keep: true, choose: 'default' } }, 'high'), { thinking: variant.thinking, nested: { keep: true, choose: 'variant' } });
  assert.deepEqual(publicReasoning(model), { reasoning: true, reasoningEfforts: ['high'],reasoningAdapter:'native' });
  assert.equal(JSON.stringify(publicReasoning(model)).includes('private-option'), false);
  assert.throws(() => applyReasoning(model, {}, 'low'), error => error.status === 400 && error.param === 'reasoning_effort' && error.code === 'unsupported_reasoning_effort');
  assert.throws(() => applyReasoning({ api: { npm: '@ai-sdk/openai-compatible' }, variants: { high: { disabled: true } } }, {}, 'high'), /cannot map/);
  assert.equal(applyReasoning({ api: { npm: '@ai-sdk/openai-compatible' }, variants: { high: { disabled: false } } }, { reasoningEffort: 'xhigh' }, 'high').reasoningEffort, 'high');
  assert.deepEqual(publicReasoning({ api: { npm: 'custom-native-sdk' }, variants: { high: {} } }).reasoningEfforts, []);
});

test('UI reasoning choices generate SDK options and budget boundaries without option JSON',()=>{
  assert.deepEqual(reasoningPresetVariants({type:'effort',levels:['high','max']},{reasoningAdapter:'effort'}),{high:{reasoningEffort:'high'},max:{reasoningEffort:'max'}});
  const model={reasoningAdapter:'budget',output:4096};assert.deepEqual(reasoningPresetVariants({type:'budget',levels:['none','high'],budgets:{high:4095}},model),{none:{thinking:{type:'disabled'}},high:{thinking:{type:'enabled',budgetTokens:4095}}});
  for(const budget of [1023,4096,1.5])assert.throws(()=>reasoningPresetVariants({type:'budget',levels:['high'],budgets:{high:budget}},model),e=>e.param==='reasoningPreset');
  assert.throws(()=>reasoningPresetVariants({type:'effort',levels:['high']},model),/SDK/);
  assert.throws(()=>reasoningPresetVariants({type:'effort',levels:[]},{reasoningAdapter:'effort'}),/至少/);
  assert.deepEqual(reasoningPresetVariants({type:'native'},model),{});
});
