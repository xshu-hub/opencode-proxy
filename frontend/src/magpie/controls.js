/* Derived from Magpie app.js, MIT (c) 2026 yetone. Source: 210234a5f33e0f2643f82b4337e249cf0fe81371.
 * Original DOM/effort/pointer/keyboard controls; backend callbacks adapted. */
const t=(s,vars={})=>Object.entries(vars).reduce((v,[k,x])=>v.replaceAll('{'+k+'}',x),({default:'跟随 OpenCode',none:'关闭思考',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最高'}[s]??s));
const EFFORT_ORDER=['off','none','minimal','low','medium','high','xhigh','max'];
const optionFor=(f,value)=>(f.options??[]).find(o=>o.value===value);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg(d, size = 12, stroke = 1.6) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("width", size);
  s.setAttribute("height", size);
  s.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
  return s;
}

function effortName(option) {
  if (!option?.value) return t("default");
  return t(option.label || option.value);
}

function effortStops(f) {
  const options = f?.options || [];
  if (!f || options.some((o) => o.value === f.value)) return options;
  const r = EFFORT_ORDER.indexOf(f.value);
  const i = r < 0 ? 0 : options.findIndex((o) => EFFORT_ORDER.indexOf(o.value) > r);
  const cut = i < 0 ? options.length : i;
  return [...options.slice(0, cut), { value: f.value }, ...options.slice(cut)];
}

function effortLit(f, n) {
  const levels = effortStops(f).filter((o) => o.value && !["off", "none", "auto"].includes(o.value) &&
    (EFFORT_ORDER.includes(o.value) || f.options?.includes(o)));
  const at = levels.findIndex((o) => o.value === f.value);
  return at < 0 ? 0 : Math.max(1, Math.round(((at + 1) / levels.length) * n));
}

function effortIcon(f) {
  const lit = effortLit(f, 4);
  const e = el("span", "ic effort-ic");
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.innerHTML = [4, 7, 10, 13].map((h, i) =>
    `<rect x="${1.25 + i * 3.6}" y="${14.5 - h}" width="2.6" height="${h}" rx="1" fill="currentColor" opacity="${i < lit ? 1 : 0.28}"/>`).join("");
  e.append(s);
  return e;
}

function effortBars(f) {
  const e = el("span", "eff");
  e.dataset.l = effortLit(f, 3);
  e.append(el("i"), el("i"), el("i"));
  if (f) e.title = t("{label}: {value}", { label: t(f.label), value: effortName(optionFor(f, f.value) || { value: f.value }) });
  return e;
}

function effortSeg(a, f) {
  // a value that isn't one of the levels offered is a stop of its own, as
  // the picker's current value is (shown as the lowest level, a touch wrote
  // that level over it)
  const options = effortStops(f);
  const last = Math.max(1, options.length - 1);
  const box = el("div", "effort-control");
  const head = el("div", "effort-head");
  const value = el("b");
  head.append(el("span", "", t(f.label)), value);
  const track = el("div", "eslide");
  track.tabIndex = 0;
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", t(f.label));
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(options.length - 1));
  const rail = el("span", "rail");
  rail.append(el("span", "fill"));
  const ticks = el("span", "effort-ticks");
  ticks.setAttribute("aria-hidden", "true");
  ticks.append(...options.map((_, i) => {
    const dot = el("i");
    dot.style.setProperty("--at", i / last);
    return dot;
  }));
  track.append(rail, ticks, el("span", "knob"));
  const ends = el("div", "effort-ends");
  ends.setAttribute("aria-hidden", "true");
  ends.append(el("span", "", effortName(options[0])), el("span", "", effortName(options[options.length - 1])));
  box.append(head, track, ends);
  let at = options.findIndex((o) => o.value === f.value);
  const show = (i) => {
    at = i;
    track.style.setProperty("--p", i / last);
    [...ticks.children].forEach((dot, j) => { dot.classList.toggle("on", j < i); dot.classList.toggle("cur", j === i); });
    value.textContent = effortName(options[i]);
    track.setAttribute("aria-valuenow", String(i));
    track.setAttribute("aria-valuetext", effortName(options[i]));
  };
  let saving = Promise.resolve();
  const commit = () => {
    const o = options[at];
    if (!o || o.value === f.value) return;
    f.value = o.value;
    
    saving = saving.then(async () => {
      await a.commit(o.value);
    }).catch((e) => { a.failed(e); });
  };
  const stopAt = (x) => {
    const r = rail.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * last);
  };
  track.onpointerdown = (ev) => {
    track.setPointerCapture(ev.pointerId);
    track.classList.add("drag");
    show(stopAt(ev.clientX));
  };
  track.onpointermove = (ev) => { if (track.classList.contains("drag")) show(stopAt(ev.clientX)); };
  track.onpointerup = track.onpointercancel = () => {
    if (!track.classList.contains("drag")) return;
    track.classList.remove("drag");
    commit();
  };
  track.onkeydown = (ev) => {
    const to = { ArrowLeft: at - 1, ArrowDown: at - 1, ArrowRight: at + 1, ArrowUp: at + 1, Home: 0, End: options.length - 1 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    show(Math.max(0, Math.min(options.length - 1, to)));
    commit();
  };
  show(at);
  return box;
}

function providerSwitch(p) {
  const on = !p.off;
  const s = el("button", "lib-switch pswitch" + (on ? " on" : ""));
  s.setAttribute("role", "switch");
  s.setAttribute("aria-checked", on ? "true" : "false");
  s.setAttribute("aria-label", t("Use {name}", { name: p.name }));
  s.title = on ? t("On · switch it off and agents no longer get its models; its keys and settings are kept") : t("Off · switch it on and agents get its models again");
  s.append(el("i"));
  s.onclick = (e) => { e.stopPropagation(); p.commit(!on, s); };
  return s;
}
export {el,svg,effortName,effortStops,effortLit,effortIcon,effortBars,effortSeg,providerSwitch};
