import { ApiError, REASONING_EFFORTS } from './protocol.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const openAIOptions = new Set(['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/azure']);
const variantOptions = variant => record(variant) && variant.disabled !== true
  ? Object.fromEntries(Object.entries(variant).filter(([key]) => key !== 'disabled')) : undefined;

// Publish names only. A global variant's options can contain private provider data.
export function publicReasoning(model) {
  const reasoningEfforts = Object.keys(model.variants ?? {}).filter(effort => {
    const variant = model.variants[effort];
    const settings = variantOptions(variant);
    return REASONING_EFFORTS.includes(effort) && variant?.disabled !== true && (Object.keys(settings ?? {}).length > 0 || openAIOptions.has(model.api?.npm));
  }).sort((a,b)=>REASONING_EFFORTS.indexOf(a)-REASONING_EFFORTS.indexOf(b));
  const reasoningAdapter=openAIOptions.has(model.api?.npm)?'effort':model.api?.npm==='@ai-sdk/anthropic'?'budget':'native';
  return { reasoning: model.capabilities?.reasoning === true || reasoningEfforts.length > 0, reasoningEfforts, reasoningAdapter, ...(REASONING_EFFORTS.includes(model.options?.reasoningEffort)?{nativeReasoningEffort:model.options.reasoningEffort}:{}) };
}

// The management UI submits choices and numbers, never provider-option JSON.
export function reasoningPresetVariants(preset,model) {
  if(!record(preset)||Object.keys(preset).some(k=>!['type','levels','budgets'].includes(k))||!['native','effort','budget'].includes(preset.type))throw new ApiError('思考强度配置无效。',400,'reasoningPreset');
  if(preset.type==='native')return {};
  if(preset.type!==model.reasoningAdapter)throw new ApiError('当前 OpenCode SDK 未提供这种思考配置方式，请使用原生档位。',400,'reasoningPreset');
  if(!Array.isArray(preset.levels)||!preset.levels.length||new Set(preset.levels).size!==preset.levels.length||preset.levels.some(e=>!REASONING_EFFORTS.includes(e)))throw new ApiError('请至少选择一个有效思考档位。',400,'reasoningPreset');
  if(preset.type==='effort')return Object.fromEntries(preset.levels.map(e=>[e,{reasoningEffort:e}]));
  if(!record(preset.budgets)||Object.keys(preset.budgets).some(e=>!preset.levels.includes(e)||e==='none'))throw new ApiError('思考预算配置无效。',400,'reasoningPreset');
  return Object.fromEntries(preset.levels.map(e=>{
    if(e==='none')return[e,{thinking:{type:'disabled'}}];
    const n=preset.budgets[e];if(!Number.isSafeInteger(n)||n<1024||n>=model.output)throw new ApiError('思考预算应为至少 1024 且小于模型最大输出的整数。',400,'reasoningPreset');
    return[e,{thinking:{type:'enabled',budgetTokens:n}}];
  }));
}

function mergeOptions(base, override) {
  return Object.fromEntries(Object.entries({ ...base, ...override }).map(([key, value]) => [key,
    record(value) ? mergeOptions(record(base?.[key]) ? base[key] : {}, value) : value,
  ]));
}

export function validateReasoningVariants(variants) {
  if (!record(variants) || JSON.stringify(variants).length > 16384) throw new ApiError('自定义思考映射必须是 JSON 对象，且不超过 16 KB。',400,'reasoningVariants');
  const check = (value, depth=0) => {
    if (depth>8 || (typeof value==='number'&&!Number.isFinite(value))) throw new ApiError('自定义思考参数层级过深或数值无效。',400,'reasoningVariants');
    if(value!==null&&typeof value==='object')for(const [key,child] of Object.entries(value)){
      if(['__proto__','constructor','prototype'].includes(key))throw new ApiError('自定义思考参数包含无效字段。',400,'reasoningVariants');
      check(child,depth+1);
    }
  };
  for(const [effort,options] of Object.entries(variants)){
    if(!REASONING_EFFORTS.includes(effort)||!record(options)||!Object.keys(options).length||Object.hasOwn(options,'disabled'))throw new ApiError('每个映射须使用标准强度名称，并提供非空的 OpenCode SDK 参数对象。',400,'reasoningVariants');
    check(options);
  }
  return variants;
}

export function applyReasoning(model, options, effort, customVariants = {}) {
  if (effort === undefined) return options;
  validateReasoningVariants(customVariants);
  if(Object.hasOwn(customVariants,effort))return mergeOptions(options,customVariants[effort]);
  const variant = Object.hasOwn(model.variants ?? {}, effort) ? model.variants[effort] : undefined;
  const settings = variantOptions(variant);
  if (Object.keys(settings ?? {}).length) return mergeOptions(options, settings);
  if (openAIOptions.has(model.api?.npm) && variant?.disabled !== true) return mergeOptions(options, { reasoningEffort: effort });
  const available = publicReasoning(model).reasoningEfforts;
  throw new ApiError(`OpenCode cannot map reasoning_effort=${effort} for ${model.api?.npm ?? 'this provider SDK'}. Available OpenCode variants: ${available.join(', ') || 'none'}.`, 400, 'reasoning_effort', 'unsupported_reasoning_effort');
}
