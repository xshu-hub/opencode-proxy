import { initialThinkingChoice } from "./thinking-choice.js";
export const efforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export const effortLabels = {
  none: "不思考",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};
export function commandFields(executable, args = "") {
  return [
    executable.trim() || "opencode",
    ...args.split(/\r?\n/).filter((v) => v !== ""),
  ];
}
export function modelDraft(model, override = {}) {
  const choice = initialThinkingChoice(model, override);
  return {
    alias: override.alias || "",
    enabled: model.enabled,
    context: override.context ?? "",
    output: override.output ?? "",
    defaults: {
      temperature: model.defaults.temperature ?? "",
      top_p: model.defaults.top_p ?? "",
      max_tokens: model.defaults.max_tokens ?? "",
      reasoning_effort: model.defaults.reasoning_effort ?? "",
    },
    ...choice,
    reasoningChanged: false,
  };
}
export function availableEfforts(model, draft) {
  if (draft.preserveLegacy && !draft.reasoningChanged)
    return model.reasoningEfforts || [];
  const wanted = new Set([
    ...(model.nativeReasoningEfforts || []),
    ...(draft.preset.type === "native" ? [] : draft.preset.levels || []),
  ]);
  return efforts.filter((v) => wanted.has(v));
}
export function optionalNumber(raw, label, { integer = false, min, max } = {}) {
  if (raw === "" || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (
    !Number.isFinite(n) ||
    (integer && !Number.isSafeInteger(n)) ||
    (min !== undefined && n < min) ||
    (max !== undefined && n > max)
  )
    throw Error(
      label +
        "超出有效范围" +
        (max === undefined ? "" : "（最大 " + max + "）"),
    );
  return n;
}
export function modelPatch(model, draft) {
  const context = optionalNumber(draft.context, "上下文上限", {
      integer: true,
      min: 1,
      max: model.nativeContext,
    }),
    output = optionalNumber(draft.output, "输出上限", {
      integer: true,
      min: 1,
      max: model.nativeOutput,
    }),
    ceiling = output ?? model.nativeOutput ?? model.output;
  const defaults = {
    temperature: optionalNumber(draft.defaults.temperature, "Temperature", {
      min: 0,
      max: 2,
    }),
    top_p: optionalNumber(draft.defaults.top_p, "Top P", { min: 0, max: 1 }),
    max_tokens: optionalNumber(draft.defaults.max_tokens, "默认输出 Token", {
      integer: true,
      min: 1,
      max: ceiling,
    }),
    reasoning_effort: draft.defaults.reasoning_effort || null,
  };
  if (
    defaults.reasoning_effort &&
    !availableEfforts(model, draft).includes(defaults.reasoning_effort)
  )
    throw Error("请选择当前可用的思考档位。");
  const patch = {
    alias: draft.alias.trim() || null,
    enabled: !!draft.enabled,
    context,
    output,
    defaults,
  };
  if (!draft.preserveLegacy || draft.reasoningChanged) {
    const preset = structuredClone(draft.preset);
    if (preset.type !== "native") {
      if (preset.type !== model.reasoningAdapter)
        throw Error("这个模型仅支持原生思考档位。");
      if (!preset.levels?.length) throw Error("请至少选择一个自定义思考档位。");
      if (preset.type === "budget") {
        preset.budgets = Object.fromEntries(
          preset.levels
            .filter((v) => v !== "none")
            .map((v) => {
              const budget = optionalNumber(
                preset.budgets?.[v],
                effortLabels[v] + "档思考预算",
                { integer: true, min: 1024, max: ceiling - 1 },
              );
              if (budget === null)
                throw Error("请填写" + effortLabels[v] + "档思考预算。");
              return [v, budget];
            }),
        );
      }
    }
    patch.reasoningPreset = preset;
    patch.reasoningVariants = null;
  }
  return patch;
}
export function resetDraft(model) {
  return modelDraft({ ...model, defaults: {} }, {});
}
export function filteredModels(
  models,
  { query = "", provider = "", enabled = "all" } = {},
) {
  const q = query.trim().toLocaleLowerCase();
  return models.filter(
    (m) =>
      (!provider || m.target.split("/")[0] === provider) &&
      (enabled === "all" || m.enabled === (enabled === "on")) &&
      (!q ||
        [m.id, m.target, m.name].some((v) =>
          v?.toLocaleLowerCase().includes(q),
        )),
  );
}
