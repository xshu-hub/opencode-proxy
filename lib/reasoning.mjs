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
  });
  return { reasoning: model.capabilities?.reasoning === true || reasoningEfforts.length > 0, reasoningEfforts };
}

function mergeOptions(base, override) {
  return Object.fromEntries(Object.entries({ ...base, ...override }).map(([key, value]) => [key,
    record(value) ? mergeOptions(record(base?.[key]) ? base[key] : {}, value) : value,
  ]));
}

export function applyReasoning(model, options, effort) {
  if (effort === undefined) return options;
  const variant = Object.hasOwn(model.variants ?? {}, effort) ? model.variants[effort] : undefined;
  const settings = variantOptions(variant);
  if (Object.keys(settings ?? {}).length) return mergeOptions(options, settings);
  if (openAIOptions.has(model.api?.npm) && variant?.disabled !== true) return mergeOptions(options, { reasoningEffort: effort });
  const available = publicReasoning(model).reasoningEfforts;
  throw new ApiError(`OpenCode cannot map reasoning_effort=${effort} for ${model.api?.npm ?? 'this provider SDK'}. Available OpenCode variants: ${available.join(', ') || 'none'}.`, 400, 'reasoning_effort', 'unsupported_reasoning_effort');
}
