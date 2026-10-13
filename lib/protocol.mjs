import { createHash } from 'node:crypto';

export class ApiError extends Error {
  constructor(message, status = 400, param = null, code = 'invalid_request') {
    super(message);
    Object.assign(this, { status, param, code });
  }
  body() {
    return { error: { message: this.message, type: this.status < 500 ? 'invalid_request_error' : 'api_error', param: this.param, code: this.code } };
  }
}

const fail = (message, param) => { throw new ApiError(message, 400, param); };
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const toolName = (name) => 't_' + createHash('sha256').update(name).digest('hex').slice(0, 24);
export const nativeToolName = (name) => 'bridge_' + toolName(name);

export const clientToolNames = body => (body.tool_choice === 'none' ? [] : body.tools ?? []).map(t => nativeToolName(t.function.name));
export const toolPermissions = body => Object.fromEntries([['*', 'deny'], ...clientToolNames(body).map(name => [name, 'allow'])]);

export function textContent(content, param, nullable = false) {
  if (nullable && content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(p => p?.type === 'text' && typeof p.text === 'string')) return content.map(p => p.text).join('');
  fail('Only text content is supported by this bridge version.', param);
}

export function validateRequest(body, models) {
  if (!object(body)) fail('Request must be a JSON object.', null);
  const fields = new Set(['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'n']);
  for (const key of Object.keys(body)) if (!fields.has(key)) fail(`Unsupported parameter: ${key}.`, key);
  if (typeof body.model !== 'string' || !Object.hasOwn(models, body.model)) throw new ApiError('Unknown bridge model.', 404, 'model', 'model_not_found');
  if (body.reasoning_effort !== undefined && !REASONING_EFFORTS.includes(body.reasoning_effort)) fail('reasoning_effort must be none, minimal, low, medium, high, xhigh or max.', 'reasoning_effort');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail('stream must be boolean.', 'stream');
  if (body.stream_options !== undefined) {
    if (!object(body.stream_options) || Object.keys(body.stream_options).some(k => k !== 'include_usage') || (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean')) fail('Only stream_options.include_usage is supported.', 'stream_options');
  }
  if (body.n !== undefined && body.n !== 1) fail('Only n=1 is supported.', 'n');
  if (body.tool_choice !== undefined && !['auto', 'none'].includes(body.tool_choice)) fail('Only tool_choice=auto or none is supported.', 'tool_choice');
  if (body.parallel_tool_calls !== undefined) fail('Explicit parallel_tool_calls is unsupported; OpenCode decides tool batching.', 'parallel_tool_calls');
  for (const [key, min, max] of [['temperature', 0, 2], ['top_p', 0, 1]]) {
    if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < min || body[key] > max)) fail(`${key} is out of range.`, key);
  }
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) fail('Specify only one output token limit.', 'max_completion_tokens');
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined && (!Number.isInteger(max) || max <= 0 || max > models[body.model].output)) fail(`Output token limit (${JSON.stringify(max)}) must be a positive integer no greater than the configured model limit (${models[body.model].output}).`, body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens');
  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 128) fail('tools must be an array of at most 128 functions.', 'tools');
  const names = new Set();
  for (const t of tools) {
    const f = t?.function;
    if (t?.type !== 'function' || !object(f) || typeof f.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(f.name) || names.has(f.name)) fail('Tool names must be unique function names (1–64 letters, digits, underscores or hyphens).', 'tools');
    if (Object.keys(t).some(k => !['type', 'function'].includes(k)) || Object.keys(f).some(k => !['name', 'description', 'parameters', 'strict'].includes(k))) fail('Unsupported tool definition field.', 'tools');
    if (f.description !== undefined && typeof f.description !== 'string') fail('Tool description must be text.', 'tools');
    if (f.strict !== undefined && f.strict !== false) fail('The bridge cannot guarantee strict schema mode.', 'tools');
    const schema = f.parameters ?? { type: 'object', properties: {} };
    if (!object(schema) || schema.type !== 'object' || schema.additionalProperties === true) fail('MCP tools require an object schema without additionalProperties=true.', 'tools');
    names.add(f.name);
  }
  if (!Array.isArray(body.messages) || !body.messages.length) fail('messages must be nonempty.', 'messages');
  let seenConversation = false;
  const calls = new Map();
  const outstanding = new Set();
  for (const [i, m] of body.messages.entries()) {
    const param = `messages[${i}]`;
    if (!object(m) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) fail('Unsupported message role.', param);
    for (const key of Object.keys(m)) if (!['role', 'content', 'tool_calls', 'tool_call_id', 'reasoning_content'].includes(key)) fail(`Unsupported message field: ${key}.`, `${param}.${key}`);
    if (m.reasoning_content !== undefined && (m.role !== 'assistant' || (m.reasoning_content !== null && typeof m.reasoning_content !== 'string'))) fail('reasoning_content must be text or null on an assistant message.', `${param}.reasoning_content`);
    textContent(m.content, `${param}.content`, m.role === 'assistant');
    if (m.role === 'system' || m.role === 'developer') {
      if (seenConversation) fail('System/developer messages must precede conversation messages.', param);
      if (m.tool_calls || m.tool_call_id) fail('Tool fields require an assistant/tool message.', param);
      continue;
    }
    seenConversation = true;
    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !outstanding.delete(m.tool_call_id) || m.tool_calls) fail('Tool result does not match an outstanding call.', param);
      continue;
    }
    if (outstanding.size) fail('All tool results must follow their assistant calls before the next user/assistant message.', param);
    if (m.tool_call_id || (m.tool_calls !== undefined && m.role !== 'assistant')) fail('Tool fields require an assistant/tool message.', param);
    if (m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls) || !m.tool_calls.length) fail('tool_calls must be nonempty.', param);
      for (const call of m.tool_calls) {
        if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || calls.has(call.id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.function?.name ?? '') || typeof call.function?.arguments !== 'string') fail('Invalid or duplicate tool call.', param);
        let args;
        try { args = JSON.parse(call.function.arguments); } catch { fail('Tool arguments must be valid JSON.', param); }
        if (!object(args)) fail('Tool arguments must be a JSON object.', param);
        calls.set(call.id, call);
        outstanding.add(call.id);
      }
    }
  }
  if (outstanding.size) fail('Missing tool results.', 'messages');
  if (!['user', 'tool'].includes(body.messages.at(-1).role)) fail('The final message must be user or tool.', 'messages');
  return body;
}

