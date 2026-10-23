import { api, desktop, updateConfig } from "./api.js";
import {
  node,
  append,
  icon,
  button,
  badge,
  hint,
  heading,
  card,
  field,
  input,
  select,
  toggle,
  checkbox,
  toast,
  busy,
  errorLine,
  copyButton,
  dialog,
  confirmAction,
  empty,
  numberLabel,
} from "./ui.js";
import { openModel } from "./model-form.js";
import { filteredModels, effortLabels, commandFields } from "./model-data.js";
import { drawChannels } from "./channels.js";

const pages = {
  models: {
    title: "模型",
    icon: "models",
    subtitle: "连接全局 OpenCode，管理对外模型与默认参数。",
  },
  gateway: {
    title: "网关",
    icon: "gateway",
    subtitle: "统一连接地址、访问密钥和三种模型 API。",
  },
  opencode: {
    title: "OpenCode",
    icon: "terminal",
    subtitle: "选择全局程序与工作目录，复用已有登录和供应商配置。",
  },
  channels: {
    title: "上游渠道",
    icon: "key",
    subtitle: "多 Key 轮转、会话绑定和滑动过期。",
  },
  network: {
    title: "网络与超时",
    icon: "network",
    subtitle: "配置监听地址、请求并发与工作进程。",
  },
  general: {
    title: "外观与运行",
    icon: "sliders",
    subtitle: "调整显示方式，管理客户端后台运行。",
  },
};
const root = document.querySelector("#content"),
  nav = document.querySelector("#navigation");
let state = null,
  models = [],
  catalogError = "",
  page = resolvePage(),
  query = "",
  provider = "",
  enabledFilter = "all",
  selected = new Set(),
  offset = 0,
  protocol = "chat",
  language = "curl",
  connectModel = "",
  connectKey = "",
  pendingSettings = false,
  settingsSaving = false,
  stateRead = 0,
  lastEndpoint = "";
const pageSize = 30,
  protocols = {
    chat: {
      name: "OpenAI",
      route: "/chat/completions",
      env: "OPENAI_API_KEY",
      description: "Chat Completions，适合常见 OpenAI 兼容客户端。",
    },
    responses: {
      name: "Responses",
      route: "/responses",
      env: "OPENAI_API_KEY",
      description: "文本、思考与函数工具；会话历史由客户端传入。",
    },
    anthropic: {
      name: "Anthropic",
      route: "/messages",
      env: "ANTHROPIC_API_KEY",
      description: "Messages 接口；Claude Code 使用 ANTHROPIC_AUTH_TOKEN。",
    },
  };
function resolvePage() {
  const p = new URLSearchParams(location.search);
  let value = p.get("view");
  if (value === "providers") value = "models";
  if (value === "settings")
    value = ["opencode", "network", "general"].includes(p.get("tab"))
      ? p.get("tab")
      : "general";
  return pages[value] ? value : "models";
}
function endpoint() {
  return (
    state?.endpoint ||
    lastEndpoint ||
    "http://" +
      (state?.settings.host === "0.0.0.0"
        ? "127.0.0.1"
        : state?.settings.host || "127.0.0.1") +
      ":" +
      (state?.settings.port || 8787) +
      "/v1"
  );
}
function applyAppearance() {
  document.documentElement.dataset.theme =
    localStorage.getItem("opencode-proxy.theme") || "system";
  document.documentElement.style.setProperty(
    "--font-scale",
    String(Number(localStorage.getItem("opencode-proxy.size") || 100) / 100),
  );
}
function drawNav() {
  nav.replaceChildren();
  nav.append(node("div", "nav-label", "工作空间"));
  for (const [id, p] of Object.entries(pages)) {
    if (id === "opencode") nav.append(node("div", "nav-label", "配置"));
    const a = append(
      node("a", "nav-item"),
      icon(p.icon),
      node("span", "", p.title),
    );
    a.href = "?view=" + id;
    if (page === id) a.setAttribute("aria-current", "page");
    if (id === "models") a.append(node("span", "nav-count", models.length));
    a.onclick = (e) => {
      e.preventDefault();
      void navigate(id);
    };
    nav.append(a);
  }
}
function paintStatus() {
  const n = document.querySelector("#gateway-status");
  n.replaceChildren();
  n.className = "badge " + (state?.running ? "success" : "muted");
  append(
    n,
    node("span", "status-dot"),
    node(
      "span",
      "",
      state ? (state.running ? "网关运行中" : "网关已停止") : "正在连接",
    ),
  );
}
async function readState() {
  const seq = ++stateRead,
    next = await api("/admin/state");
  if (seq === stateRead) {
    const moved = state?.running !== next.running;
    state = next;
    if (next.endpoint) lastEndpoint = next.endpoint;
    paintStatus();
    if (moved && page === "gateway") updateBanner();
  }
  return next;
}
async function readModels(refresh = false) {
  try {
    const result = await api(
      refresh ? "/admin/refresh" : "/admin/models",
      refresh ? {} : undefined,
    );
    models = result.models;
    catalogError = "";
    const targets = new Set(models.map((m) => m.target));
    selected = new Set([...selected].filter((t) => targets.has(t)));
    drawNav();
  } catch (e) {
    catalogError = e.message;
    throw e;
  }
}
function bindState(next) {
  stateRead++;
  state = next;
  if (next.endpoint) lastEndpoint = next.endpoint;
  paintStatus();
}
async function navigate(id, replace = false) {
  if (settingsSaving) {
    toast("配置正在保存，请稍候。");
    return false;
  }
  if (!pages[id]) id = "models";
  if (
    pendingSettings &&
    !(await confirmAction(
      "放弃未保存的设置？",
      "当前页面还有尚未保存的修改。",
      { label: "放弃修改" },
    ))
  )
    return false;
  pendingSettings = false;
  page = id;
  const url = "?view=" + page;
  if (replace) history.replaceState(null, "", url);
  else if (location.search !== url) history.pushState(null, "", url);
  drawNav();
  draw();
  root.scrollTop = 0;
  window.scrollTo(0, 0);
  return true;
}
addEventListener("popstate", async () => {
  if (!(await navigate(resolvePage(), true)))
    history.replaceState(null, "", "?view=" + page);
});
addEventListener("beforeunload", (e) => {
  if (pendingSettings || document.querySelector('dialog[data-dirty="true"]')) {
    e.preventDefault();
    e.returnValue = "";
  }
});
function draw() {
  document.querySelector("#page-label").textContent = pages[page].title;
  root.replaceChildren();
  if (!state) {
    root.append(
      heading("连接本地服务", "正在读取配置，导航和设置会在连接后就绪。"),
      empty(
        "服务尚未连接",
        "请确认本地服务已启动。",
        button("重新连接", initialize, { kind: "primary", glyph: "refresh" }),
      ),
    );
    return;
  }
  if (page === "models") drawModels();
  else if (page === "gateway") drawGateway();
  else if (page === "opencode") drawOpenCode();
  else if (page === "channels") drawChannels(root, state, async (next, refreshModels) => {
    bindState(next);
    if (refreshModels) await readModels();
    draw();
  });
  else if (page === "network") drawNetwork();
  else drawGeneral();
}
const info = (text) =>
  append(node("div", "notice"), icon("info"), node("p", "", text));

