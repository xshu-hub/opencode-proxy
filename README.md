# OpenCode Proxy for Magpie

把本机全局 OpenCode 中已连接的模型注册为 Magpie 供应商。只安装一个 Magpie 插件；它自动给自己启动的真实 OpenCode v1 进程加载包内辅助插件，不修改 OpenCode 程序，也不把供应商凭证带到 Magpie。

调用链：客户端 → Magpie（协议转换、访问 Key、路由、统计）→ 本插件 → OpenCode 进程中的原供应商鉴权 fetch → 模型 API。

默认复用传输模式下，业务请求不经过 OpenCode Session 推理、Agent、MCP、工具执行或数据库消息写入。客户端提供的 system、历史、工具、思考参数等原生 JSON 字段保留，只将模型短名替换为真实模型 API ID；响应按字节流转发。没有第二层协议转换、自动工具执行、重试或 Session 推理回退。0.11.0 增加可选的逐请求 headers hook 模式，需要额外临时 Session，见下文。

## 安装

先确认同一运行用户可以正常使用全局 OpenCode。Magpie 插件宿主需要 Bun；本包不安装 OpenCode，运行时仅依赖 HTTP 客户端 Undici。

```sh
npm ci --ignore-scripts
magpie plugin add D:/projects/opencode-proxy
magpie plugin login opencode-proxy
```

也可以在 Magpie 的 Plugins 中添加本地仓库目录，启用 **Local OpenCode**。支持免密启用的版本直接启用；旧版若显示 Key 输入框，填 `local`，它只是本机接入标记。发布 npm 包后可使用 `magpie plugin add @xshu-hub/opencode-proxy`，本次改造不自动发布。

在 Magpie 中刷新供应商模型并选择 `opencode-proxy/<短模型名>`。重名模型保留供应商前缀；仅发布已连接的供应商模型。目录不包含凭证、供应商地址或请求头，也不将 Magpie 自身模型回流。

**只在 Magpie 安装。** 无需手动修改 OpenCode 的 plugin 配置；原有供应商认证插件继续由 OpenCode 加载。

## 配置

打开 **Plugins → Installed → Local OpenCode → Options**，编辑 JSON、保存并重新启用插件。更新插件元数据后可重启 Magpie 刷新 Options 入口。配置由 Magpie 保存，无需另建 config.json。

```json
{
  "command": ["opencode"],
  "workingDirectory": "D:/projects/your-project",
  "startupTimeoutMs": 20000,
  "firstOutputTimeoutMs": 120000,
  "idleTimeoutMs": 180000,
  "timeoutMs": 0
}
```

- `command`：程序与可选启动参数数组；可用绝对路径解决 PATH 问题。
- `workingDirectory`：已存在的真实目录；可省略，默认用户主目录。相对路径以 Magpie 提供的目录为基准。
- `startupTimeoutMs`：进程和插件启动时限。
- `firstOutputTimeoutMs`：从接收请求到上游首个响应字节的时限，包含首次传输初始化。
- `idleTimeoutMs`：后续输出间隔时限；下游背压等待不计入空闲时限。
- `timeoutMs`：整次转发时限，`0` 表示不设总时限。
- `headerHooks`：默认 `"reject"`，复用已捕获的鉴权传输并拒绝非空 `chat.headers` 输出。需要该 hook 的供应商可设置 `"per-request"`；启用后每个请求都会重新执行 hooks，并创建、清理自己的临时 Session。

默认不限制推理并发，接入并发由 Magpie 控制。一个插件实例常驻一个 OpenCode 进程；业务请求不会增加进程。刷新模型时，若有未完成请求会返回忙碌；空闲时先退出旧进程，再启动一个进程读取全局配置和凭证。异常退出后返回错误，刷新模型或重新启用插件可恢复，不重放业务请求。

旧版已保存的 `workerSharing`、`workerReuse:true`、`maxIdleWorkers`、`workerIdleMs` 可继续读取，但不再控制进程池。`workerReuse:false` 会报错，需移除。

## 支持范围

| OpenCode 模型 SDK | 交给 Magpie 的原生 API |
| --- | --- |
| `@ai-sdk/openai-compatible` | Chat Completions |
| `@ai-sdk/openai` | Responses |
| `@ai-sdk/anthropic` | Messages |

Magpie 根据每个模型的 SDK 选择转换目标。本插件只负责原生请求传输，不提供 Responses 存储等管理接口。文本、附件、签名思考块、托管工具等字段的可用性仍取决于 Magpie 的转换和供应商接口。

