# OpenCode Proxy for Magpie

将本机全局 OpenCode 已连接的模型注册为 Magpie 供应商。

调用链：客户端 → Magpie → 本插件 → 真实 OpenCode 的 Session、模型 SDK、provider 鉴权与发送链 → 模型服务。

模型请求由 OpenCode 自己发送。供应商认证插件、客户端身份头及定制 provider 的请求签名由 OpenCode 执行，签名针对它实际发送的请求体计算。本插件通过公开 Session API 和 hooks 桥接客户端输入，不修改 OpenCode 程序。

## 安装

需要 Node.js 22 或更新版本、可用的 Magpie 插件宿主和已安装的 OpenCode v1。先确认同一运行用户可以在 OpenCode 中正常使用目标模型。

```sh
npm ci --ignore-scripts
magpie plugin add D:/projects/opencode-proxy
magpie plugin login opencode-proxy
```

也可以在 Magpie 的 Plugins 中添加本地仓库目录，启用 **Local OpenCode**。支持免密启用的版本直接启用；若显示 Key 输入框，填 `local`，它只是本机接入标记。

在 Magpie 中刷新供应商模型，选择 `opencode-proxy/<短模型名>`。重名模型保留供应商前缀；仅发布已连接供应商的模型，目录不包含凭证、供应商地址或请求头。

只在 Magpie 安装本插件。它会为自己启动的 OpenCode 工作进程自动加载包内辅助插件；无需手动修改全局 OpenCode 插件配置。

## 配置

打开 **Plugins → Installed → Local OpenCode → Options**，编辑 JSON，保存并重新启用插件。

```json
{
  "command": ["opencode"],
  "workingDirectory": "D:/projects/your-project",
  "workerReuse": true,
  "workerSharing": true,
  "maxIdleWorkers": 2,
  "workerIdleMs": 60000,
  "startupTimeoutMs": 20000,
  "firstOutputTimeoutMs": 120000,
  "idleTimeoutMs": 180000,
  "timeoutMs": 0
}
```

| 选项 | 说明 |
| --- | --- |
| `command` | OpenCode 程序和可选参数数组，默认 `["opencode"]`；可使用绝对路径。 |
| `workingDirectory` | OpenCode 使用的真实目录；相对路径以 Magpie 提供的目录为基准。共享模式省略时使用用户主目录，独占模式省略时使用临时工作目录。 |
| `workerReuse` | 是否复用清理完成的工作进程，默认 `true`。 |
| `workerSharing` | 是否共享 OpenCode 进程，默认 `true`。相同运行配置和工具合约下，多个模型及供应商共享进程；设为 `false` 使用独占工作进程。 |
| `maxIdleWorkers` | 最多保留的空闲进程数，默认 `2`；不限制正在推理的请求数。 |
| `workerIdleMs` | 空闲进程回收时间，默认 `60000` 毫秒，须为正整数。 |
| `startupTimeoutMs` | 程序和工具桥接启动时限，默认 `15000` 毫秒。 |
| `firstOutputTimeoutMs` | 模型首个输出事件的等待时限，默认 `120000` 毫秒。 |
| `idleTimeoutMs` | 模型后续输出事件间隔时限，默认 `180000` 毫秒。 |
| `timeoutMs` | 总请求时限，默认 `0`，表示不设总时限。 |

默认推理并发不限，由 Magpie 控制接入并发。共享模式按运行配置和完整工具合约分组，同组请求使用独立 Session 并共享进程；模型和供应商不额外拆分进程。不同工具 schema、权限或运行配置仍可能产生多个进程，不是全局单进程模式。独占模式为活动请求分配独立工作进程，完成清理后复用。

每个共享进程只订阅一条全局 SSE，按 Session ID 分发到独立队列。每请求事件缓冲上限为 8 MiB，超限仅中止该请求；取消订阅会释放队列，不关闭其他请求的连接。全局事件流异常时返回错误，由调用方重试。

## 请求与鉴权

保留 OpenCode 的全局认证和供应商配置。模型发现不发起推理，也不自动预热模型；刷新模型时重新读取配置，后续请求使用新进程组，已有推理完成并清理后退出旧组。OpenCode 的认证插件正常刷新令牌时，可以更新自己的认证库。

