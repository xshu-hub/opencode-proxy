# 上游渠道与多 Key

“上游渠道”页面在同一上游地址、协议和模型集合下配置多个 API Key。网关访问 Key 仍用于
客户端鉴权，与上游 Key 分开。新增渠道使用真实 OpenCode 程序和独立临时配置执行推理，
不写入或替换全局 OpenCode 的配置、登录或认证插件；全局模型继续使用原有认证路径。
渠道的思考、工具、附件能力和 Token 上限需按上游能力填写，不代表已自动探测供应商能力。

## 分配与绑定

- 新会话在可用 Key 间等权轮询；一个渠道中的模型共用 Key 池和绑定。
- 绑定按网关客户端身份、渠道和会话 ID 隔离，不按整个访问 Key 或请求历史绑定。
- 三种协议均可发送 `x-opencode-session-id` 请求头或 `metadata.session_id`。
  两者同时提供时必须一致；ID 为 1–128 个可见 ASCII 字符，不转发为模型输入。
- 未提供 ID 时生成新 ID，通过响应头 `x-opencode-session-id` 返回。后续请求复用它
  才能保持绑定；不回传时仍可正常调用，每个请求视为新会话。浏览器 CORS 可读取此响应头。
- Responses 使用 `store=true` 和 `previous_response_id` 续聊时自动继承原响应的会话 ID。
  存储仍按客户端隔离并遵循原有容量和过期限制。
- 默认闲置 30 分钟滑动过期，可配置 1 秒至 7 天。进入和结束请求时更新活动时间；请求
  进行中不清理绑定。过期仅影响后续选 Key，不中断执行中的请求。
- 默认每渠道最多 10000 个绑定，可配置 1–100000。容量不足时淘汰最久未使用的非活动
  绑定；所有绑定都在执行时返回 `429 channel_bindings_busy`。

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer <网关访问 Key>' \
  -H 'Content-Type: application/json' \
  -H 'x-opencode-session-id: conversation-123' \
  -d '{"model":"pooled-deepseek","messages":[{"role":"user","content":"你好"}]}'
```

会话 ID 应随机生成并保持稳定，不应包含用户信息。代理不根据提示词猜测会话归属。
绑定仅保存凭证标识、活动计数和时间等调度信息，不保存对话；绑定和健康状态只驻留内存，
重启后清空。Responses 的显式内存存储是独立功能。

## 故障与恢复

OpenCode 仍负责单次上游执行的有限重试。渠道最多尝试 1–3 个不同 Key，默认 2 个；首输出
及总超时预算跨 Key 尝试共享。已产生文本、思考或工具输出后不再切换 Key，避免重复生成；
中断请求不会触发换 Key 重试。

- 上游 401 将凭证标为失效；替换凭证或在页面点击“恢复可用”后恢复分配。
- 上游 429 按配置冷却与 `Retry-After` 的较长者冷却。默认 30 秒，可配置 1 秒至 1 小时；
  有效的上游重试提示最多保留一天。
- 明确的上游 5xx / OpenCode 上游重试耗尽也会短暂冷却及有限换 Key；本地配置错误、
  并发准入限制和 403 权限拒绝不作为坏 Key 自动轮转。
- 原绑定 Key 不可用时选择其他可用 Key 并更新绑定。全部冷却时返回 429 和 `Retry-After`；
  没有启用、有效且已配置的凭证时返回 503。
- 停用、移除、替换 Key 对后续请求生效，进行中的请求继续使用已分配凭证。
  普通设置保存保留未变更 Key 的绑定和健康状态。全局模型与渠道共用网关并发上限，默认不限。

## 缓存、进程与密钥

固定 Key 有助于减少缓存被打散，但不保证跨 Key、跨账号或中转后的缓存共享。保持系统提示、
工具和历史前缀稳定有助于缓存复用。换 Key 不会丢失正确携带的历史，但可能增加延迟和费用。

渠道复用按模型与凭证隔离的 OpenCode 进程池。空闲保留上限在每个渠道进程池内生效，全局模型
使用原有独立进程池；Key 较多时需权衡内存与冷启动。启动时的无推理预热仍面向全局模型，
渠道在请求后复用空闲进程。绑定期限、进程存活时间和上游缓存期限彼此独立。

可直接输入密钥，或使用代理进程继承的环境变量名；管理接口不回显上游 Key，编辑时留空保留
同一渠道/Key ID 已保存的密钥，填写新值则替换。环境变量缺失的 Key 不参与分配，重复的实际
凭证不会增加轮询权重。明文密钥只存在代理本机配置和执行所必需的受限 OpenCode 临时配置，
不加入仓库、请求日志、会话 ID、模型发现或健康状态。应保护本机配置文件；使用环境变量可
避免在代理配置中保存明文，但 OpenCode 运行时仍需获得凭证。

以下是新增 `channels` 的配置片段，不要替换原有 `apiKeys`、`models` 或全局认证文件：

```json
{
  "channels": [{
    "id": "deepseek-pool",
    "name": "DeepSeek 渠道",
    "enabled": true,
    "protocol": "openai-chat",
    "baseURL": "https://替换为实际上游地址/v1",
    "stickyTtlMs": 1800000,
    "maxBindings": 10000,
    "cooldownMs": 30000,
    "maxKeyAttempts": 2,
    "keys": [
      {"id":"a","name":"Key A","apiKeyEnv":"CHANNEL_KEY_A","enabled":true},
      {"id":"b","name":"Key B","apiKeyEnv":"CHANNEL_KEY_B","enabled":true}
    ],
    "models": [{"alias":"pooled-deepseek","id":"替换为上游模型ID","context":128000,"output":8192,"toolcall":true}]
  }]
}
```

`npm run test:channels` 验证调度、过期、故障、管理接口和三个客户端协议。
设置 `TEST_OPENCODE_COMMAND` 后，执行
`node --test --test-name-pattern='^channels:' test/global.test.mjs`，通过一次性全局配置和本地
模拟上游验证真实 OpenCode，不使用生产凭证。GitHub Windows/Linux 构建也运行这些渠道测试。
本轮执行结果和验证边界见[回归记录](validation/2026-10-22-channel-key-rotation.md)。
