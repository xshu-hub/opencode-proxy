# OpenCode Proxy

独立 OpenCode 反向代理。推理经过真实全局 OpenCode，复用其供应商配置、登录与认证插件，不修改 OpenCode。对外提供 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages，支持流式文本与客户端函数工具。

0.8.0 使用重新设计的独立前端：原生 ES Modules + CSS，零运行时框架依赖。模型、网关、OpenCode、网络与超时、外观与运行直接排列在主导航中，没有底部设置或关于页面。Windows 使用 Wails 2 + Go + WebView2；Linux 使用独立服务和浏览器界面。没有 Electron，成品运行无需 Node.js 或 Bun。

## Windows

完整解压，运行 `opencode-proxy.exe`，保留同目录 `opencode-proxy-server.exe` 和 resources。全局 opencode 应在当前用户 PATH 中可用；必要时在主导航的 OpenCode 页面指定程序、启动参数和工作目录。

- **模型**：搜索、供应商/状态筛选、分页、单独或批量启停；点击“配置”打开右侧面板，设置纯名称/别名、上下文/输出上限、默认 Temperature / Top P / 输出 Token、默认思考强度和自定义可选档位。测试对话框可选择三种协议。
- **网关**：启动、停止、重启，选择三种协议查看连接地址与示例；创建、复制、启停、重命名或轮换访问 Key。
- **OpenCode**：全局程序、启动参数、工作目录，客户端支持文件/目录选择。
- **网络与超时**：监听地址、端口、并发、超时和空闲工作进程配置；可开启 OpenCode 1 的低内存并发。超时按秒填写。
- **外观与运行**：跟随系统/浅色/深色、文字大小、托盘和退出。

参数留空跟随 OpenCode，客户端显式参数优先。上限不能超过 OpenCode 报告的值，别名不能冲突。自定义思考档位仍需上游 SDK 与模型支持；未知 SDK 保留原生档位。供应商和认证只在本机全局 OpenCode 配置，代理不再提供上游渠道或多 Key 轮转。

三种客户端协议支持严格 JSON 输出、严格函数参数、指定/必选工具及串行工具约束。Responses 显式 `store=true` 可使用按访问 Key 隔离、有过期和容量限制的内存会话续接、查询与删除；默认仍不保存会话。内联附件及 Responses/Anthropic 图片工具结果按 OpenCode 模型声明的输入能力转发，图片结果保留调用归属并在并行结果收齐后交给模型。短暂断网/限流由 OpenCode 在输出前有限重试，输出后故障明确返回错误，避免重放内容。完整支持范围和限制见 [协议说明](docs/protocols.md)。

默认配置 `%LOCALAPPDATA%\OpenCodeProxy\config.json`。关闭窗口隐藏到托盘，网关继续运行。再次启动 EXE、点击托盘图标或菜单“打开”恢复窗口；“退出程序”才停止服务。`opencode-proxy.exe --background` 启动到托盘。

## Linux

```sh
chmod +x opencode-proxy-server
./opencode-proxy-server --host 0.0.0.0 --port 8787
```

OpenCode 必须属于同一运行用户，且在 PATH 可用，或用 `--opencode /路径/opencode` 指定。`--working-directory /目录` 指定工作目录。后台运行可使用 systemd 或终端会话管理。

默认管理页面 `http://127.0.0.1:8788`，API 基址 `http://127.0.0.1:8787/v1`。管理端只监听本机；远程管理使用 SSH 转发：

```sh
ssh -L 8788:127.0.0.1:8788 user@server
```

默认配置 `${XDG_CONFIG_HOME:-$HOME/.config}/OpenCodeProxy/config.json`，可用 `--config /路径/config.json` 覆盖。使用其他用户运行服务不会复用当前用户登录。

## 连接与行为

Cherry Studio 等客户端填写 API 地址与访问 Key，再刷新模型列表。支持 `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`。Anthropic SDK 使用不含 /v1 的根地址。首次启动自动生成访问 Key；它与供应商凭证不同。

