import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeBridge } from '../lib/bridge.mjs';
import { ApiError, sseEvents, validateRequest } from '../lib/protocol.mjs';

// Simulate the native SSE fetch rejecting on abort after the server accepted
// inference. Check the public JSON/SSE error, not the AbortError implementation.
for (const stream of [false, true]) test(`stream interruption preserves timeout details (stream=${stream})`, async () => {
  const controller = new AbortController();
  let cleaned = 0;
  const bridge = new OpenCodeBridge({ mode: 'global', discoverModels: false });
  bridge.prepare = async () => ({
    sessionID: 'session', signal: controller.signal, cleanup: async () => { cleaned++; },
    events: (async function* () {
      yield { type: 'message.updated', properties: { info: { id: 'message', role: 'assistant', sessionID: 'session' } } };
      yield { type: 'message.part.updated', properties: { part: { id: 'part', messageID: 'message', sessionID: 'session', type: 'text', text: 'Partial output' } } };
      controller.abort(new ApiError('OpenCode request timed out during inference.', 504, null, 'opencode_timeout'));
      throw new DOMException('The operation was aborted.', 'AbortError');
    })(),
  });
  const response = await bridge.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'oc-default', messages: [{ role: 'user', content: 'Hello' }], stream }) });
  const result = stream ? (await Array.fromAsync(sseEvents(response.body))).find(c => c.error) : await response.json();
  assert.equal(response.status, stream ? 200 : 504);
  assert.equal(result.error.code, 'opencode_timeout');
  assert.match(result.error.message, /timed out during inference/);
  assert.equal(cleaned, 1);
});

test('token limit errors identify the supplied field, value and catalog ceiling', () => {
  for (const field of ['max_tokens', 'max_completion_tokens']) {
    assert.throws(() => validateRequest({ model: 'test', messages: [{ role: 'user', content: 'Hello' }], [field]: 131072 }, { test: { output: 16384 } }), e => e.param === field && /131072/.test(e.message) && /16384/.test(e.message));
  }
});
