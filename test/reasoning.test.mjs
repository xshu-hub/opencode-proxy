import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReasoning, publicReasoning } from '../lib/reasoning.mjs';

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
  assert.deepEqual(publicReasoning(model), { reasoning: true, reasoningEfforts: ['high'] });
  assert.equal(JSON.stringify(publicReasoning(model)).includes('private-option'), false);
  assert.throws(() => applyReasoning(model, {}, 'low'), error => error.status === 400 && error.param === 'reasoning_effort' && error.code === 'unsupported_reasoning_effort');
  assert.throws(() => applyReasoning({ api: { npm: '@ai-sdk/openai-compatible' }, variants: { high: { disabled: true } } }, {}, 'high'), /cannot map/);
  assert.equal(applyReasoning({ api: { npm: '@ai-sdk/openai-compatible' }, variants: { high: { disabled: false } } }, { reasoningEffort: 'xhigh' }, 'high').reasoningEffort, 'high');
  assert.deepEqual(publicReasoning({ api: { npm: 'custom-native-sdk' }, variants: { high: {} } }).reasoningEfforts, []);
});