function drawModels() {
  const refresh = button(
    "同步模型",
    () =>
      busy(refresh, async () => {
        await readModels(true);
        if (page === "models") drawModelsPage();
        toast("已同步全局模型列表");
      }),
    { glyph: "refresh" },
  );
  root.append(heading("模型", pages.models.subtitle, [refresh]));
  if (catalogError) root.append(info(catalogError));
  const cardNode = node("section", "card"),
    filters = node("div", "filter-bar"),
    search = input(query, { placeholder: "搜索模型名称、别名或供应商" });
  search.type = "search";
  search.setAttribute("aria-label", "搜索模型");
  const searchWrap = append(node("div", "search-box"), icon("search"), search);
  const providers = [
    ...new Set(models.map((m) => m.target.split("/")[0])),
  ].sort();
  if (provider && !providers.includes(provider)) provider = "";
  const providerSelect = select(
      [["", "所有供应商"], ...providers.map((id) => [id, id])],
      provider,
      "供应商筛选",
    ),
    onSelect = select(
      [
        ["all", "全部状态"],
        ["on", "已启用"],
        ["off", "已停用"],
      ],
      enabledFilter,
      "模型状态筛选",
    );
  append(filters, searchWrap, providerSelect, onSelect);
  cardNode.append(filters);
  const selection = node("div", "selection-bar"),
    tableHost = node("div", "table-wrap"),
    foot = node("div", "table-footer");
  append(
    cardNode,
    append(node("div", "card-body selection-area"), selection),
    tableHost,
    foot,
  );
  root.append(cardNode);
  const filtered = () =>
    filteredModels(models, { query, provider, enabled: enabledFilter });
  const bulk = async (value, b) =>
    busy(b, async () => {
      const targets = [...selected];
      await api("/admin/model", { targets, patch: { enabled: value } });
      await readModels();
      if (page === "models") drawModelsPage();
      toast(value ? "所选模型已启用" : "所选模型已停用");
    });
  const selectionPaint = () => {
    selection.replaceChildren();
    const shown = filtered(),
      count = selected.size;
    selection.append(
      node(
        "span",
        "hint",
        count
          ? "已选择 " + count + " 个模型"
          : models.filter((m) => m.enabled).length +
              " 个已启用 / " +
              models.length +
              " 个模型",
      ),
    );
    if (count) {
      const on = button("启用", () => bulk(true, on), { small: true }),
        off = button("停用", () => bulk(false, off), { small: true });
      append(
        selection,
        on,
        off,
        button(
          "取消选择",
          () => {
            selected.clear();
            paintTable();
          },
          { kind: "ghost", small: true },
        ),
      );
    } else
      selection.append(
        button(
          "选择筛选结果",
          () => {
            for (const m of shown) selected.add(m.target);
            paintTable();
          },
          { small: true, kind: "ghost" },
        ),
      );
  };
  function paintTable() {
    selectionPaint();
    tableHost.replaceChildren();
    foot.replaceChildren();
    const list = filtered();
    offset = Math.max(
      0,
      Math.min(
        offset,
        Math.max(0, Math.ceil(list.length / pageSize) - 1) * pageSize,
      ),
    );
    if (!list.length) {
      tableHost.append(
        empty(
          models.length ? "没有匹配的模型" : "还没有读取到模型",
          models.length
            ? "试试其他名称或筛选条件。"
            : "在 OpenCode 中配置供应商后同步模型。",
          !models.length
            ? button("配置 OpenCode", () => navigate("opencode"), {
                kind: "primary",
              })
            : null,
        ),
      );
      return;
    }
    const table = node("table"),
      thead = node("thead"),
      headers = node("tr");
    for (const title of [
      "",
      "模型",
      "供应商",
      "能力",
      "上下文 / 输出",
      "启用",
      "",
    ])
      headers.append(node("th", "", title));
    const choosePage = input("", { type: "checkbox" });
    choosePage.className = "row-select";
    choosePage.setAttribute("aria-label", "选择当前页");
    const shown = list.slice(offset, offset + pageSize);
    choosePage.checked = shown.every((m) => selected.has(m.target));
    choosePage.indeterminate =
      !choosePage.checked && shown.some((m) => selected.has(m.target));
    choosePage.onchange = () => {
      for (const m of shown)
        choosePage.checked ? selected.add(m.target) : selected.delete(m.target);
      paintTable();
    };
    headers.firstChild.append(choosePage);
    thead.append(headers);
    table.append(thead);
    const tbody = node("tbody");
    for (const m of shown) {
      const row = node("tr"),
        check = input("", { type: "checkbox" });
      check.className = "row-select";
      check.checked = selected.has(m.target);
      check.setAttribute("aria-label", "选择 " + m.id);
      check.onchange = () => {
        check.checked ? selected.add(m.target) : selected.delete(m.target);
        selectionPaint();
        choosePage.checked = shown.every((x) => selected.has(x.target));
        choosePage.indeterminate =
          !choosePage.checked && shown.some((x) => selected.has(x.target));
      };
      const own = m.target.split("/").slice(1).join("/"),
        name = append(
          node("div", "model-cell"),
          node("div", "model-symbol", m.id.slice(0, 1).toUpperCase()),
          append(
            node("div"),
            node("strong", "", m.id),
            node("span", "cell-sub", own !== m.id ? own : "自动同步"),
          ),
        ),
        caps = node("div", "caps");
      if (m.reasoning) caps.append(badge("思考", "accent"));
      if (m.toolcall) caps.append(badge("工具"));
      if (!m.reasoning && !m.toolcall) caps.append(badge("文本"));
      const limits = append(
        node("div"),
        node("span", "mono", numberLabel(m.context)),
        node("span", "cell-sub", numberLabel(m.output) + " 输出"),
      );
      const edit = button(
        "配置",
        () =>
          openModel(
            m,
            state.settings.modelOverrides[m.target] || {},
            async (patch) => {
              await api("/admin/model", { target: m.target, patch });
              await readModels();
              await readState();
              if (page === "models") drawModelsPage();
              toast("模型配置已保存");
            },
          ),
        { small: true },
      );
      const test = button("测试", () => testModel(m), {
        small: true,
        kind: "ghost",
        glyph: "play",
      });
      const sw = toggle("启用 " + m.id, m.enabled, (value, b) =>
        busy(b, async () => {
          await api("/admin/model", {
            target: m.target,
            patch: { enabled: value },
          });
          await readModels();
          if (page === "models") drawModelsPage();
          toast(value ? "模型已启用" : "模型已停用");
        }),
      );
      append(
        row,
        append(node("td"), check),
        append(node("td"), name),
        node("td", "", m.target.split("/")[0]),
        append(node("td"), caps),
        append(node("td"), limits),
        append(node("td"), sw),
        append(node("td"), append(node("div", "cell-actions"), test, edit)),
      );
      tbody.append(row);
    }
    table.append(tbody);
    tableHost.append(table);
    foot.append(
      node(
        "span",
        "",
        `显示 ${offset + 1}–${Math.min(offset + pageSize, list.length)}，共 ${list.length} 个模型`,
      ),
    );
    const previous = button(
        "上一页",
        () => {
          offset -= pageSize;
          paintTable();
        },
        { small: true },
      ),
      next = button(
        "下一页",
        () => {
          offset += pageSize;
          paintTable();
        },
        { small: true },
      );
    previous.disabled = offset === 0;
    next.disabled = offset + pageSize >= list.length;
    foot.append(append(node("div", "inline-actions"), previous, next));
  }
  search.oninput = () => {
    query = search.value;
    offset = 0;
    paintTable();
  };
  providerSelect.onchange = () => {
    provider = providerSelect.value;
    offset = 0;
    paintTable();
  };
  onSelect.onchange = () => {
    enabledFilter = onSelect.value;
    offset = 0;
    paintTable();
  };
  paintTable();
  root.append(
    node(
      "p",
      "page-note",
      "模型名称保持简短。别名只影响本工具，对应的全局供应商和登录仍由 OpenCode 管理。",
    ),
  );
}
function drawModelsPage() {
  root.replaceChildren();
  drawModels();
}
function testModel(model) {
  const d = dialog("测试模型", model.id),
    body = node("div", "dialog-body"),
    prompt = input("请简短回复 OK。"),
    proto = select(
      Object.entries(protocols).map(([id, p]) => [id, p.name]),
      "chat",
    ),
    effort = select(
      [
        ["", "使用模型默认值"],
        ...(model.reasoningEfforts || []).map((e) => [e, effortLabels[e]]),
      ],
      "",
    ),
    result = node("div", "test-response"),
    error = errorLine();
  result.hidden = true;
  append(
    body,
    field("测试协议", proto),
    field("测试提示词", prompt),
    model.reasoning && field("测试思考强度", effort),
    error,
    result,
  );
  const send = button(
    "发送测试",
    async () => {
      error.show("");
      send.disabled = true;
      result.hidden = false;
      result.textContent = "正在等待真实 OpenCode 回复…";
      try {
        const data = await api("/admin/test", {
          model: model.id,
          prompt: prompt.value,
          protocol: proto.value,
          ...(effort.value ? { reasoning_effort: effort.value } : {}),
        });
        result.textContent =
          proto.value === "chat"
            ? data.choices?.[0]?.message?.content || "模型返回了工具调用。"
            : proto.value === "responses"
              ? data.output
                  ?.filter((x) => x.type === "message")
                  .flatMap((x) => x.content || [])
                  .filter((x) => x.type === "output_text")
                  .map((x) => x.text)
                  .join("") || "模型返回了工具调用。"
              : data.content
                  ?.filter((x) => x.type === "text")
                  .map((x) => x.text)
                  .join("") || "模型返回了工具调用。";
      } catch (e) {
        error.show(e.message);
        result.hidden = true;
      } finally {
        send.disabled = false;
      }
    },
    { kind: "primary", glyph: "play" },
  );
  append(d, body, append(node("div", "dialog-footer"), send));
  d.showModal();
}