三种接口提供历史、函数工具、结构化输出和内联附件的兼容子集。Responses 支持 namespace 分组工具、custom 自由文本工具、原样多轮历史和显式内存会话续接；Anthropic 支持常见流式工具参数，以及 OpenCode 思考文本的无签名展示和历史回传。模型列表和单模型查询按客户端返回 OpenAI 或 Anthropic 格式，API 支持浏览器 CORS。加密推理、供应商签名思考历史、Token 预估等限制详见 [协议说明](docs/protocols.md)。

不再采集持久化统计、不将提示词、工具参数及原始请求/响应保存为请求日志；不读取、不删除旧统计文件或请求记录。管理界面不提供统计、请求日志或有效请求视图。响应中真实 usage 仍转发。必要的进程错误和可选诊断仍可输出到终端；Windows 桌面端将服务的标准错误输出写入配置目录下的 `desktop.log`，用于启动与运行故障排查。

- 默认模式不限制 OpenCode 版本，兼容性由其公开 API/hooks 决定；可选共享模式要求兼容的 OpenCode 1，目前通过本机 1.18.0 验证。
- 默认不限请求并发，采用每个请求独占进程、会话和数据库的隔离方式。可在“网络与超时”开启低内存并发（`workerSharing: true`）：同模型、同配置的请求共享本机 OpenCode 1 进程，分别使用独立实例、会话和工具配置；数据库在同组进程内共享。共享模式默认关闭，隔离、工作目录及故障边界见[共享进程说明](docs/shared-processes.md)。
- 网关启动后异步进行无推理预热，默认保留最多两个最近使用模型的热进程；`warmupModels` 可指定初始预热模型，否则选择已启用模型。热进程保持到停止网关，其他空闲进程默认 60 秒退出；全部空闲进程仍受 `maxIdleWorkers` 限制。冷启动最多同时初始化两个进程，不限制已初始化请求的推理并发。
- 供应商、登录与认证插件由全局 OpenCode 管理。客户端系统提示与历史通过公开 hooks 替换默认代理提示；认证插件的参数、请求头及 fetch 逻辑仍可能运行。
- 禁止执行本地内置工具，function tools 由客户端执行。原生工具 ID/名称在 OpenCode 宣告时先返回，参数在完整 JSON 后返回，没有逐字符工具参数 delta。内联图片、PDF 和音频需要模型声明对应输入能力；不支持 embeddings、远程附件 URL 或文件 ID，详见 [协议说明](docs/protocols.md)。
- 模型完成后先返回协议结束事件，后台等待中止确认、删除会话和重置实例；清理成功后进程才可复用。SSE 成功响应立即刷新响应头，空闲时发送注释心跳，并保留背压和中断传播；首个有效输出前的错误仍返回真实 HTTP 状态。
- 独立进程模式在冷启动排队结束后优先复用期间归还的健康进程；重置和空闲保留共用 `maxIdleWorkers` 预算，超额完成的进程直接回收。第一轮测量见[并发内存分析](docs/validation/2026-10-28-concurrency-memory.md)；共享模式的持续并发内存对比见[共享进程说明](docs/shared-processes.md)。
- 首输出默认 120 秒，输出空闲默认 180 秒，总时长默认不限。旧配置总超时仍生效，可在设置中改为 0。

## 开发

```sh
npm ci --ignore-scripts
npm ci --prefix frontend --ignore-scripts
npm run build:ui
npm test
npm run test:contracts   # 协议事件、namespace/custom 历史与图片工具结果契约；也包含在 npm test 中
npm run test:hot-path    # 热池、取消等待、后台清理与 SSE 首包契约；也包含在 npm test 中
npm run test:integration # TEST_OPENCODE_COMMAND 指向真实 OpenCode；使用一次性配置和本地模拟供应商
npm run package:windows  # Go + Bun
npm run package:linux    # Bun
```

