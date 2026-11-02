// Test-only inspection; production forwards bytes without parsing SSE.
export async function* sseEvents(body) {
  let buffer = '';
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n\n'); if (end < 0) break;
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const value = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (value === '[DONE]') return;
      if (value) yield JSON.parse(value);
    }
  }
}