function updateBanner() {
  const target = document.querySelector("#gateway-banner");
  if (!target) return;
  target.replaceChildren();
  const actions = node("div", "banner-actions");
  const start = button(
    state.running ? "重启网关" : "启动网关",
    () =>
      busy(start, async () => {
        if (state.running) await api("/admin/stop", {});
        bindState(await api("/admin/start", {}));
        updateBanner();
        drawConnection();
        toast("网关已启动");
      }),
    {
      glyph: state.running ? "refresh" : "play",
      kind: state.running ? "" : "primary",
    },
  );
  actions.append(start);
  if (state.running) {
    const stop = button(
      "停止网关",
      () =>
        busy(stop, async () => {
          bindState(await api("/admin/stop", {}));
          updateBanner();
          toast("网关已停止");
        }),
      { glyph: "stop" },
    );
    actions.append(stop);
  }
  append(
    target,
    append(node("div", "gateway-symbol"), icon("gateway")),
    append(
      node("div"),
      node("h2", "", state.running ? "网关正在运行" : "网关已停止"),
      hint(
        models.filter((m) => m.enabled).length +
          " 个启用模型 · 三种兼容协议 · " +
          (state.settings.maxConcurrent === 0
            ? "不限并发"
            : "最多 " + state.settings.maxConcurrent + " 并发"),
      ),
    ),
    actions,
  );
  if (state.startError)
    target.append(
      node(
        "p",
        "form-error",
        "监听失败：" +
          state.startError +
          "。请在“网络与超时”中修改地址或端口。",
      ),
    );
}
function drawGateway() {
  root.append(heading("网关", pages.gateway.subtitle));
  const banner = node("section", "gateway-banner");
  banner.id = "gateway-banner";
  root.append(banner);
  updateBanner();
  const columns = node("div", "gateway-columns"),
    connection = node("section", "card"),
    keys = node("section", "card"),
    enabledModels = node("section", "card");
  connection.id = "connection-card";
  keys.id = "keys-card";
  enabledModels.id = "gateway-models";
  append(
    columns,
    connection,
    append(node("div", "gateway-side"), keys, enabledModels),
  );
  root.append(columns);
  drawConnection();
  drawKeys();
  drawGatewayModels();
  root.append(
    info(
      "网关访问 Key 与供应商凭证不同。所有请求均需携带已启用的 Key，推理会经过真实 OpenCode。",
    ),
  );
}
function drawGatewayModels() {
  const host = document.querySelector("#gateway-models");
  if (!host) return;
  const enabled = models.filter((m) => m.enabled);
  const all = copyButton(enabled.map((m) => m.id).join("\n"), "复制全部");
  all.disabled = !enabled.length;
  host.replaceChildren(
    append(
      node("div", "card-heading"),
      append(
        node("div"),
        node("h2", "", "可用模型"),
        hint("可直接用于 API 的纯模型名称。"),
      ),
      all,
    ),
  );
  for (const model of enabled.slice(0, 6)) {
    const pick = button(
      model.id,
      () => {
        connectModel = model.id;
        drawConnection();
      },
      { kind: "ghost model-name", small: true },
    );
    pick.title = "在请求示例中使用 " + model.id;
    host.append(
      append(node("div", "gateway-model-row"), pick, copyButton(model.id)),
    );
  }
  if (!enabled.length)
    host.append(append(node("div", "card-body"), hint("还没有启用模型。")));
  if (enabled.length > 6)
    host.append(
      append(
        node("div", "card-body"),
        hint("显示前 6 个，共 " + enabled.length + " 个启用模型。"),
        button("查看全部模型", () => navigate("models"), {
          kind: "ghost",
          small: true,
        }),
      ),
    );
}
function activeConnection() {
  const active = models.filter((m) => m.enabled),
    keys = state.settings.apiKeys.filter((k) => k.enabled);
  if (!active.some((m) => m.id === connectModel))
    connectModel = active[0]?.id || "";
  if (!keys.some((k) => k.id === connectKey)) connectKey = keys[0]?.id || "";
  return {
    model: active.find((m) => m.id === connectModel),
    key: keys.find((k) => k.id === connectKey),
  };
}
function snippet() {
  const { model, key } = activeConnection(),
    base = endpoint(),
    p = protocols[protocol],
    url = base + p.route,
    body =
      protocol === "chat"
        ? {
            model: model?.id || "",
            messages: [{ role: "user", content: "你好" }],
            stream: true,
          }
        : protocol === "responses"
          ? {
              model: model?.id || "",
              input: "你好",
              store: false,
              stream: true,
            }
          : {
              model: model?.id || "",
              max_tokens: Math.min(1024, model?.output || 1024),
              messages: [{ role: "user", content: "你好" }],
              stream: true,
            };
  const secret = key?.key || "<网关 Key>";
  if (language === "curl") {
    const headers =
      protocol === "anthropic"
        ? ["x-api-key: " + secret, "anthropic-version: 2023-06-01"]
        : ["Authorization: Bearer " + secret];
    const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
    return (
      "curl -N " +
      quote(url) +
      " \\\n" +
      [...headers, "Content-Type: application/json"]
        .map((h) => "  -H " + quote(h) + " \\\n")
        .join("") +
      "  -d " +
      quote(JSON.stringify(body, null, 2))
    );
  }
  if (language === "powershell") {
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    return `$env:${protocol === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"} = ${quote(protocol === "anthropic" ? base.replace(/\/v1$/, "") : base)}\n$env:${p.env} = ${quote(secret)}\n\n# 流式请求示例：请切换 curl，或在客户端中填写上述地址与 Key。`;
  }
  return protocol === "anthropic"
    ? `import anthropic\n\nclient = anthropic.Anthropic(\n    base_url=${JSON.stringify(base.replace(/\/v1$/, ""))},\n    api_key=${JSON.stringify(secret)},\n)\nwith client.messages.stream(\n    model=${JSON.stringify(model?.id || "")},\n    max_tokens=${body.max_tokens},\n    messages=[{"role": "user", "content": "你好"}],\n) as stream:\n    for text in stream.text_stream:\n        print(text, end="", flush=True)`
    : `from openai import OpenAI\n\nclient = OpenAI(base_url=${JSON.stringify(base)}, api_key=${JSON.stringify(secret)})\n${protocol === "responses" ? `stream = client.responses.create(\n    model=${JSON.stringify(model?.id || "")}, input="你好", store=False, stream=True,\n)\nfor event in stream:\n    if event.type == "response.output_text.delta":\n        print(event.delta, end="", flush=True)` : `stream = client.chat.completions.create(\n    model=${JSON.stringify(model?.id || "")},\n    messages=[{"role": "user", "content": "你好"}], stream=True,\n)\nfor chunk in stream:\n    if chunk.choices:\n        print(chunk.choices[0].delta.content or "", end="", flush=True)`}`;
}
function drawConnection() {
  const host = document.querySelector("#connection-card");
  if (!host) return;
  host.replaceChildren();
  host.append(
    append(
      node("div", "card-heading"),
      append(
        node("div"),
        node("h2", "", "客户端接入"),
        hint("复制地址与 Key，在客户端选择对应协议。"),
      ),
    ),
  );
  const body = node("div", "card-body"),
    tabs = node("div", "protocol-tabs");
  tabs.role = "tablist";
  tabs.setAttribute("aria-label", "API 协议");
  for (const [id, p] of Object.entries(protocols)) {
    const b = node("button", "", p.name);
    b.type = "button";
    b.role = "tab";
    b.setAttribute("aria-selected", String(protocol === id));
    b.onclick = () => {
      protocol = id;
      drawConnection();
    };
    tabs.append(b);
  }
  body.append(tabs, hint(protocols[protocol].description));
  const base =
    protocol === "anthropic" ? endpoint().replace(/\/v1$/, "") : endpoint();
  append(
    body,
    node("span", "connection-label", "Base URL"),
    append(node("div", "endpoint"), node("code", "", base), copyButton(base)),
  );
  const active = activeConnection(),
    keySelect = select(
      state.settings.apiKeys
        .filter((k) => k.enabled)
        .map((k) => [k.id, k.name]),
      connectKey,
    ),
    modelSelect = select(
      models.filter((m) => m.enabled).map((m) => [m.id, m.id]),
      connectModel,
    );
  keySelect.onchange = () => {
    connectKey = keySelect.value;
    drawConnection();
  };
  modelSelect.onchange = () => {
    connectModel = modelSelect.value;
    drawConnection();
  };
  append(
    body,
    append(
      node("div", "form-grid"),
      field("访问 Key", keySelect),
      field("模型", modelSelect),
    ),
  );
  if (!active.model)
    body.append(info("先在“模型”页面启用至少一个模型，再使用请求示例。"));
  else {
    const kinds = node("div", "segmented");
    for (const [id, label] of [
      ["curl", "curl"],
      ["python", "Python"],
      ["powershell", "PowerShell"],
    ]) {
      const b = node("button", "", label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(language === id));
      b.onclick = () => {
        language = id;
        drawConnection();
      };
      kinds.append(b);
    }
    const code = node("pre", "", snippet());
    append(
      body,
      node("h3", "section-title", "请求示例"),
      kinds,
      append(
        node("div", "code-block"),
        append(
          node("div", "code-toolbar"),
          node(
            "span",
            "",
            language === "curl"
              ? "终端 · macOS / Linux"
              : language === "python"
                ? "Python · 流式输出"
                : "Windows · 环境变量",
          ),
          copyButton(() => snippet(), "复制示例"),
        ),
        code,
      ),
    );
  }
  host.append(body);
}
async function editKeys(change) {
  bindState(await updateConfig((settings) => change(settings.apiKeys)));
  if (page === "gateway") {
    drawKeys();
    drawConnection();
  }
}
function drawKeys() {
  const host = document.querySelector("#keys-card");
  if (!host) return;
  host.replaceChildren();
  host.append(
    append(
      node("div", "card-heading"),
      append(
        node("div"),
        node("h2", "", "访问密钥"),
        hint("为每个客户端配置独立 Key。"),
      ),
      button("新增 Key", () => keyForm(), { glyph: "plus", small: true }),
    ),
  );
  for (const k of state.settings.apiKeys) {
    const name = button(k.name, () => keyForm(k), {
      kind: "ghost",
      small: true,
    });
    name.title = "重命名 " + k.name;
    const row = node("div", "key-row" + (!k.enabled ? " disabled" : ""));
    const controls = node("div", "key-controls");
    const copy = copyButton(() => k.key, "复制");
    copy.setAttribute("aria-label", "复制 " + k.name + " 的 Key");
    controls.append(copy);
    const rotate = button(
        "轮换",
        async () => {
          if (
            !(await confirmAction(
              "轮换 " + k.name + " 的 Key？",
              "旧 Key 会立即失效，请同步更新使用它的客户端。",
              { label: "轮换 Key" },
            ))
          )
            return;
          await busy(rotate, async () => {
            await editKeys((keys) => {
              keys.find((x) => x.id === k.id).key = newKey();
            });
            toast("Key 已轮换");
          });
        },
        { small: true, kind: "ghost" },
      ),
      remove = button(
        "移除",
        async () => {
          if (
            !(await confirmAction(
              "移除 " + k.name + "？",
              "此 Key 的客户端将无法继续访问网关。",
              { label: "移除 Key", danger: true },
            ))
          )
            return;
          await busy(remove, async () => {
            await editKeys((keys) => {
              const i = keys.findIndex((x) => x.id === k.id);
              if (i < 0) throw Error("Key 已被移除");
              keys.splice(i, 1);
            });
            toast("Key 已移除");
          });
        },
        { small: true, kind: "ghost" },
      );
    const sw = toggle(
      (k.enabled ? "停用 " : "启用 ") + k.name,
      k.enabled,
      (v, b) =>
        busy(b, async () => {
          await editKeys((keys) => {
            const key = keys.find((x) => x.id === k.id);
            if (!key) throw Error("Key 已被移除");
            key.enabled = v;
          });
          toast(v ? "Key 已启用" : "Key 已停用");
        }),
    );
    append(
      row,
      sw,
      append(
        node("div", "key-info"),
        append(node("div", "key-name"), name),
        node("code", "", k.key.slice(0, 5) + "••••••••" + k.key.slice(-4)),
        append(node("div", "key-actions"), rotate, remove),
      ),
      controls,
    );
    host.append(row);
  }
}
function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return (
    "ocp_" + [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("")
  );
}
function keyForm(key) {
  const d = dialog(key ? "重命名 Key" : "新增访问 Key"),
    body = node("div", "dialog-body"),
    name = input(key?.name || "", { placeholder: "例如：Cherry Studio" }),
    value = input("", { placeholder: "留空自动生成", type: "password" }),
    error = errorLine();
  append(
    body,
    field("Key 名称", name),
    !key && field("自定义 Key", value, "至少 8 个字符；留空生成随机 Key。"),
    error,
  );
  const save = button(
    key ? "保存名称" : "创建 Key",
    async () => {
      error.show("");
      save.disabled = true;
      try {
        if (!name.value.trim()) throw Error("请输入 Key 名称。");
        await editKeys((keys) => {
          if (key) {
            const found = keys.find((x) => x.id === key.id);
            if (!found) throw Error("Key 已被移除");
            found.name = name.value.trim();
          } else
            keys.push({
              id: crypto.randomUUID(),
              name: name.value.trim(),
              key: value.value || newKey(),
              enabled: true,
            });
        });
        d.close();
        toast(key ? "Key 名称已保存" : "Key 已创建，可点击复制连接客户端");
      } catch (e) {
        error.show(e.message);
      } finally {
        save.disabled = false;
      }
    },
    { kind: "primary" },
  );
  append(
    d,
    body,
    append(
      node("div", "dialog-footer"),
      append(
        node("div", "footer-actions"),
        button("取消", () => d.close()),
        save,
      ),
    ),
  );
  d.showModal();
}