GitHub 构建 Windows/Linux，检查前端语法、单元测试、Windows 托盘，以及真实 OpenCode 1.18.35 + 本地模拟供应商的打包后集成、无推理预热和后台清理测试。不调用生产账号，不构建 Magpie。[前端说明](docs/frontend-port.md)记录设计参考与结构；桥接核心继续保留原 Magpie MIT 版权声明。

真实供应商回归使用 `npm run test:live`，需要设置 `OPENCODE_PROXY_LIVE_URL`（网关的 /v1 基址）和 `OPENCODE_PROXY_LIVE_KEY`（网关访问 Key）。`OPENCODE_PROXY_LIVE_MODELS` 为逗号分隔的短模型名，默认测试 deepseek-flash、deepseek-v4-pro；`OPENCODE_PROXY_LIVE_CONCURRENCY` 默认 12。脚本只向网关发起推理请求，结果默认写入系统临时目录。可用 `-- --pressure-only` 单独重跑压力场景。

`npm run test:live:shared` 专门验证本机 OpenCode 1 共享进程，固定只允许已配置的 `deepseek-flash`。读取本机代理配置并启动独立临时网关，沿用全局 OpenCode 认证，不修改现有配置。覆盖三个协议的三轮对话、两轮工具调用、流式中文/Emoji、历史续接、并发工具隔离、取消及真实连接/进程中断恢复，并比较冷进程、预热和复用首字耗时。该命令调用真实模型，报告仅写系统临时目录，不在 CI 运行；可通过 `OPENCODE_PROXY_LIVE_FILTER` 正则选择用例。结果与边界见[共享模式真实模型验证](docs/validation/2026-10-28-shared-live.md)。

`npm run test:live:advanced` 使用 `TEST_OPENCODE_COMMAND`（JSON 命令数组）和 `TEST_DSH_ROOT`（已安装的 `@deepseek-ai/dsh` 包目录），自动启动临时网关并验证三个协议、两个 DeepSeek 模型、Responses namespace/custom 工具、官方 OpenAI SDK、DSH 原生 Messages 适配器、图片工具结果、思考开关、并发和中断恢复。DSH 文件索引和报告均在临时目录，不修改客户端配置；所有推理仍由全局 OpenCode 使用已有认证完成。该测试会调用真实模型，不在 CI 中运行。Flash 验证真实图片理解；文本模型 Pro 验证图片请求明确拒绝。

`OPENCODE_PROXY_LIVE_FILTER` 可按“协议/模型/用例名”的正则表达式筛选高级回归，例如 `^dsh/` 仅验证 DSH。[本轮验证记录](docs/validation/2026-10-19-protocol-contracts.md)包含覆盖范围及已知限制。

`npm run test:live:latency` 使用相同的 `TEST_OPENCODE_COMMAND` 和 `TEST_DSH_ROOT`，比较两个 DeepSeek 模型在三种协议及 DSH Messages 适配器中的真实首字、流式增量和结束延迟。默认每组 3 次新网关首请求及 3 次进程复用请求，另测一次预热就绪后的首请求，单独记录预热耗时。`OPENCODE_PROXY_BENCH_SOURCE` 可指向优化前代码快照，`OPENCODE_PROXY_BENCH_PHASE` 标记报告阶段。报告只写系统临时目录，真实模型调用不在 CI 中运行。结果与测量边界见[延迟验证记录](docs/validation/2026-10-19-streaming-latency.md)。

若额外设置 `OPENCODE_PROXY_LIVE_ADMIN_URL` 和 `OPENCODE_PROXY_LIVE_ADMIN_KEY`，脚本会在该测试实例上临时设置并发上限 8，发起 64 路突发请求，然后恢复原配置。此管理场景应连接独立测试实例，避免影响已有服务。CI 仅使用一次性配置和本地模拟供应商，不运行需要真实账号的 test:live。
