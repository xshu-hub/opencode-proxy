// Derived verbatim from Magpie app.js ledDecode/ledRowSpeed, MIT (c) yetone.
// Source commit 210234a5f33e0f2643f82b4337e249cf0fe81371; usage.go DecodeOf matches this.
const ledFailed_ = r => r.status >= 400 || !!r.err;
export const ledDecode = (r) => {
  if (ledFailed_(r) || !(r.ttft_ms > 0)) return null;
  const think = r.reasoning > 0, n = think ? r.out - r.reasoning : r.out, from = think ? r.first_text_ms : r.ttft_ms;
  const w = r.ms - from;
  if (!(n > 0 && from > 0 && w >= 100 && n * 1000 <= 10000 * w)) return null;
  if (r.flow_ms > 0 && r.flow_ms * 4 < w) return null;
  if (think && n * (r.first_text_ms - r.ttft_ms) > 20 * r.reasoning * w) return null;
  return { n, w };
};
// how fast a reply wrote, in tokens a second: 0 when it can't tell
export const ledRowSpeed = (r) => { const d = ledDecode(r); return d ? d.n / (d.w / 1000) : 0; };


// Port of gateway/ttft.go flowMs. Content event bytes, not invented tokens.
export function flowMs(marks,from){
  if(!(from>0)||!marks.length)return 0;
  let base=0;for(const m of marks){if(m.at>=from)break;base=m.sum;}
  const total=marks.at(-1).sum-base;if(total<=0)return 0;
  const at=share=>marks.find(m=>(m.sum-base)*100>=total*share&&m.at>=from)?.at??marks.at(-1).at;
  return Math.max(Math.floor((at(90)-at(10))*10/8),1);
}
