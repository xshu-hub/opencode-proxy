# 2026-10-19 协议契约、高级客户端工具与图片工具结果回归

代码基于 `0b2138f` 的本次工作树。范围仅为独立 OpenCode 代理。所有推理经过真实全局 OpenCode；真实测试读取已有提供方认证，自动化集成测试使用一次性配置和本地模拟上游。原始报告、DSH 文件索引和临时网关配置均在系统临时目录，不加入 Git。

## 兼容行为

- Responses 支持 namespace 内的 function/custom 工具，同名叶子工具可属于不同 namespace。内部别名可逆并检测冲突，JSON、SSE、显式和缓存历史保留原始身份；历史回放不要求重新声明旧工具。
- custom 工具支持自由文本，内部仅通过严格的 `{input:string}` 函数传输。客户端收到 `custom_tool_call` 和 `response.custom_tool_call_input.delta/done`，不会看到内部包装。指定工具、必选工具与串行约束继续生效。
- Responses function/custom 输出及 Anthropic tool_result 支持内联图片和文档。文本保留为工具结果，媒体在整批并行结果收齐后附加为带 call ID 的用户内容；逆序结果不会导致错配。无效附件和不支持的模型模态在推理前拒绝。
- 保留此前的 Anthropic 无签名思考展示、历史回放及关闭思考行为。仅输出 OpenCode 实际提供的思考文本，不保证模型每一回合都生成思考文本。
- 无法保留语义的自定义 grammar、tool_search、defer_loading:true 和托管工具仍返回明确错误。代理不会忽略语法约束，也不会在服务端执行客户端工具或代码。

协议字段依据 [OpenAI 工具调用文档](https://developers.openai.com/api/docs/guides/function-calling)、[namespace / tool search 文档](https://developers.openai.com/api/docs/guides/tools-tool-search) 和 [Anthropic 工具结果文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)。借鉴 sub2api 的兼容规则和回归场景，JavaScript 转换独立实现，无新增运行时依赖。

## 自动化契约

`npm test`：**114/114**。`npm run test:contracts`：**33/33**，覆盖三个协议的 HTTP/鉴权和响应契约，其中新增 8 项高级工具/媒体测试，包括：

- JSON 与按单字节切分的 UTF-8/CRLF SSE；事件序号、item/index、创建/增量/完成配对及终态。
- 交错并行工具、自定义输入中的 Unicode/换行/转义、同名 namespace、别名冲突和请求间隔离。
- 指定工具、无重新声明的历史回传、store=true 缓存续接及原始请求不可变。
- 畸形 custom 输出返回 502；失败流不发送成功终态；中断取消源流且不存储未完成调用。
- 逆序并行图片结果的归属、全部结果收齐、模态拒绝、损坏 base64 拒绝，以及 Anthropic is_error 文本表示。

真实 OpenCode + 本地模拟上游另验证高级工具与图片字节经过 OpenCode SDK 的完整往返，覆盖 JSON/SSE 和客户端工具续接。

完整 `npm run test:integration` 首轮 **46/47**，无跳过，约 387 秒。唯一失败为原有并发工作进程场景中 OpenCode 启动时报告 `panic(main thread): Stack overflow`，代理返回 503。首次选择性复跑又在执行并发请求前触发旧测试夹具的 ENOENT（观察文件依赖前序用例生成）；夹具补充空观察文件处理和一次性 OAuth 登录预热后，该场景隔离复测 **1/1 通过**：四路真实 OpenCode 推理重叠，取消一路，其余响应和进程/数据库保持隔离。没有放宽并发、响应或认证断言。本次未修改原生 OpenCode，也不将这次重跑表述为已修复其启动崩溃。

本地 Bun **1.4.0** 编译的 Windows 后端经 `managed20:` 验证通过，并单独复测了新增的 namespace/custom 流式调用、两路图片工具结果逆序续接，以及上游接收到的图片字节。此打包场景单独复测 **1/1 通过**。后端 SHA-256：`a8fab95a795971daeb9703c1aab3121df2119d693abd4ee599e514f480208275`。这是本地后端验证结果，不是 GitHub Actions 构建状态。

## 真实模型与客户端

Windows，全局 OpenCode **1.18.0**，DSH **0.2.1-alpha.5** 原生 DeepSeek Messages 适配器，官方 OpenAI SDK **7.19.0**。独立临时网关，默认无限并发，供应商请求均由 OpenCode 发出。

最终完整真实回归 **20/20**，随后 DSH 两模型单独复测 **2/2**：

| 验证项 | deepseek-flash | deepseek-v4-pro |
| --- | --- | --- |
| Chat / Responses / Messages 流式工具、结果续接、思考开关 | 三协议通过 | 三协议通过 |
| 三协议思考阶段中断，随后正常恢复 | 通过 | 通过 |
| Responses namespace / custom 原始输入与续接 | 通过 | 通过 |
| 官方 OpenAI SDK custom 流式重建 | 通过 | 通过 |
| DSH 思考流、工具执行后回传、无签名回放和关闭思考 | 通过 | 通过 |
| Responses / Messages 图片工具结果 | 实际图片颜色识别通过 | 声明为文本模型，明确 400 |
| DSH 图片工具结果 | 实际识图通过；网关接收字节 SHA-256 与原图一致 | 使用文本工具结果验证 |

OpenAI/Anthropic 格式的模型发现和短别名均通过。两模型 × 三协议共 6 路混合流式请求同时提交，返回内容分别匹配各自标记。该检查证明并发请求可用与结果隔离，不声称所有供应商生成任务在同一瞬间执行。

DSH 单独复测实际收到 Flash **171** 个思考增量（工具前 38、工具后 133），Pro **142** 个（工具前 87、工具后 55）。DSH 测试使用已安装的真实适配器及临时文件索引；这是客户端序列化、流式解析和历史回放路径验证，未覆盖交互式终端 UI。

初轮测试曾遇到模型把长随机标记拆行、把请求的换行生成成字面量转义，以及一次图片颜色回答不符。测试将恢复检查改为固定短回复，并将 SDK 契约检查改为比较实际 custom 输入与增量/最终结果；Unicode 和换行的精确保留仍由固定协议契约及真实 custom 往返验证。图片测试改用语义一致的 capture_image 工具，增加接收字节哈希检查；后续两轮 DSH 图片检查通过。这些观察不构成对任意模型回答正确率的保证。

## 重跑

```powershell
npm test
npm run test:contracts
$env:TEST_OPENCODE_COMMAND = '["C:/实际路径/opencode.exe"]'
npm run test:integration
$env:TEST_DSH_ROOT = 'C:/实际路径/node_modules/@deepseek-ai/dsh'
npm run test:live:advanced
# 只运行 DSH 场景：
$env:OPENCODE_PROXY_LIVE_FILTER = '^dsh/'
npm run test:live:advanced
```

真实回归会使用当前 OpenCode 账号产生模型调用费用，不在 CI 运行。可用 `OPENCODE_PROXY_LIVE_MODELS` 选择本次两个 DeepSeek 短别名；默认 deepseek-flash,deepseek-v4-pro。Windows 后端编译/打包验证需要设置 `TEST_PACKAGED_PROXY` 为相应可执行文件路径；完整兼容 CI 始终使用本地模拟上游和一次性认证。
