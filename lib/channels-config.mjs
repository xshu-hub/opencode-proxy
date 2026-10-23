import { ApiError } from './protocol.mjs';

const fail = (message) => {
  throw new ApiError(message, 400, 'channels', 'invalid_channel_configuration');
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail('渠道包含无效或未知字段。');
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(label + '超出允许范围。');
}

export function validateChannels(input = []) {
  if (!Array.isArray(input) || input.length > 50) fail('最多配置 50 个上游渠道。');
  const ids = new Set(),
    aliases = new Set();
  return input.map((original) => {
    fields(original, [
      'id',
      'name',
      'enabled',
      'protocol',
      'baseURL',
      'keys',
      'models',
      'stickyTtlMs',
      'maxBindings',
      'cooldownMs',
      'maxKeyAttempts'
    ]);
    const channel = {
      enabled: true,
      stickyTtlMs: 1800000,
      maxBindings: 10000,
      cooldownMs: 30000,
      maxKeyAttempts: 2,
      ...structuredClone(original)
    };
    if (!id(channel.id) || ids.has(channel.id)) fail('渠道 ID 无效或重复。');
    ids.add(channel.id);
    if (typeof channel.name !== 'string' || !channel.name.trim() || channel.name.length > 80) fail('渠道名称无效。');
    if (typeof channel.enabled !== 'boolean') fail('渠道启用状态无效。');
    if (!['openai-chat', 'openai-responses', 'anthropic'].includes(channel.protocol)) fail('上游协议无效。');
    let url;
    try {
      url = new URL(channel.baseURL);
    } catch {
      fail('请输入绝对上游地址。');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      fail('上游地址不能包含凭证、查询参数或片段。');
    }
    integer(channel.stickyTtlMs, 1000, 604800000, '会话闲置过期时间（1 秒至 7 天）');
    integer(channel.maxBindings, 1, 100000, '会话绑定容量');
    integer(channel.cooldownMs, 1000, 3600000, 'Key 冷却时间（1 秒至 1 小时）');
    integer(channel.maxKeyAttempts, 1, 3, '单请求尝试 Key 数（1 至 3）');
    if (!Array.isArray(channel.keys) || !channel.keys.length || channel.keys.length > 100)
      fail('每渠道需要 1 至 100 个 Key。');
    const keyIds = new Set(),
      credentials = new Set();
    for (const key of channel.keys) {
      fields(key, ['id', 'name', 'enabled', 'key', 'apiKeyEnv']);
      if (
        !id(key.id) ||
        keyIds.has(key.id) ||
        typeof key.name !== 'string' ||
        !key.name.trim() ||
        key.name.length > 80 ||
        typeof key.enabled !== 'boolean'
      )
        fail('上游 Key 的 ID、名称或启用状态无效。');
      keyIds.add(key.id);
      const plain = typeof key.key === 'string' && /^[\x21-\x7e]{1,4096}$/.test(key.key);
      const env = typeof key.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key.apiKeyEnv);
      if (
        (plain ? 1 : 0) + (env ? 1 : 0) !== 1 ||
        (key.key !== undefined && !plain) ||
        (key.apiKeyEnv !== undefined && !env)
      )
        fail('每个上游 Key 需要密钥值或环境变量名，二选一。');
      const credential = plain ? 'key:' + key.key : 'env:' + key.apiKeyEnv;
      if (credentials.has(credential)) fail('同一渠道不能重复配置相同凭证。');
      credentials.add(credential);
    }
    if (channel.enabled && !channel.keys.some((key) => key.enabled)) fail('启用的渠道至少需要一个启用的 Key。');
    if (!Array.isArray(channel.models) || !channel.models.length || channel.models.length > 100)
      fail('每渠道需要 1 至 100 个模型。');
    for (const model of channel.models) {
      fields(model, ['alias', 'id', 'name', 'context', 'output', 'reasoning', 'toolcall', 'inputModalities']);
      if (
        typeof model.alias !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model.alias) ||
        aliases.has(model.alias)
      )
        fail('渠道模型短名称无效或重复。');
      aliases.add(model.alias);
      if (
        typeof model.id !== 'string' ||
        !model.id.trim() ||
        model.id.length > 256 ||
        /[\x00-\x1f\x7f]/.test(model.id)
      ) {
        fail('上游模型 ID 无效。');
      }
      if (model.name !== undefined && (typeof model.name !== 'string' || model.name.length > 128))
        fail('模型显示名称无效。');
      for (const key of ['context', 'output']) integer(model[key], 1, 100000000, '模型 ' + key);
      for (const key of ['reasoning', 'toolcall'])
        if (model[key] !== undefined && typeof model[key] !== 'boolean') fail('模型能力无效。');
      if (
        model.inputModalities !== undefined &&
        (!Array.isArray(model.inputModalities) ||
          !model.inputModalities.length ||
          model.inputModalities.some((type) => !['text', 'image', 'pdf', 'audio'].includes(type)))
      )
        fail('模型输入能力无效。');
    }
    return channel;
  });
}

// Only the local settings file holds plaintext credentials. Read/modify/write
// clients retain an omitted credential by the same channel and key identity.
export function publicChannels(channels = []) {
  return channels.map((channel) => ({
    ...structuredClone(channel),
    keys: channel.keys.map(({ key, ...rest }) => ({ ...rest, ...(key !== undefined ? { keyConfigured: true } : {}) }))
  }));
}
export function retainChannelSecrets(input, previous = []) {
  if (!Array.isArray(input)) return input;
  return input.map((channel) =>
    !object(channel)
      ? channel
      : {
          ...channel,
          keys: !Array.isArray(channel.keys)
            ? channel.keys
            : channel.keys.map((key) => {
                if (!object(key)) return key;
                const { keyConfigured, ...next } = key;
                if (next.key === undefined && next.apiKeyEnv === undefined) {
                  const old = previous.find((c) => c.id === channel.id)?.keys.find((k) => k.id === key.id);
                  if (old?.key !== undefined) next.key = old.key;
                }
                return next;
              })
        }
  );
}