供应商鉴权 loader 的自定义 `fetch`、静态 API Key、供应商/模型配置请求头在真实 OpenCode 进程内使用。为了避免 Bun 原生 fetch 的大响应预取，仅在当前鉴权调用的异步作用域内将网络 fetch 交给 Undici；作用域以外继续调用原 fetch，不修改 OpenCode 程序文件。支持环境 HTTP(S) 代理。OAuth 并发刷新协调适用于 OpenCode 文件认证库中已过期的 OAuth 状态；实际刷新与保存仍由原认证插件完成。外部凭证库、提前刷新策略及任意第三方认证插件不能据此视为已经兼容。

每轮 `chat.headers` 动态签名需要启用 `headerHooks: "per-request"`；默认模式明确报兼容性错误。未知 SDK、含查询参数或模板占位符的特殊地址仍不支持。绕过作用域 fetch、缓冲/包装响应，或使用 Bun 特有 TLS/代理选项的认证插件也返回 501，不静默丢失鉴权语义或流控。该路径不运行供应商 SDK 的请求改写；原认证 fetch 自身仍能改写请求，依赖这些行为的供应商需要单独验证。

遇到 `unsupported_dynamic_headers` 时，在现有 Options JSON 中增加 `"headerHooks": "per-request"`，保存并重新启用插件。该模式通过真实 OpenCode 为每个请求执行 `chat.params` 和 `chat.headers`，取得新请求头后在模型推理前停止，中止并删除探测 Session，再转发原始 JSON。hook 请求头覆盖静态模型请求头，原供应商认证 fetch 继续执行；转发使用该次 hook 的 Session/Message ID，支持绑定这些 ID 的签名。各请求独立探测，可并发，不共享签名或取消信号；某轮输出为空也不会跳过下一轮 hook。

OpenCode 1.x 的公开插件接口没有独立调用任意 headers hook 的入口，因此此模式会为**所有请求**增加 Session 创建、数据库写入、hook 执行和清理开销，不属于零 Session 路径。只写固定的传输探测文本，不把客户端历史、system 或工具写入探测 Session；hook 收到的是 OpenCode 生成的探测消息元数据，依赖特定 Agent 或消息内容的 hook 仍需单独验证。客户端内容、工具和协议不经过 Session 推理。默认模式仍保持首次初始化后复用传输。

## 生命周期与资源

发现模型不发起推理。默认模式下，每个模型首次使用时创建一个临时初始化 Session，在 v1 的 `chat.params`/`chat.headers` hooks 取得鉴权传输，并在 SDK 推理前停止，随后中止、删除该 Session，才放行业务请求。同模型并发首次请求共享一次初始化；不同模型的初始化依次进行，已初始化模型的转发并行执行。逐请求 headers 模式则为每次转发创建独立探测，完成清理后才发出该次模型请求；初始化保护会持续到最后一个并发探测清理完成。

因此启动及初始化仍涉及 OpenCode 的数据库、配置加载和常驻内存；不能称为完全无 Session、无数据库或零 OpenCode 开销。数据库隔离在插件临时目录，业务请求不写入会话历史，不向供应商注入 OpenCode 内置提示词和工具。项目指令、外部 skills、MCP、快照与文件监视在该实例中关闭；用户原配置不被覆盖。

请求体上限 16 MiB。私有链路使用 256 KiB 字节窗口限制预取，按下游读取进度补充额度，既不解析也不改写流内容。取消通过私有控制接口传到上游，避免运行时未报告断连造成悬挂。首字节前超时返回 504；流已经开始后的失败中断流，不伪造成功结束。保留上游 HTTP 状态与错误正文。插件不记录请求内容或持久化统计。

多轮对话的完整历史由调用方逐轮提交，不保存在 OpenCode Session 中。函数工具的分片参数、并行调用、调用 ID 与工具结果按原生协议传递，工具由客户端执行。不同请求可使用相同工具调用 ID，不共享历史、工具定义、取消信号或超时状态。

插件默认不自动重试。首字节前超时返回 504，连接失败返回 503，上游 429/503 及 `Retry-After` 原样返回，由调用方按自己的策略重新提交；取消与已经输出部分数据的请求不在插件内重放。原生 SSE 的事件语义和完成标记由 Magpie/客户端处理，插件不生成虚假的完成事件。