每次业务请求通过真实 Session 完成历史与系统提示桥接，然后继续执行 `chat.params`、`chat.headers`、OpenCode 请求准备、模型 SDK 和最终 provider 发送逻辑。插件不缓存探测请求的签名，也不自行拼接供应商客户端身份。

自定义版本号不作为运行门禁；兼容性取决于实际管理接口与 hooks。对 OpenCode 核心鉴权、审计、请求签名或网络传输做过定制的版本，需要在对应环境验证。

## 协议与工具

插件向 Magpie 声明 Chat Completions。Responses、Messages 等客户端协议由 Magpie 转换，OpenCode 再通过模型 SDK 调用供应商接口；不提供 Responses 存储接口。

支持客户端系统提示、历史、函数工具、思考参数及内联附件的桥接。客户端请求会经过 Session 和 SDK 的表示转换，不保证原始 JSON 字段逐字透传。签名思考块、加密推理、远程文件和托管工具取决于 Magpie、OpenCode SDK 及供应商的共同支持。

共享模式仅在存在客户端工具或需要桥接捕获的结构化输出时建立 MCP；纯文本请求不建立空 MCP 服务。函数工具通过桥接 MCP 声明，工具调用和结果交给客户端处理。本地内置工具受限，插件阻止工具返回后自动继续推理。工具名称与调用 ID 可先返回，参数需等待 OpenCode 发布完整 JSON，无法保证逐字符参数增量。

多轮历史由调用方逐轮提交。请求的 Session、历史、采样参数和取消状态独立，结束后删除 Session 并确认清理；清理失败的进程不归还复用池。

## 超时、取消与资源

流式文本、usage、背压、取消和错误通过桥接传递。请求中断会取消对应 Session；Magpie 宿主退出后，工作进程通过父进程检测停止。正常释放会先取消推理、清理 Session，再回收进程。

插件收到 OpenCode 的推理重试事件时中止该请求并返回错误，由调用方决定是否重试。已输出部分内容的请求不重放；额度或速率限制按 429 返回，公开的上游错误原因和有效 `Retry-After` 会保留。

Session、数据库、SDK 和桥接 MCP 都有运行开销，不能视为零 Session 或零 OpenCode 开销。客户端历史会参与 Session 桥接，运行数据存放在临时工作区；插件不提供持久化请求日志、用量统计、账号余额或供应商价格查询。

## 开发与测试

```sh
npm ci --ignore-scripts
npm test
npm run check
npm pack
```

`npm run benchmark:resources -- artifacts/resources.json` 在同一真实 OpenCode 上测量默认并发、单模型共享和多模型共享；`--baseline` 使用仓库中的固定基线源码副本，不切换分支或修改 OpenCode。所有请求使用临时配置和回环模拟服务，逐条核对完整流式文本、身份凭证及实际请求体签名。RSS 为发送请求时采样，不是峰值；Node CPU 包含模拟服务和消费端。

测量方法、样本数据与开源参考见 [资源测量报告](docs/resource-measurements.md)。

`npm run test:integration` 需要将 `TEST_OPENCODE_COMMAND` 设置为真实 OpenCode 命令的 JSON 数组。测试使用临时用户配置、虚构凭证及回环模拟供应商，不使用生产凭证；覆盖历史和参数、工具往返、流式输出、中断、进程复用、凭证隔离、64 路共享 Session 隔离、超时与调用方重试。鉴权回归检查 hook 注入的 Cookie 和针对实际 SDK 请求体计算的模拟签名，不替代内网证书签名验收。

`npm run test:magpie-host` 还需要 Bun，并将 `TEST_MAGPIE_HOST` 指向 Magpie 的 `internal/plugin/host.js`，验证真实宿主的插件加载、模型发现及转发契约。

可选 CI 使用独立测试运行时，在 Windows/Linux 上验证 OpenCode 1.16.2 和 1.18.35。模拟供应商结果不代表真实业务吞吐或长期内存稳定性。

桥接核心的 MIT 版权声明见 LICENSE、NOTICE.txt 和 docs/third-party-licenses.txt。