// Use OpenCode's public message-transform hook to preserve roles and client tool results.
export function toNativeHistory(body, sessionID, modelID, directory, providerID = 'opencode-bridge') {
  const system = body.messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => textContent(m.content));
  const messages = [];
  const calls = new Map();
  let parentID = 'msg_bridge_parent';
  let counter = 0;
  const part = (id, data) => ({ id: `prt_bridge_${counter++}`, sessionID, messageID: id, ...data });
  for (const m of body.messages) {
    if (['system', 'developer'].includes(m.role)) continue;
    if (m.role === 'tool') {
      const p = calls.get(m.tool_call_id);
      p.state = { ...p.state, status: 'completed', output: textContent(m.content), title: p.tool, metadata: {}, time: { start: 0, end: 0 } };
      continue;
    }
    const id = `msg_bridge_${String(counter++).padStart(8, '0')}`;
    const base = { id, sessionID, role: m.role, time: { created: 0 }, agent: 'bridge' };
    const info = m.role === 'user'
      ? { ...base, model: { providerID, modelID } }
      : { ...base, parentID, modelID, providerID, mode: 'bridge', path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    const parts = [];
    if (m.reasoning_content) parts.push(part(id, { type: 'reasoning', text: m.reasoning_content, time: { start: 0, end: 0 } }));
    const content = textContent(m.content, 'content', m.role === 'assistant');
    if (content) parts.push(part(id, { type: 'text', text: content }));
    for (const call of m.tool_calls ?? []) {
      const p = part(id, { type: 'tool', callID: call.id, tool: nativeToolName(call.function.name), state: { status: 'running', input: JSON.parse(call.function.arguments), time: { start: 0 } } });
      calls.set(call.id, p);
      parts.push(p);
    }
    messages.push({ info, parts });
    if (m.role === 'user') parentID = id;
  }
  return { system, messages };
}

export function usageOf(tokens = {}) {
  const prompt = (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
  const completion = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: tokens.cache?.read ?? 0 }, completion_tokens_details: { reasoning_tokens: tokens.reasoning ?? 0 } };
}

// Decode SSE across arbitrary byte boundaries, including UTF-8 and CRLF boundaries.
export async function* sseEvents(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
    if (buffer.length > 16 * 1024 * 1024) throw new ApiError('OpenCode event exceeded the size limit.', 502);
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new ApiError('OpenCode event stream ended mid-frame.', 502);
}
