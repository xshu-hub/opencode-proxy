import { api, updateConfig } from "./api.js";
import {
  node,
  append,
  button,
  field,
  hint,
  heading,
  card,
  input,
  select,
  checkbox,
  dialog,
  errorLine,
  confirmAction,
  badge,
  busy,
  empty,
  toast,
} from "./ui.js";
import { channelDraft, channelPatch } from "./channel-data.js";

const statusLabels = {
  ready: "可用",
  cooling: "冷却中",
  invalid: "凭证失效",
  missing: "环境变量缺失或无效",
  disabled: "已停用",
};
export function drawChannels(root, state, changed) {
  const refresh = button("刷新状态", () => busy(refresh, async () => changed(await api("/admin/state"))), {
    glyph: "refresh",
  });
  const edit = (channel) =>
    openChannel(channel, async (next) => {
      const result = await updateConfig((settings) => {
        settings.channels ??= [];
        const index = settings.channels.findIndex((c) => c.id === next.id);
        if (channel && index < 0) throw Error("渠道已被移除，请刷新后重试。");
        if (index < 0) settings.channels.push(next);
        else settings.channels[index] = next;
      });
      await changed(result, true);
      toast("渠道已保存");
    });
  root.append(
    heading("上游渠道", "同一渠道多个 Key 轮询分配，会话固定 Key；所有推理仍经过 OpenCode。", [
      refresh,
      button("新增渠道", () => edit(), { kind: "primary", glyph: "plus" }),
    ]),
  );
  root.append(
    append(
      node("div", "notice"),
      hint(
        "保留现有全局 OpenCode 登录。新增渠道使用独立配置；密钥仅保存在本机代理配置文件中，页面不回显。" +
          "客户端用 x-opencode-session-id 或 metadata.session_id 传入稳定会话 ID；省略时每次请求视为新会话。",
      ),
    ),
  );
  const channels = state.settings.channels ?? [];
  if (!channels.length) root.append(empty("尚未配置上游渠道", "全局 OpenCode 模型仍按原有方式工作。"));
  for (const channel of channels) {
    const status = state.channelStatus?.find((c) => c.id === channel.id);
    const body = node("div", "channel-body");
    body.append(
      hint(channel.baseURL),
      hint(
        `会话闲置 ${channel.stickyTtlMs / 60000} 分钟过期 · ${status?.bindings ?? 0} 个绑定 · 最多尝试 ${channel.maxKeyAttempts} 个 Key`,
      ),
    );
    for (const key of channel.keys) {
      const health = status?.keys.find((k) => k.id === key.id);
      const row = append(
        node("div", "channel-key"),
        node("strong", "", key.name),
        badge(statusLabels[health?.status] ?? "未检查", health?.status === "ready" ? "success" : "muted"),
        hint(key.apiKeyEnv ? "环境变量：" + key.apiKeyEnv : "••••••••"),
        hint("执行中：" + (health?.active ?? 0)),
      );
      if (health?.retryAt) row.append(hint("重试时间：" + new Date(health.retryAt).toLocaleTimeString()));
      if (["cooling", "invalid"].includes(health?.status)) {
        const reset = button(
          "恢复可用",
          () =>
            busy(reset, async () => {
              await changed(await api("/admin/channels/reset-key", { channelId: channel.id, keyId: key.id }));
            }),
          { small: true },
        );
        row.append(reset);
      }
      body.append(row);
    }
    body.append(hint("模型：" + channel.models.map((m) => m.alias + " → " + m.id).join("，")));
    const remove = button(
      "移除",
      () =>
        busy(remove, async () => {
          if (
            !(await confirmAction("移除 " + channel.name + "？", "后续请求将无法使用该渠道；正在执行的请求继续完成。", {
              danger: true,
              label: "移除渠道",
            }))
          )
            return;
          const next = await updateConfig((settings) => {
            settings.channels = settings.channels.filter((c) => c.id !== channel.id);
          });
          await changed(next, true);
        }),
      { small: true },
    );
    const toggle = button(
      channel.enabled ? "停用" : "启用",
      () =>
        busy(toggle, async () => {
          const next = await updateConfig((settings) => {
            const current = settings.channels.find((c) => c.id === channel.id);
            if (!current) throw Error("渠道已被移除。");
            current.enabled = !current.enabled;
          });
          await changed(next, true);
        }),
      { small: true },
    );
    root.append(
      card(channel.name + (channel.enabled ? "" : "（已停用）"), channel.protocol, body, [
        button("配置", () => edit(channel), { small: true }),
        toggle,
        remove,
      ]),
    );
  }
}