function settingsForm(title, description) {
  root.append(heading(title, description));
  const form = node("form", "settings-form"),
    error = errorLine();
  form.noValidate = true;
  form.addEventListener("input", () => (pendingSettings = true));
  form.addEventListener("change", () => (pendingSettings = true));
  root.append(form);
  return { form, error };
}
function saveFooter(form, error, changes) {
  const b = button("保存设置", () => form.requestSubmit(), { kind: "primary" }),
    foot = append(node("div", "form-footer"), error, b);
  form.append(foot);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (settingsSaving) return;
    error.show("");
    b.disabled = true;
    try {
      const change = changes();
      settingsSaving = true;
      form.inert = true;
      bindState(await updateConfig((s) => Object.assign(s, change)));
      pendingSettings = false;
      toast(
        state.startError
          ? "设置已保存，但监听失败：" + state.startError
          : "设置已保存",
        !!state.startError,
      );
      try {
        await readModels();
      } catch {
        /* Configuration is saved; model discovery errors remain in Models. */
      }
      if (form.isConnected) {
        form
          .querySelectorAll("input")
          .forEach((i) => (i.defaultValue = i.value));
      }
    } catch (e) {
      error.show(e.message);
    } finally {
      settingsSaving = false;
      form.inert = false;
      b.disabled = false;
    }
  };
}
function drawOpenCode() {
  const { form, error } = settingsForm("OpenCode", pages.opencode.subtitle);
  form.append(
    info(
      "程序与工作目录可自动识别。这里的设置只作用于代理工作进程，全局登录和供应商配置由 OpenCode 管理。",
    ),
  );
  const config = state.settings,
    command = input(
      Array.isArray(config.command)
        ? config.command[0]
        : config.command || "opencode",
      { placeholder: "opencode 或可执行文件路径" },
    );
  const dir = input(config.workingDirectory || "", {
    placeholder: "留空使用默认目录",
  });
  const browse = button(
      "选择",
      () =>
        busy(browse, async () => {
          const path = await desktop().SelectDirectory();
          if (path) {
            dir.value = path;
            pendingSettings = true;
          }
        }),
      { glyph: "folder" },
    ),
    choose = button(
      "选择",
      () =>
        busy(choose, async () => {
          const path = await desktop().SelectExecutable();
          if (path) {
            command.value = path;
            pendingSettings = true;
          }
        }),
      { glyph: "folder" },
    );
  browse.disabled = !desktop();
  choose.disabled = !desktop();
  const area = node("textarea", "input");
  area.rows = 3;
  area.value = Array.isArray(config.command)
    ? config.command.slice(1).join("\n")
    : "";
  area.placeholder = "每行一个参数，通常留空";
  area.autocomplete = "off";
  const content = append(
    node("div", "card-body"),
    field(
      "OpenCode 程序",
      append(node("div", "split-input"), command, choose),
      "默认从 PATH 自动查找全局安装。",
    ),
    field("启动参数", area, "参数按行传递，不经过 shell 执行。"),
    field(
      "工作目录",
      append(node("div", "split-input"), dir, browse),
      "留空使用默认目录；也会读取工作目录中的 OpenCode 配置。",
    ),
  );
  // Composite labels name the actual inputs, not the visual wrapper.
  command.setAttribute("aria-label", "OpenCode 程序");
  dir.setAttribute("aria-label", "工作目录");
  form.append(card("程序与目录", "配置真实 OpenCode 的启动方式。", content));
  form.append(info("当前代理配置文件：" + state.configFile));
  saveFooter(form, error, () => ({
    command: commandFields(command.value, area.value),
    workingDirectory: dir.value.trim(),
  }));
}
function drawNetwork() {
  const { form, error } = settingsForm("网络与超时", pages.network.subtitle),
    s = state.settings;
  const host = input(s.host, { placeholder: "127.0.0.1 或 0.0.0.0" }),
    port = input(s.port, { type: "number", min: 0, max: 65535, step: 1 }),
    concurrent = input(s.maxConcurrent, { type: "number", min: 0, step: 1 });
  const connection = append(
    node("div", "card-body"),
    append(
      node("div", "form-grid"),
      field(
        "监听地址",
        host,
        "127.0.0.1 仅本机；0.0.0.0 局域网，也可填本机其他监听地址。",
      ),
      field(
        "API 端口",
        port,
        "三种协议共用该端口；0 自动分配，保存后重启监听。",
      ),
    ),
    field("并发上限", concurrent, "0 表示不限并发，默认不限制。"),
  );
  form.append(card("连接设置", "客户端连接的网关地址。", connection));
  const timing = node("div", "form-grid"),
    inputs = {};
  for (const [key, label, description] of [
    ["startupTimeoutMs", "启动超时（秒）", "等待 OpenCode 服务启动。"],
    [
      "firstOutputTimeoutMs",
      "首输出超时（秒）",
      "等待首段模型输出，0 为不限。",
    ],
    [
      "idleTimeoutMs",
      "输出空闲超时（秒）",
      "输出过程中无事件的等待时间，0 为不限。",
    ],
    ["timeoutMs", "请求总超时（秒）", "默认 0，不限制总时长。"],
  ]) {
    const i = input(s[key] / 1000, {
      type: "number",
      min: key === "startupTimeoutMs" ? 1 : 0,
      step: 1,
    });
    inputs[key] = i;
    timing.append(field(label, i, description));
  }
  form.append(
    card(
      "等待时间",
      "以秒填写，避免毫秒换算。",
      append(node("div", "card-body"), timing),
    ),
  );
  const reuse = checkbox("复用健康的空闲 OpenCode 工作进程", s.workerReuse),
    maxIdle = input(s.maxIdleWorkers, { type: "number", min: 0, step: 1 }),
    idle = input(s.workerIdleMs / 1000, { type: "number", min: 0, step: 1 });
  form.append(
    card(
      "工作进程",
      "活动请求独占工作进程，复用不会限制请求并发。",
      append(
        node("div", "card-body"),
        reuse.element,
        append(
          node("div", "form-grid section-title"),
          field("保留空闲进程数", maxIdle),
          field("空闲回收时间（秒）", idle),
        ),
      ),
    ),
  );
  saveFooter(form, error, () => {
    const number = (i, label, min = 0, max = Number.MAX_SAFE_INTEGER) => {
      const n = Number(i.value);
      if (
        i.value.trim() === "" ||
        !Number.isSafeInteger(n) ||
        n < min ||
        n > max
      )
        throw Error(label + "需要有效整数。");
      return n;
    };
    const change = {
      host: host.value,
      port: number(port, "API 端口", 0, 65535),
      maxConcurrent: number(concurrent, "并发上限"),
      workerReuse: reuse.input.checked,
      maxIdleWorkers: number(maxIdle, "空闲进程数"),
      workerIdleMs: number(idle, "空闲回收时间") * 1000,
    };
    for (const [key, i] of Object.entries(inputs))
      change[key] =
        number(i, "超时", key === "startupTimeoutMs" ? 1 : 0) * 1000;
    return change;
  });
}
function drawGeneral() {
  root.append(heading("外观与运行", pages.general.subtitle));
  const host = node("div", "settings-form"),
    body = node("div", "card-body"),
    choices = node("div", "settings-choice"),
    theme = localStorage.getItem("opencode-proxy.theme") || "system";
  for (const [id, label, glyph] of [
    ["system", "跟随系统", "sliders"],
    ["light", "浅色", "sun"],
    ["dark", "深色", "moon"],
  ]) {
    const b = append(
      node("button", "choice-card"),
      icon(glyph),
      node("span", "", label),
    );
    b.type = "button";
    b.setAttribute("aria-pressed", String(id === theme));
    b.onclick = () => {
      localStorage.setItem("opencode-proxy.theme", id);
      applyAppearance();
      drawGeneralPage();
    };
    choices.append(b);
  }
  body.append(field("界面主题", choices));
  const size = select(
    [
      [90, "紧凑 · 90%"],
      [100, "标准 · 100%"],
      [110, "较大 · 110%"],
      [120, "大号 · 120%"],
    ],
    Number(localStorage.getItem("opencode-proxy.size") || 100),
  );
  size.onchange = () => {
    localStorage.setItem("opencode-proxy.size", size.value);
    applyAppearance();
  };
  body.append(field("文字大小", size, "只影响界面显示。"));
  host.append(card("外观", "选择适合你的显示方式，修改立即生效。", body));
  const running = node("div", "card-body"),
    hide = button(
      "隐藏到托盘",
      () =>
        busy(hide, async () => {
          await desktop().HideToTray();
        }),
      { glyph: "external" },
    );
  hide.disabled = !desktop();
  append(
    running,
    append(
      node("div", "setting-inline"),
      append(
        node("div"),
        node("strong", "", "后台运行"),
        hint(
          desktop()
            ? "关闭窗口会隐藏到托盘，网关继续运行。"
            : "浏览器关闭后服务继续运行；Linux 可通过 systemd 管理。",
        ),
      ),
      hide,
    ),
  );
  const quit = button(
    "退出程序",
    async () => {
      if (
        !(await confirmAction(
          "退出 OpenCode Proxy？",
          "网关将停止，所有客户端连接会断开。",
          { label: "退出程序", danger: true },
        ))
      )
        return;
      if (desktop()) await desktop().Quit();
      else {
        await api("/admin/shutdown", {});
        toast("服务已停止");
      }
    },
    { glyph: "stop" },
  );
  append(
    running,
    append(
      node("div", "setting-inline"),
      append(
        node("div"),
        node("strong", "", "退出"),
        hint("停止网关并退出后台服务。"),
      ),
      quit,
    ),
  );
  host.append(card("运行方式", "在窗口关闭后继续提供模型 API。", running));
  root.append(host);
}
function drawGeneralPage() {
  root.replaceChildren();
  drawGeneral();
}