正常释放会取消请求、停止 OpenCode 并移除临时目录；OpenCode 辅助插件也检测 Magpie 宿主退出。OpenCode 的全局认证/供应商配置继续保留，认证插件正常刷新令牌时仍可更新自己的认证库。

## 开发与测试

```sh
npm ci --ignore-scripts
npm test
npm run check
npm pack
```

`npm run test:integration` 需要 `TEST_OPENCODE_COMMAND` 为真实 OpenCode v1 命令的 JSON 数组。全部使用临时用户配置、虚构凭证和回环模拟供应商，不使用生产凭证。覆盖冷启动 64 并发、三轮 64 并发、OAuth 刷新去重、原生三协议、提示词/工具原样传递、超时、取消、背压、模型刷新及退出清理；资源采样写入忽略 Git 的 `artifacts/native-transport.json`。模拟服务结果不代表真实供应商吞吐或长期内存稳定性。

`test/behavior-integration.test.mjs` 还覆盖三协议首字节早于 EOF、UTF-8 跨网络分片、8 路四轮工具对话、32 路混合供应商流式隔离、并行工具参数增量、签名/加密思考历史、单请求中断、持续输出中的总超时、调用方重试，以及初始化期间一个/全部等待者中断的清理。行为结果写入 `artifacts/behavior-verification.json`。真实 Magpie Bun 宿主测试另验证 RPC 并发关联、工具往返、背压和 `abort` 控制消息。

`test/header-hooks-integration.test.mjs` 验证逐请求模式的 64 路冷启动、HMAC/nonce 不复用、Session/Message ID 绑定、静态头覆盖、OAuth 刷新、三协议载荷、工具往返、并发探测、单请求中断、首字节/空闲超时及调用方重试。指标写入 `artifacts/header-hooks-<版本>.json`；当前模拟环境中两版的 64 个冷请求约耗时 4.4 秒，不能作为真实供应商吞吐或长期内存稳定性的保证。

`npm run test:magpie-host` 还需要 `TEST_MAGPIE_HOST` 指向 Magpie 的 `internal/plugin/host.js`，且 Bun 可用，验证真实宿主加载与转发契约。设置 `TEST_HEADER_HOOKS=per-request` 可额外验证真实宿主的逐请求模式。

0.10.1 移除版本号白名单；健康接口的版本字符串仅用于诊断，允许内网自定义标签。初始化管理调用统一经过正在服务的 OpenCode HTTP 实例，显式绑定同一个目录，兼容旧版插件 SDK 的内部 HTTP 应用与服务实例状态不一致问题。是否可用取决于实际管理接口、供应商配置和推理前 hooks；缺少 hooks、动态请求头或不支持的鉴权行为仍明确报错，不绕过 OpenCode 或回退到 Session 推理。

源码抽查了上游 [1.15.0](https://github.com/anomalyco/opencode/blob/v1.15.0/packages/opencode/src/session/llm.ts)、[1.16.2](https://github.com/anomalyco/opencode/blob/v1.16.2/packages/opencode/src/session/llm/request.ts)、[1.17.0](https://github.com/anomalyco/opencode/blob/v1.17.0/packages/opencode/src/session/llm/request.ts)、[1.18.0](https://github.com/anomalyco/opencode/blob/v1.18.0/packages/opencode/src/session/llm/request.ts)：均按 `chat.params → chat.headers → 模型推理` 排列。

0.10.2 将初始化联网保护收窄为原生推理端点保护。供应商在 hooks 前的元数据查询、自定义鉴权预检和令牌请求继续由 OpenCode 执行；不再因为它们访问了其他服务而返回 `bootstrap_hook_order`。初始化期间，作用域外的全局 fetch 若访问以 `/chat/completions`、`/completions`、`/responses` 或 `/messages` 结尾的接口，仍返回该错误并清理 Session，错误仅显示接口类别，不包含地址、查询参数、请求内容或凭证。已初始化模型的业务请求不受该保护影响，可与其他模型的初始化并发执行。

该保护按原生接口路径识别请求，不是通用网络沙箱；不读取或转换请求正文。定制核心若把推理改写到其他路径、使用预先捕获的 fetch 或其他网络库，不能据此证明初始化不会推理；内网定制鉴权和推理前 hook 顺序仍需部署实测。

本地真实进程验证版本为 **1.16.2、1.18.0**；可选 CI 覆盖 Windows/Linux 的 **1.16.2、1.18.35**。源码抽查不等同于逐版本运行测试，v2 未验证。

原桥接核心的 MIT 版权声明保留在 LICENSE 与 NOTICE.txt。
