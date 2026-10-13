import{test}from'node:test';import assert from'node:assert/strict';
import{initialThinkingChoice}from'../frontend/src/thinking-choice.js';
test('old model editors with empty JSON mapping open as native choices, while actual overrides remain intact',()=>{
 const model={reasoningAdapter:'effort'};
 assert.deepEqual(initialThinkingChoice(model,{reasoningVariants:{}}),{preset:{type:'native'},preserveLegacy:false});
 assert.deepEqual(initialThinkingChoice(model,{reasoningVariants:{high:{reasoningEffort:'high'},max:{reasoningEffort:'max'}}}),{preset:{type:'effort',levels:['high','max']},preserveLegacy:false});
 assert.deepEqual(initialThinkingChoice(model,{reasoningVariants:{high:{reasoningEffort:'max',nested:{keep:true}}}}),{preset:{type:'native'},preserveLegacy:true});
 const saved={reasoningPreset:{type:'effort',levels:['max']}};const current=initialThinkingChoice(model,saved);current.preset.levels.push('high');assert.deepEqual(saved.reasoningPreset.levels,['max']);
});
