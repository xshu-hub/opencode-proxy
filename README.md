# OpenCode Proxy

独立 OpenCode 反向代理。推理经过真实全局 OpenCode，复用其供应商配置、登录与认证插件，不修改 OpenCode。对外提供 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages，支持流式文本与客户端函数工具。

0.7.0 同步并精简 Magpie 最新前端（`a75de4c2`）：仅保留模型和网关，移除统计及请求记录。Windows 使用 Wails 2 + Go + WebView2；Linux 使用独立服务和浏览器界面。没有 Electron，成品运行无需 Node.js 或 Bun。

## Windows

完整解压，运行 `opencode-proxy.exe`，保留同目录 `opencode-proxy-server.exe` 和 resources。全局 opencode 应在当前用户 PATH 中可用；必要时在设置 → OpenCode 指定程序和工作目录。

- **模型**：点击供应商行编辑；模型芯片控制启用。“名称与推理档位”设置纯名称/别名、上下文/输出上限、默认 Temperature / Top P / 输出 Token、默认思考强度、原生或自定义可选档位，修改后保存。
- **网关**：启动、停止、重启，选择三种协议查看连接地址与示例；创建、复制、启停、重命名或轮换访问 Key。
- **设置**：OpenCode、工作目录、超时、监听地址和端口、外观、后台运行。

参数留空跟随 OpenCode，客户端显式参数优先。上限不能超过 OpenCode 报告的值，别名不能冲突。自定义思考档位仍需上游 SDK 与模型支持；未知 SDK 保留原生档位。

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

不再采集持久化统计、不存储提示词/工具参数及原始请求/响应；不读取、不删除旧统计文件。响应中真实 usage 仍转发。必要的进程错误和可选诊断仍可输出到终端。

- 不限制 OpenCode 版本，兼容性由其公开 API/hooks 决定。
- 默认不限并发，每个活动请求独占进程、会话和数据库。默认最多复用两个健康空闲工作进程，空闲 60 秒退出。
- 供应商、登录与认证插件由全局 OpenCode 管理。客户端系统提示与历史通过公开 hooks 替换默认代理提示；认证插件的参数、请求头及 fetch 逻辑仍可能运行。
- 禁止执行本地内置工具，function tools 由客户端执行。参数在完整 JSON 后返回，没有逐字符工具参数 delta。暂不支持图片、音频、embeddings；详见 [协议说明](docs/protocols.md)。
- 首输出默认 120 秒，输出空闲默认 180 秒，总时长默认不限。旧配置总超时仍生效，可在设置中改为 0。

## 开发

```sh
npm ci --ignore-scripts
npm ci --prefix frontend --ignore-scripts
npm run build:ui
npm test
npm run package:windows  # Go + Bun
npm run package:linux    # Bun
```

GitHub 构建 Windows/Linux，检查前端语法、单元测试、Windows 托盘，以及真实 OpenCode 1.18.35 + 本地模拟供应商的打包后集成测试。不调用生产账号，不构建 Magpie。前端来源见 [移植说明](docs/frontend-port.md)，保留 Magpie MIT 许可证。
