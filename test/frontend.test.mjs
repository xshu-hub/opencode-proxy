import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modelDraft,
  modelPatch,
  availableEfforts,
  filteredModels,
  commandFields,
} from "../frontend/src/model-data.js";
const model = () => ({
  id: "m",
  target: "provider/m",
  enabled: true,
  defaults: { temperature: 0 },
  nativeContext: 128000,
  nativeOutput: 4096,
  context: 128000,
  output: 4096,
  reasoningAdapter: "effort",
  nativeReasoningEfforts: ["low", "high"],
  reasoningEfforts: ["low", "high"],
});
test("OpenCode program fields always emit an argument array and preserve paths with spaces", () => {
  assert.deepEqual(commandFields(""), ["opencode"]);
  assert.deepEqual(commandFields("C:\\Program Files\\OpenCode\\opencode.exe"), [
    "C:\\Program Files\\OpenCode\\opencode.exe",
  ]);
  assert.deepEqual(
    commandFields("node", "C:\\Program Files\\OpenCode\\cli.js\r\n\n--flag"),
    ["node", "C:\\Program Files\\OpenCode\\cli.js", "--flag"],
  );
});
test("new model form preserves zero defaults, clears blank values and rejects limits before saving", () => {
  const m = model(),
    d = modelDraft(m);
  assert.equal(modelPatch(m, d).defaults.temperature, 0);
  assert.equal(modelPatch(m, d).context, null);
  assert.equal(modelPatch(m, d).defaults.max_tokens, null);
  d.output = 2000;
  d.defaults.max_tokens = 2001;
  assert.throws(() => modelPatch(m, d), /默认输出 Token/);
  d.defaults.max_tokens = 100;
  d.context = "NaN";
  assert.throws(() => modelPatch(m, d), /上下文/);
  d.context = 128001;
  assert.throws(() => modelPatch(m, d), /最大 128000/);
});
test("new form keeps advanced native-option mappings when only alias or numeric parameters change", () => {
  const m = { ...model(), reasoningEfforts: ["low", "high", "max"] },
    override = {
      reasoningVariants: {
        max: { reasoningEffort: "high", nested: { existing: true } },
      },
    };
  const d = modelDraft(m, override);
  d.alias = "friendly";
  d.defaults.reasoning_effort = "max";
  const patch = modelPatch(m, d);
  assert.equal(patch.alias, "friendly");
  assert.equal(Object.hasOwn(patch, "reasoningPreset"), false);
  assert.equal(Object.hasOwn(patch, "reasoningVariants"), false);
  assert.equal(patch.defaults.reasoning_effort, "max");
});
test("native and custom reasoning selections validate against the actual available union", () => {
  const m = model(),
    d = modelDraft(m);
  d.preset = { type: "effort", levels: ["max"] };
  d.defaults.reasoning_effort = "max";
  assert.deepEqual(availableEfforts(m, d), ["low", "high", "max"]);
  assert.deepEqual(modelPatch(m, d).reasoningPreset, {
    type: "effort",
    levels: ["max"],
  });
  d.preset = { type: "native" };
  assert.throws(() => modelPatch(m, d), /可用的思考档位/);
  d.defaults.reasoning_effort = "";
  assert.equal(modelPatch(m, d).reasoningVariants, null);
});
test("Anthropic custom-budget form requires each enabled level and bounds it below configured output", () => {
  const m = { ...model(), reasoningAdapter: "budget" },
    d = modelDraft(m);
  d.preset = {
    type: "budget",
    levels: ["none", "high"],
    budgets: { high: "" },
  };
  assert.throws(() => modelPatch(m, d), /填写高档/);
  d.preset.budgets.high = 4096;
  assert.throws(() => modelPatch(m, d), /最大 4095/);
  d.preset.budgets.high = 1024;
  assert.deepEqual(modelPatch(m, d).reasoningPreset.budgets, { high: 1024 });
  d.output = 1024;
  assert.throws(() => modelPatch(m, d), /最大 1023/);
});
test("model search combines provider, enabled state, alias and original target without changing identity", () => {
  const a = { ...model(), id: "Friendly" },
    b = {
      ...model(),
      id: "other",
      target: "second/long-model",
      enabled: false,
    };
  assert.deepEqual(filteredModels([a, b], { query: "FRIENDLY" }), [a]);
  assert.deepEqual(
    filteredModels([a, b], {
      query: "long-model",
      provider: "second",
      enabled: "off",
    }),
    [b],
  );
  assert.deepEqual(
    filteredModels([a, b], { provider: "provider", enabled: "off" }),
    [],
  );
});
