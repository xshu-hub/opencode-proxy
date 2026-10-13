import { ApiError } from './protocol.mjs';

// OpenCode accepts JSONC in OPENCODE_CONFIG_CONTENT. Preserve strings while
// removing comments and trailing commas; JSON.parse still validates the result.
export function workerConfig(content, overrides) {
  if (!content) return overrides;
  let base;
  try {
    const clean = content.replace(/^\uFEFF/, '').replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('"') ? token : ' ');
    base = JSON.parse(clean.replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, token => token.startsWith('"') ? token : ' '));
    if (!base || typeof base !== 'object' || Array.isArray(base)) throw new Error();
    if (base.plugin !== undefined && !Array.isArray(base.plugin)) throw new Error();
  } catch {
    throw new ApiError('OpenCode OPENCODE_CONFIG_CONTENT must be a valid JSON/JSONC configuration object.', 503, null, 'opencode_config');
  }
  return {
    ...base, ...overrides,
    plugin: [...(base.plugin ?? []), ...overrides.plugin],
    mcp: { ...base.mcp, ...overrides.mcp },
    agent: { ...base.agent, ...overrides.agent },
  };
}
