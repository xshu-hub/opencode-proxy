# OpenCode Proxy

对外提供 **OpenAI Chat Completions、OpenAI Responses、Anthropic Messages** 三种协议，共用模型、别名、访问 Key、日志和统计；请求均经过真实全局 OpenCode。支持范围与原生协议的差异见 [协议说明](docs/protocols.md)。

独立的 OpenCode 反代工具，带 Windows EXE 客户端和 Linux 服务端。
客户端 → OpenCode Proxy → 真实全局 OpenCode → 已配置的上游供应商。

## Windows 客户端

下载 Windows 压缩包并完整解压，双击 `opencode-proxy.exe`。同目录中的服务 EXE 和 resources 必须保留。无需另外安装 Node.js 或 Bun；仍需要已安装、能够正常对话的全局 OpenCode，以及 Windows WebView2 运行时。

界面提供：

- 概览：API 状态、连接地址、活动请求、Token、平均首字、速度和模型测试。
- OpenCode：程序路径、原生目录选择、工作目录、监听地址、端口、时限和进程复用。
- 模型与别名：自动模型发现，配置对外模型名、上下文/输出上限、temperature、top_p、max_tokens、reasoning_effort。
- 访问 Key：生成、编辑、复制、停用或移除多个客户端 Key。
- 调用日志：首字、速度、Token、缓存、耗时、状态、错误、进程复用及完整请求/响应详情。
- 用量统计：按模型汇总和每日趋势，重启后继续保留。

参数留空时跟随 OpenCode；客户端显式参数优先。配置上限不能超过 OpenCode 报告的上限。模型别名不能与其他模型冲突。

默认配置位置是 `%LOCALAPPDATA%\OpenCodeProxy\config.json`。统计保存在同目录 statistics.json，完整请求和原始响应保存在 requests 目录。关闭桌面窗口会关闭其启动的服务和 OpenCode 子进程。

## Linux 服务端

完整解压 Linux 包，直接运行：

```sh
chmod +x opencode-proxy-server
./opencode-proxy-server --host 0.0.0.0 --port 8787
```

同样不需要安装 Node.js 或 Bun。OpenCode 必须在同一运行用户的 PATH 中可用，或用 `--opencode /完整路径/opencode` 指定。读取该用户的全局供应商配置和登录；不要用其他用户的服务进程来期望复用当前用户的登录。

默认管理页面 `http://127.0.0.1:8788`，API 基址 `http://127.0.0.1:8787/v1`。管理端只监听回环地址，远程管理可使用 SSH 转发：

```sh
ssh -L 8788:127.0.0.1:8788 user@server
```

然后在本机浏览器打开同一个管理地址。默认配置在 `${XDG_CONFIG_HOME:-$HOME/.config}/OpenCodeProxy/config.json`，可用 `--config /路径/config.json` 覆盖。

## 客户端连接

在 Cherry Studio 等 OpenAI 兼容客户端填写 API 基址和界面中的访问 Key，再刷新模型列表。对外支持 `/v1/models`、`/v1/chat/completions`，包含 JSON、流式文本/思考和客户端 function tools。尚未实现 `/v1/responses`、图片、音频和 embeddings。

未配置访问 Key 时首次启动自动生成，可从本地界面查看/复制。`OPENCODE_PROXY_API_KEY` 或旧 `BRIDGE_API_KEY` 仅用于首次生成配置时的初始值；后续以保存的配置为准。这些是反代访问密钥，不是供应商凭证。

## 与 Magpie 一致的统计口径

直接复用/移植 Magpie 的 ledDecode、ledRowSpeed、flowMs 和统计样式；来源及 MIT 许可见 NOTICE.txt。

- 首字从当前请求开始，到客户端协议流里出现第一段有效文本、思考或工具调用。非流式没有首字/速度。
- 首字均值只计成功的流式请求。失败数包含取消，界面另列取消数。
- 思考回复的速度只算答案 Token，从首段正文开始；不把思考 Token 混入输出速度。
- 解码窗口不足 100 ms、超过 10000 Token/s、内容集中在窗口的不足四分之一、或正文比思考快超过 20 倍等异常/批量释放数据，不进入速度均值。平均速度为有效样本 Token 总量除以有效窗口总量，不是每条速度的简单平均。
- 普通输入、输出、缓存读取、缓存写入、思考分别记录；缓存读写与普通输入分开，输出含思考但速度排除思考。用量以 OpenCode 实际返回为准，缺失时不估算。
- 日统计按服务端本地时区分组，调用时间按查看页面的客户端时区显示。
- 同样的计算规则不表示与另一层网关测出的毫秒值逐字相等：当前工具的时钟从自身收到请求开始。

完整客户端请求体（含提示词、历史、工具定义和参数）、应用默认参数后的生效请求，以及原始响应都保存在本地。响应预览上限 2 MiB，完整字节保存在详情显示的文件中。最近保留 250 条明细及对应请求文件；累计统计持续保存。Authorization、访问 Key 和供应商认证头不写入请求日志。生效请求仍是客户端 Chat 协议的输入，不等于供应商最终 HTTP 请求字节。

## OpenCode 行为

不按版本白名单限制；所有推理必须经过真实 OpenCode，不修改其源码或二进制。支持与否由公开 API/hooks 决定。

- 默认不限并发，每个活动请求独占进程、会话和数据库。
- 默认复用健康空闲进程，保留最多两个，空闲 60 秒退出；旧会话删除并通过公开 /global/dispose 完成实例释放后才复用。
- 全局供应商、登录和认证插件继续由 OpenCode 管理。客户端系统提示与历史通过公开 hooks 替换默认代理提示；第三方认证插件仍加载，其参数、请求头和 fetch 逻辑可能运行。
- 本地内置工具禁止执行，function tools 由客户端执行。工具参数目前在完整 JSON 后返回，没有原始逐字符参数 delta。MCP 根 schema 的 additionalProperties 会受原生转换影响。
- 首输出默认 120 秒、输出空闲默认 180 秒、总时长默认不限。旧配置 timeoutMs:120000 仍限制总时长，需要改为 0 或删除。

## 开发构建

```sh
npm ci --ignore-scripts
npm ci --prefix frontend --ignore-scripts
npm run build:ui
npm test
npm run package:windows  # 需要 Go 和 Bun
npm run package:linux   # 需要 Bun
```

Windows 桌面使用 Wails 2 + Go + WebView2，界面为 Vue 3 + TypeScript + Vite + Naive UI。服务核心继续使用已有 JavaScript，通过 Bun 打包。只有 OpenCode 原生 worker 的脚本资源会作为文件交给 OpenCode 加载。

GitHub 默认构建 Windows 和 Linux 产物，执行快速测试、前端类型检查，并使用真实 OpenCode 1.18.35 与本地模拟供应商验证打包后的服务、别名/参数、工具流、完整日志与重启统计。手动 compatibility 才运行另外四组合完整测试。不会构建 Magpie，也不会在 CI 调用生产账号。
