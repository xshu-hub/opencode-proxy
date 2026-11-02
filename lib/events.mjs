import { ApiError, usageOf } from './protocol.mjs';

// Read native events independently of downstream consumption. A slow client
// must not turn a healthy upstream into an idle-timeout error.
export function eventBuffer({ sessionID, lifecycle, abort, stop, structured=false, limit = 8 * 1024 * 1024 }) {
  const queue = [];
  const assistants = new Set();
  const parts = new Map();
  let head = 0, bytes = 0, ended = false, stopping = false, failure, errorEvent, wake;
  const notify = () => { wake?.(); wake = undefined; };
  const cancel = error => {
    queue.length = 0; head = 0; bytes = 0; assistants.clear(); parts.clear(); errorEvent = undefined;
    ended = true; if (error) failure = error;
    if (!stopping) { stopping = true; stop(); }
    notify();
  };
  const end = error => {
    if (ended) return;
    if (!error && !stopping && !lifecycle.completed && !lifecycle.signal?.aborted) error = new ApiError('OpenCode disconnected before completion.', 502, null, 'incomplete_stream');
    failure = error; ended = true;
    if (error && !stopping && !lifecycle.signal?.aborted) abort(error instanceof ApiError ? error : new ApiError('OpenCode event stream failed.', 502, null, 'opencode_events'));
    notify();
  };
  const push = event => {
    if (ended || stopping) return;
    try {
      const p = event.properties ?? {};
      if (p.sessionID !== sessionID && p.part?.sessionID !== sessionID && p.info?.sessionID !== sessionID) return;
      if (event.type === 'message.updated' && p.info?.role === 'assistant') {assistants.add(p.info.id);if(structured&&p.info.structured!==undefined)lifecycle.complete();}
      if (event.type === 'message.part.delta' && assistants.has(p.messageID) && p.field === 'text' && p.delta) lifecycle.progress();
      if (event.type === 'message.part.updated' && assistants.has(p.part?.messageID)) {
        const part = p.part;
        const marker = part.type === 'tool' ? part.state?.status : part.text?.length;
        if (marker && marker !== parts.get(part.id)) lifecycle.progress();
        parts.set(part.id, marker);
        if (part.type === 'step-finish') { lifecycle.tokens=part.tokens; if(part.tokens)lifecycle.usage=usageOf(part.tokens); lifecycle.cost=part.cost; if(!structured)lifecycle.complete(); }
      }
      if (event.type === 'session.error' || p.info?.error) { errorEvent = event; lifecycle.stop(); }
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > limit) throw new ApiError('Client is not consuming OpenCode output fast enough.', 502, null, 'slow_consumer');
      queue.push({ event, size }); bytes += size;
      notify();
    } catch (error) { end(error); }
  };
  const iterator = (async function* () {
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
      cancel();
    }
  })();
  return { push, end, cancel, get errorEvent() { return errorEvent; }, get failure() { return failure; }, get bytes() { return bytes; },
    events: { next: () => iterator.next(), return: () => { cancel(); return iterator.return(); }, [Symbol.asyncIterator]() { return this; } },
  };
}

export function bufferEvents(source, options) {
  const buffer = eventBuffer(options);
  const pump = (async () => {
    try { for await (const event of source) buffer.push(event); buffer.end(); }
    catch (error) { buffer.end(error); }
  })();
  return (async function* () {
    try { yield* buffer.events; }
    finally { buffer.cancel(); await source.return().catch(() => {}); await pump; }
  })();
}
