import { ApiError } from './protocol.mjs';

// Read native events independently of downstream consumption. A slow client
// must not turn a healthy upstream into an idle-timeout error.
export function bufferEvents(source, { sessionID, lifecycle, abort, stop, limit = 8 * 1024 * 1024 }) {
  const queue = [];
  const assistants = new Set();
  const parts = new Map();
  let head = 0, bytes = 0, ended = false, stopping = false, failure, wake;
  const pump = (async () => {
    try {
      for await (const event of source) {
        const p = event.properties ?? {};
        if (p.sessionID !== sessionID && p.part?.sessionID !== sessionID && p.info?.sessionID !== sessionID) continue;
        if (event.type === 'message.updated' && p.info?.role === 'assistant') assistants.add(p.info.id);
        if (event.type === 'message.part.delta' && assistants.has(p.messageID) && p.field === 'text' && p.delta) lifecycle.progress();
        if (event.type === 'message.part.updated' && assistants.has(p.part?.messageID)) {
          const part = p.part;
          const marker = part.type === 'tool' ? part.state?.status : part.text?.length;
          if (marker && marker !== parts.get(part.id)) lifecycle.progress();
          parts.set(part.id, marker);
          if (part.type === 'step-finish') lifecycle.complete();
        }
        if (event.type === 'session.error' || p.info?.error) lifecycle.stop();
        const size = Buffer.byteLength(JSON.stringify(event));
        if (bytes + size > limit) throw new ApiError('Client is not consuming OpenCode output fast enough.', 502, null, 'slow_consumer');
        queue.push({ event, size }); bytes += size;
        wake?.(); wake = undefined;
      }
      if (!stopping && !lifecycle.completed && !lifecycle.signal?.aborted) throw new ApiError('OpenCode disconnected before completion.', 502, null, 'incomplete_stream');
    } catch (error) {
      failure = error;
      if (!stopping && !lifecycle.signal?.aborted) abort(error instanceof ApiError ? error : new ApiError('OpenCode event stream failed.', 502, null, 'opencode_events'));
    } finally { ended = true; wake?.(); wake = undefined; }
  })();
  return (async function* () {
    try {
      while (true) {
        if (head < queue.length) {
          const item = queue[head]; queue[head++] = undefined; bytes -= item.size;
          if (head > 1024 && head > queue.length / 2) { queue.splice(0, head); head = 0; }
          yield item.event;
        } else if (ended) {
          if (failure) throw failure;
          break;
        } else await new Promise(resolve => { wake = resolve; });
      }
    } finally {
      queue.length = 0; bytes = 0;
      // The owner aborts the native HTTP stream before returning the iterator.
      stopping = true;
      stop();
      await source.return().catch(() => {});
      await pump;
    }
  })();
}
