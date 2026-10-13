export function node(tag, cls = "", text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = String(text);
  return n;
}
export function append(n, ...children) {
  n.append(
    ...children.filter(
      (c) => c !== undefined && c !== null && typeof c !== "boolean",
    ),
  );
  return n;
}
const paths = {
  models: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  gateway: "M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01",
  code: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14",
  network:
    "M12 3v6m-7 8v-5h14v5M3 17h4v4H3zM10 17h4v4h-4zM17 17h4v4h-4zM10 3h4v4h-4z",
  sliders: "M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6",
  refresh:
    "M20 7v5h-5M4 17v-5h5M5.4 8a7 7 0 0 1 11.6-3L20 8M4 16l3 3a7 7 0 0 0 11.6-3",
  sun: "M12 3v1m0 16v1M3 12h1m16 0h1M5.6 5.6l.7.7m11.4 11.4.7.7m0-12.8-.7.7M6.3 17.7l-.7.7M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  moon: "M20.4 13a8 8 0 1 1-9.4-9.4A6 6 0 0 0 20.4 13",
  copy: "M9 9h11v11H9zM15 5V3H3v12h2",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M6 18 18 6",
  chevron: "m9 5 7 7-7 7",
  search: "M15 15l6 6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  plus: "M12 5v14M5 12h14",
  key: "M10 14a5 5 0 1 1 0-7M10 10h11m-3 0v3m-3-3v2",
  play: "m8 5 11 7-11 7z",
  stop: "M6 6h12v12H6z",
  folder: "M3 7h7l2-3h9v16H3z",
  terminal: "m5 6 6 6-6 6m8 0h6",
  external: "M14 3h7v7m0-7L10 14M10 3H3v18h18v-7",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z",
  info: "M12 11v6m0-10h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  reset: "M3 10V4m0 6h6m-6 0 4-4a8 8 0 1 1-1 11",
};
export function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: "18",
    height: "18",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    s.setAttribute(k, v);
  const p = document.createElementNS(s.namespaceURI, "path");
  p.setAttribute("d", paths[name] || paths.models);
  s.append(p);
  return s;
}
export function button(
  label,
  action,
  { kind = "", glyph, small = false } = {},
) {
  const b = node("button", "button " + kind + (small ? " small" : ""));
  b.type = "button";
  append(b, glyph && icon(glyph), node("span", "", label));
  if (action) b.onclick = action;
  return b;
}
export function badge(text, kind = "muted") {
  return node("span", "badge " + kind, text);
}
export function hint(text) {
  return node("p", "hint", text);
}
export function heading(title, subtitle, actions) {
  return append(
    node("div", "page-heading"),
    append(
      node("div"),
      node("h1", "", title),
      node("p", "page-subtitle", subtitle),
    ),
    actions && append(node("div", "heading-actions"), ...actions),
  );
}
export function card(title, subtitle, content, actions) {
  return append(
    node("section", "card"),
    append(
      node("div", "card-heading"),
      append(node("div"), node("h2", "", title), subtitle && hint(subtitle)),
      actions && append(node("div", "card-actions"), ...actions),
    ),
    content,
  );
}
export function field(label, control, description) {
  const direct = control.matches("input,select,textarea");
  const wrap = node(direct ? "label" : "div", "field");
  append(
    wrap,
    node("span", "field-label", label),
    control,
    description && node("span", "field-hint", description),
  );
  if (direct) control.setAttribute("aria-label", label);
  return wrap;
}
export function input(
  value = "",
  { placeholder = "", type = "text", min, max, step, name } = {},
) {
  const i = node("input", "input");
  i.type = type;
  i.value = value ?? "";
  i.placeholder = placeholder;
  i.autocomplete = "off";
  if (name) i.name = name;
  for (const [k, v] of Object.entries({ min, max, step }))
    if (v !== undefined) i[k] = v;
  return i;
}
export function select(options, value = "", name) {
  const s = node("select", "input");
  if (name) s.setAttribute("aria-label", name);
  for (const [v, label] of options) {
    const o = node("option", "", label);
    o.value = String(v);
    s.append(o);
  }
  s.value = String(value ?? "");
  return s;
}
export function toggle(label, checked, change) {
  const b = node("button", "toggle");
  b.type = "button";
  b.role = "switch";
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-checked", String(!!checked));
  b.append(node("span", "toggle-thumb"));
  b.onclick = () => change(!checked, b);
  return b;
}
export function checkbox(label, checked = false) {
  const c = input("", { type: "checkbox" });
  c.checked = checked;
  const l = append(node("label", "check-label"), c, node("span", "", label));
  return { element: l, input: c };
}
export function toast(message, error = false) {
  const box = document.querySelector("#toasts"),
    t = append(
      node("div", "toast" + (error ? " error" : "")),
      icon(error ? "info" : "check"),
      node("span", "", message),
    );
  box.append(t);
  setTimeout(() => t.remove(), 5000);
}
export async function busy(b, task) {
  if (b.disabled) return;
  b.disabled = true;
  b.setAttribute("aria-busy", "true");
  try {
    return await task();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (b.isConnected) {
      b.disabled = false;
      b.removeAttribute("aria-busy");
    }
  }
}
export function errorLine() {
  const n = node("p", "form-error");
  n.role = "alert";
  n.hidden = true;
  n.show = (message) => {
    n.textContent = message;
    n.hidden = !message;
  };
  return n;
}
export function copyButton(value, label = "复制") {
  const b = button(
    label,
    async () => {
      await busy(b, async () => {
        await (
          await import("./api.js")
        ).copy(typeof value === "function" ? value() : value);
        toast("已复制");
      });
    },
    { glyph: "copy", small: true },
  );
  return b;
}
export function dialog(title, subtitle, { drawer = false } = {}) {
  const d = node("dialog", drawer ? "dialog drawer" : "dialog");
  d.setAttribute("aria-label", title);
  const close = button(
    "关闭",
    () => {
      if (d.dispatchEvent(new Event("cancel", { cancelable: true }))) d.close();
    },
    { glyph: "close", kind: "icon-button" },
  );
  close.setAttribute("aria-label", "关闭" + title);
  append(
    d,
    append(
      node("div", "dialog-heading"),
      append(node("div"), node("h2", "", title), subtitle && hint(subtitle)),
      close,
    ),
  );
  document.body.append(d);
  const prior = document.activeElement,
    show = d.showModal.bind(d);
  d.showModal = () => {
    document.body.classList.add("modal-open");
    show();
  };
  d.addEventListener(
    "close",
    () => {
      d.remove();
      if (!document.querySelector("dialog[open]"))
        document.body.classList.remove("modal-open");
      prior?.focus?.();
    },
    { once: true },
  );
  return d;
}
export function confirmAction(
  title,
  message,
  { danger = false, label = "确认" } = {},
) {
  return new Promise((resolve) => {
    const d = dialog(title);
    append(d, node("p", "dialog-message", message));
    const finish = (v) => {
      resolve(v);
      d.close();
    };
    d.addEventListener("cancel", () => resolve(false), { once: true });
    d.append(
      append(
        node("div", "dialog-footer"),
        button("取消", () => finish(false)),
        button(label, () => finish(true), {
          kind: danger ? "danger" : "primary",
        }),
      ),
    );
    d.addEventListener("close", () => resolve(false), { once: true });
    d.showModal();
  });
}
export function empty(title, description, action) {
  return append(
    node("div", "empty-state"),
    node("div", "empty-icon").appendChild(icon("models")).parentElement,
    node("h3", "", title),
    hint(description),
    action,
  );
}
export const numberLabel = (n) =>
  Number.isFinite(n)
    ? new Intl.NumberFormat("zh-CN", {
        notation: n >= 10000 ? "compact" : "standard",
        maximumFractionDigits: 1,
      }).format(n)
    : "—";
