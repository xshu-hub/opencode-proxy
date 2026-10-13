# OpenCode Proxy

独立的 OpenCode 反代工具。客户端 → OpenCode Proxy → 真实全局 OpenCode → 上游供应商。

提供 OpenAI 兼容的 `/v1/models` 和 `/v1/chat/completions`，支持普通 JSON、SSE 流式文本与思考输出、客户端 function tools、工具结果续接和并发。自动发现已配置供应商的模型，默认显示纯模型名；同名冲突时保留供应商前缀。复用全局配置、登录和认证插件，推理与凭证刷新由 OpenCode 执行。不需要 Magpie。

## 启动

需要 Node.js 22+，并确保 PATH 中的 `opencode` 自己能够正常对话。

```powershell
git clone https://github.com/xshu-hub/opencode-proxy.git
cd opencode-proxy
npm ci --ignore-scripts --no-audit --no-fund
$env:OPENCODE_PROXY_API_KEY = '替换为你的客户端访问密钥'
npm start
```

这是本工具的访问密钥，不是供应商凭证。默认监听 `http://127.0.0.1:8787/v1`。Cherry Studio 或其他 OpenAI 兼容客户端使用该基址和同一个密钥，然后刷新模型列表。

没有 `config.json` 时自动使用全局 OpenCode，不需要填写供应商 URL 或上游 API Key。可通过命令行覆盖：

```powershell
node bin/serve.mjs --port 8787 --working-directory 'D:\workspace'
node bin/serve.mjs --opencode 'D:\OpenCode\opencode.exe'
node bin/serve.mjs --host 0.0.0.0 --port 8787
```

高级设置可将 `config.example.json` 复制为 `config.json`，或者使用 `--config 指定文件`。相对配置路径以配置文件目录为基准，命令行工作目录以启动目录为基准。未指定工作目录时使用请求的临时工作目录，仍读取全局供应商与认证配置；项目规则和项目配置默认关闭。

## 行为与限制

- 不限制 OpenCode 版本；兼容性取决于其公开 HTTP API 和 hooks。1.16.2、1.18.35 是测试版本，不是运行白名单。
- `maxConcurrent: 0` 默认不限并发。每个活动请求独占 OpenCode 进程、会话和数据库；成功后删除会话并等待该子进程的全局实例清理完成，才允许复用。默认保留最多两个空闲进程，空闲 60 秒退出。错误、取消、超时不复用。
- 启动时限默认 30 秒，首个有效模型输出时限 120 秒，输出空闲时限 180 秒，总时长默认不限。旧配置的显式 `timeoutMs: 120000` 仍生效；删除或改为 `0` 可关闭总时限。
- 文本、思考按原生事件增量输出。原生读取独立于客户端消费；事件缓冲上限 8 MiB，超出返回 `slow_consumer`，不无限积压。
- 客户端 system/developer 与历史通过公开 hooks 注入，OpenCode 默认代理提示、额外规则和 Skills 内容会被替换。全局认证插件仍加载，第三方插件的初始化、认证、请求头、参数或 fetch 逻辑仍可能运行；复杂有状态插件可关闭 `workerReuse`。
- 客户端执行 function tools，OpenCode 内置本地工具禁止执行。工具参数在完整 JSON 解析后返回，目前没有原始参数逐字符 delta；MCP 参数根对象的 `additionalProperties` 会受原生转换影响。
- `reasoning_effort` 按模型元数据和原生 provider/variant 映射；供应商没有对应能力时返回具体错误。不同供应商支持的参数不保证完全一致。
- 当前对外提供 Chat Completions，不实现 `/v1/responses`、图片、音频或 embeddings。已有隔离模式仅作为显式 `apiKeyEnv` 配置的可选路径，默认使用全局模式。
- 脱敏日志带请求 ID、阶段耗时、超时类型与进程复用情况，不记录提示词、工具参数或密钥。499 仍可能来自客户端主动取消或等待上限。

## 开发与构建

```powershell
npm test
npm pack --ignore-scripts
```

push 默认只运行快速测试并打包工具，产物为 `.tgz`。GitHub Actions 手动触发并选择 compatibility，才运行 Windows/Linux × OpenCode 1.16.2/1.18.35 的真实程序集成验证。测试使用临时配置与本地模拟供应商，不调用生产账户。不包含 Magpie 插件适配或宿主测试，也不构建 Magpie。当前交付为 Node 服务包，不是桌面 EXE。

本项目的反代核心从已有 0.13.0 桥接实现迁出，来源和许可证见 [NOTICE.txt](NOTICE.txt)。
