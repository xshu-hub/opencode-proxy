import {
  node,
  append,
  button,
  field,
  hint,
  input,
  select,
  checkbox,
  toggle,
  dialog,
  errorLine,
  confirmAction,
} from "./ui.js";
import {
  modelDraft,
  modelPatch,
  resetDraft,
  availableEfforts,
  efforts,
  effortLabels,
} from "./model-data.js";
export function openModel(model, override, save) {
  let draft = modelDraft(model, override),
    baseline = JSON.stringify(draft),
    saving = false;
  const d = dialog("配置模型", model.id, { drawer: true }),
    body = node("div", "dialog-body"),
    error = errorLine(),
    footer = node("div", "dialog-footer");
  append(d, body, footer);
  const dirty = () => {
    d.dataset.dirty = String(JSON.stringify(draft) !== baseline);
  };
  d.addEventListener("input", dirty);
  d.addEventListener("change", dirty);
  const close = async () => {
    if (saving) return;
    if (
      JSON.stringify(draft) !== baseline &&
      !(await confirmAction("放弃修改？", "还没有保存的模型配置将被丢弃。", {
        label: "放弃修改",
      }))
    )
      return;
    d.close();
  };
  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    void close();
  });
  const numeric = (label, key, owner, placeholder, options = {}) => {
    const i = input(owner[key], {
      type: "number",
      placeholder: placeholder || "跟随 OpenCode",
      ...options,
    });
    i.oninput = () => {
      owner[key] = i.value;
    };
    return field(label, i);
  };
  function draw() {
    const scroll = d.scrollTop;
    body.replaceChildren();
    const summary = append(
      node("div", "model-summary"),
      node("div", "model-symbol", model.id.slice(0, 1).toUpperCase()),
      append(
        node("div"),
        node("strong", "", model.id),
        node("code", "", model.target),
      ),
    );
    body.append(summary);
    const alias = input(draft.alias, { placeholder: "留空使用自动模型名" });
    alias.autofocus = true;
    alias.oninput = () => (draft.alias = alias.value);
    const status = append(
      node("div", "setting-inline"),
      append(
        node("div"),
        node("strong", "", "对外启用"),
        hint("停用后从模型列表隐藏，新请求会被拒绝。"),
      ),
      toggle("对外启用", draft.enabled, (v) => {
        draft.enabled = v;
        draw();
      }),
    );
    append(
      body,
      node("h3", "section-title", "名称与可用性"),
      field("模型别名", alias, "客户端看到的模型名称；留空恢复自动名称。"),
      status,
      node("h3", "section-title", "模型参数"),
    );
    const grid = node("div", "form-grid");
    append(
      grid,
      numeric(
        "上下文上限",
        "context",
        draft,
        String(model.nativeContext || ""),
        { min: 1, step: 1, max: model.nativeContext },
      ),
      numeric("输出上限", "output", draft, String(model.nativeOutput || ""), {
        min: 1,
        step: 1,
        max: model.nativeOutput,
      }),
    );
    if (model.temperature)
      grid.append(
        numeric("Temperature", "temperature", draft.defaults, "供应商默认", {
          min: 0,
          max: 2,
          step: 0.1,
        }),
      );
    append(
      grid,
      numeric("Top P", "top_p", draft.defaults, "供应商默认", {
        min: 0,
        max: 1,
        step: 0.01,
      }),
      numeric("默认输出 Token", "max_tokens", draft.defaults, "不覆盖客户端", {
        min: 1,
        step: 1,
        max: model.nativeOutput,
      }),
    );
    body.append(
      grid,
      hint("留空沿用 OpenCode；客户端显式参数优先。上限不能超过原模型限制。"),
    );
    if (model.reasoning) {
      body.append(node("h3", "section-title", "思考强度"));
      const defaultSelect = select(
        [
          ["", "跟随 OpenCode"],
          ...availableEfforts(model, draft).map((v) => [v, effortLabels[v]]),
        ],
        draft.defaults.reasoning_effort,
      );
      defaultSelect.onchange = () =>
        (draft.defaults.reasoning_effort = defaultSelect.value);
      body.append(field("默认思考强度", defaultSelect));
      const customizable = ["effort", "budget"].includes(
          model.reasoningAdapter,
        ),
        mode = select(
          [
            ["native", "使用原生档位"],
            ...(customizable ? [["custom", "自定义可选档位"]] : []),
          ],
          draft.preserveLegacy
            ? "native"
            : draft.preset.type === "native"
              ? "native"
              : "custom",
        );
      const reconcile = () => {
        draft.reasoningChanged = true;
        draft.preserveLegacy = false;
        if (
          draft.defaults.reasoning_effort &&
          !availableEfforts(model, draft).includes(
            draft.defaults.reasoning_effort,
          )
        )
          draft.defaults.reasoning_effort = "";
      };
      mode.onchange = () => {
        draft.preset =
          mode.value === "native"
            ? { type: "native" }
            : {
                type: model.reasoningAdapter,
                levels: [...(model.nativeReasoningEfforts || [])],
                budgets: {},
              };
        reconcile();
        draw();
      };
      body.append(
        field(
          "可选档位",
          mode,
          customizable
            ? "自定义档位仍需上游模型支持。"
            : "当前供应商 SDK 仅提供原生档位。",
        ),
      );
      if (draft.preserveLegacy)
        body.append(
          append(
            node("div", "notice"),
            hint("已有高级思考映射会保留。修改档位配置或恢复默认后才会替换。"),
          ),
        );
      if (draft.preset.type !== "native" && !draft.preserveLegacy) {
        const levels = node("div", "effort-levels");
        for (const level of efforts) {
          const { element, input: c } = checkbox(
            effortLabels[level],
            draft.preset.levels?.includes(level),
          );
          c.onchange = () => {
            const selected = new Set(draft.preset.levels || []);
            c.checked ? selected.add(level) : selected.delete(level);
            draft.preset.levels = efforts.filter((v) => selected.has(v));
            reconcile();
            draw();
          };
          const row = append(node("div", "effort-row"), element);
          if (draft.preset.type === "budget" && level !== "none" && c.checked) {
            const i = input(draft.preset.budgets?.[level] ?? "", {
              type: "number",
              min: 1024,
              step: 1,
              placeholder: "思考 Token 预算",
            });
            i.setAttribute("aria-label", effortLabels[level] + "档思考预算");
            i.oninput = () => {
              (draft.preset.budgets ??= {})[level] = i.value;
            };
            row.append(i);
          }
          levels.append(row);
        }
        body.append(levels);
      }
    }
    const reset = button(
      "恢复默认",
      async () => {
        if (
          await confirmAction(
            "恢复模型默认配置？",
            "别名、参数和思考配置将在保存后恢复为 OpenCode 默认值。",
            { label: "恢复默认" },
          )
        ) {
          const enabled = draft.enabled;
          draft = resetDraft(model);
          draft.enabled = enabled;
          draw();
        }
      },
      { glyph: "reset", small: true },
    );
    body.append(append(node("div", "reset-row"), reset));
    d.scrollTop = scroll;
    dirty();
  }
  const cancel = button("取消", close),
    submit = button(
      "保存配置",
      async () => {
        if (saving) return;
        error.show("");
        try {
          const patch = modelPatch(model, draft);
          saving = true;
          body.inert = true;
          submit.disabled = true;
          cancel.disabled = true;
          await save(patch);
          baseline = JSON.stringify(draft);
          d.close();
        } catch (e) {
          error.show(e.message);
          error.scrollIntoView({ block: "nearest" });
        } finally {
          saving = false;
          body.inert = false;
          submit.disabled = false;
          cancel.disabled = false;
        }
      },
      { kind: "primary" },
    );
  append(footer, error, append(node("div", "footer-actions"), cancel, submit));
  draw();
  d.showModal();
}
