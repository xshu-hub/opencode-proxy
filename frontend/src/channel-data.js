export function channelDraft(channel) {
  return channel
    ? structuredClone(channel)
    : {
        id: crypto.randomUUID(),
        name: "",
        enabled: true,
        protocol: "openai-chat",
        baseURL: "",
        stickyTtlMs: 1800000,
        cooldownMs: 30000,
        maxBindings: 10000,
        maxKeyAttempts: 2,
        keys: [{ id: crypto.randomUUID(), name: "Key 1", enabled: true }],
        models: [{ alias: "", id: "", context: 128000, output: 8192 }],
      };
}
export function channelPatch(draft) {
  const channel = structuredClone(draft);
  channel.name = channel.name.trim();
  channel.baseURL = channel.baseURL.trim();
  if (!channel.name || !channel.baseURL) throw Error("请填写渠道名称与上游地址。");
  for (const key of ["stickyTtlMs", "cooldownMs", "maxBindings", "maxKeyAttempts"]) {
    channel[key] = Number(channel[key]);
    if (!Number.isSafeInteger(channel[key]) || channel[key] <= 0)
      throw Error("过期、冷却、容量和尝试次数必须为正整数。");
  }
  if (!channel.keys.length || !channel.models.length) throw Error("渠道至少需要一个 Key 和一个模型。");
  for (const key of channel.keys) {
    if (!key.key && !key.apiKeyEnv && !key.keyConfigured) throw Error("请为每个 Key 输入密钥或环境变量名。");
  }
  for (const model of channel.models) {
    model.alias = model.alias.trim();
    model.id = model.id.trim();
    if (!model.alias || !model.id) throw Error("请填写对外短名称和上游模型 ID。");
    for (const key of ["context", "output"]) {
      model[key] = Number(model[key]);
      if (!Number.isSafeInteger(model[key]) || model[key] <= 0) throw Error("模型 Token 上限必须为正整数。");
    }
  }
  return channel;
}