function openChannel(channel, save) {
  const draft = channelDraft(channel),
    baseline = JSON.stringify(draft);
  let saving = false;
  const d = dialog(channel ? "配置上游渠道" : "新增上游渠道", "Key 不回显；留空保留已有密钥。", { drawer: true });
  const body = node("div", "dialog-body"),
    footer = node("div", "dialog-footer"),
    error = errorLine();
  const dirty = () => {
    d.dataset.dirty = String(JSON.stringify(draft) !== baseline);
  };
  const close = async () => {
    if (saving) return;
    if (JSON.stringify(draft) !== baseline && !(await confirmAction("放弃修改？", "尚未保存的渠道配置将被丢弃。")))
      return;
    d.close();
  };
  d.addEventListener("cancel", (event) => {
    event.preventDefault();
    void close();
  });
  d.addEventListener("input", dirty);
  d.addEventListener("change", dirty);
  const control = (label, owner, key, options = {}) => {
    const i = input(owner[key], options);
    i.oninput = () => {
      owner[key] = i.value;
    };
    return field(label, i);
  };
  const enabled = (owner, label) => {
    const c = checkbox(label, owner.enabled !== false);
    c.input.onchange = () => {
      owner.enabled = c.input.checked;
    };
    return c.element;
  };
  function draw() {
    body.replaceChildren();
    body.append(
      control("渠道名称", draft, "name"),
      control("上游地址", draft, "baseURL", { placeholder: "https://…/v1" }),
    );
    const protocol = select(
      [
        ["openai-chat", "OpenAI Chat Completions"],
        ["openai-responses", "OpenAI Responses"],
        ["anthropic", "Anthropic Messages"],
      ],
      draft.protocol,
    );
    protocol.onchange = () => {
      draft.protocol = protocol.value;
    };
    body.append(field("上游协议", protocol), enabled(draft, "启用渠道"));
    for (const [label, key, scale, max] of [
      ["会话闲置过期（分钟）", "stickyTtlMs", 60000, 10080],
      ["Key 冷却（秒）", "cooldownMs", 1000, 3600],
      ["最大会话绑定数", "maxBindings", 1, 100000],
      ["单请求最多尝试 Key 数", "maxKeyAttempts", 1, 3],
    ]) {
      const i = input(draft[key] / scale, {
        type: "number",
        min: key === "stickyTtlMs" ? 1 / 60 : 1,
        max,
        step: "any",
      });
      i.oninput = () => {
        draft[key] = Math.round(Number(i.value) * scale);
      };
      body.append(field(label, i));
    }
    body.append(node("h3", "", "上游 Key"), hint("新增 Key 参与新会话轮询；停用或替换后原绑定会在后续请求重新选择。"));
    for (const key of draft.keys) {
      const row = node("section", "channel-editor-row");
      row.append(control("Key 名称", key, "name"), enabled(key, "启用此 Key"));
      const source = select(
        [
          ["key", "输入密钥"],
          ["env", "使用环境变量"],
        ],
        key.apiKeyEnv !== undefined ? "env" : "key",
      );
      source.onchange = () => {
        delete key.key;
        delete key.apiKeyEnv;
        delete key.keyConfigured;
        if (source.value === "env") key.apiKeyEnv = "";
        draw();
        dirty();
      };
      row.append(field("凭证来源", source));
      if (key.apiKeyEnv !== undefined)
        row.append(control("环境变量名", key, "apiKeyEnv", { placeholder: "UPSTREAM_API_KEY" }));
      else {
        const secret = input(key.key ?? "", {
          type: "password",
          placeholder: key.keyConfigured ? "已保存，留空保留" : "输入上游 Key",
        });
        secret.oninput = () => {
          if (secret.value) key.key = secret.value;
          else delete key.key;
        };
        row.append(field("上游密钥", secret));
      }
      row.append(
        button(
          "移除此 Key",
          () => {
            draft.keys = draft.keys.filter((k) => k !== key);
            draw();
            dirty();
          },
          { small: true },
        ),
      );
      body.append(row);
    }
    body.append(
      button(
        "新增 Key",
        () => {
          draft.keys.push({ id: crypto.randomUUID(), name: "Key " + (draft.keys.length + 1), enabled: true });
          draw();
          dirty();
        },
        { glyph: "plus" },
      ),
    );
    body.append(node("h3", "", "渠道模型"), hint("对外短名称不能与全局模型重复；能力和 Token 上限应与供应商一致。"));
    for (const model of draft.models) {
      const row = node("section", "channel-editor-row");
      row.append(
        control("对外短名称", model, "alias"),
        control("上游模型 ID", model, "id"),
        control("上下文 Token", model, "context", { type: "number", min: 1 }),
        control("输出 Token 上限", model, "output", { type: "number", min: 1 }),
      );
      for (const [key, label, fallback] of [
        ["toolcall", "支持工具调用", true],
        ["reasoning", "支持思考", false],
      ]) {
        const c = checkbox(label, model[key] ?? fallback);
        c.input.onchange = () => {
          model[key] = c.input.checked;
        };
        row.append(c.element);
      }
      const modalities = input((model.inputModalities ?? ["text"]).join(","));
      modalities.oninput = () => {
        model.inputModalities = modalities.value.split(",").map((v) => v.trim());
      };
      row.append(
        field("输入类型", modalities, "逗号分隔：text,image,pdf,audio"),
        button(
          "移除此模型",
          () => {
            draft.models = draft.models.filter((m) => m !== model);
            draw();
            dirty();
          },
          { small: true },
        ),
      );
      body.append(row);
    }
    body.append(
      button(
        "新增模型",
        () => {
          draft.models.push({ alias: "", id: "", context: 128000, output: 8192 });
          draw();
          dirty();
        },
        { glyph: "plus" },
      ),
    );
  }
  const cancel = button("取消", close),
    submit = button(
      "保存渠道",
      async () => {
        if (saving) return;
        error.show("");
        try {
          const next = channelPatch(draft);
          saving = true;
          body.inert = true;
          submit.disabled = cancel.disabled = true;
          await save(next);
          d.dataset.dirty = "false";
          d.close();
        } catch (e) {
          error.show(e.message);
          error.scrollIntoView({ block: "nearest" });
        } finally {
          saving = false;
          body.inert = false;
          submit.disabled = cancel.disabled = false;
        }
      },
      { kind: "primary" },
    );
  append(footer, error, append(node("div", "footer-actions"), cancel, submit));
  append(d, body, footer);
  draw();
  d.showModal();
}