document.querySelector("#refresh").append(icon("refresh"));
document.querySelector("#refresh").onclick = () =>
  busy(document.querySelector("#refresh"), async () => {
    await readState();
    await readModels(true);
    if (!pendingSettings && !document.querySelector("dialog[open]")) draw();
    toast("配置与模型列表已刷新");
  });
document.querySelector("#theme-toggle").append(icon("sun"));
document.querySelector("#theme-toggle").onclick = () => {
  const theme = document.documentElement.dataset.theme,
    systemDark = matchMedia("(prefers-color-scheme:dark)").matches;
  localStorage.setItem(
    "opencode-proxy.theme",
    theme === "dark" || (theme === "system" && systemDark) ? "light" : "dark",
  );
  applyAppearance();
  if (page === "general") drawGeneralPage();
};
async function initialize() {
  drawNav();
  try {
    bindState(await api("/admin/state"));
    draw();
    try {
      await readModels();
      if (page === "models" || page === "gateway") draw();
    } catch (e) {
      if (page === "models") draw();
      toast(e.message, true);
    }
  } catch (e) {
    draw();
    toast(e.message, true);
  }
}
applyAppearance();
void initialize();
setInterval(() => {
  if (state && !document.hidden)
    readState().catch(() => {
      const n = document.querySelector("#gateway-status");
      n.className = "badge danger";
      n.textContent = "服务连接中断";
    });
}, 8000);
