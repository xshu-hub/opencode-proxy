# 2026-10-17 OpenCode 代理兼容与压力回归

本次变更基于 5227fef，范围仅为独立 OpenCode 代理。推理始终经过真实全局 OpenCode，没有修改 OpenCode、供应商服务、全局提供方或认证配置。新增的会话状态仅存在于进程内存，不产生请求日志。

## 已修复

- Responses 显式 store=true 的内存会话续接、查询、删除；按访问 Key ID 隔离，并限制 TTL、条数和字节数。默认仍为 store=false；instructions 不从上一请求继承。
- Chat/Responses/Anthropic 的 JSON Schema 输出及严格函数参数验证，指定/必选工具和串行工具约束。模型未满足约束时返回错误，不把无效数据当作成功结果。
- 思考开启与强制工具的兼容：实测 DeepSeek 拒绝 thinking + tool_choice=required。代理在这种情况下使用作用域内的 MCP JSON 捕获工具并验证输出，保留思考参数；不关闭思考、不执行客户端函数。明确关闭思考时仍可使用 OpenCode 原生结构化输出格式。
- 内联图片、PDF、UTF-8 文本、WAV/MP3 输入映射；非文本模态必须由模型声明支持。拒绝远程 URL、本地路径、文件 ID 和未支持的模态。
- 保留上游公开的 HTTP 错误状态和 Retry-After。首输出前允许有限次 OpenCode 原生重试；输出后的断流/重试以错误结束，避免重复内容与重复工具调用。
- Windows 高并发冷启动拥塞：只同时初始化两个冷工作进程，其余请求在可取消的启动阶段等待。默认请求并发仍不限，不限制已经完成初始化的推理并发。
- 浏览器对 Responses DELETE 的 CORS 预检。

## 真实供应商验证

环境：Windows、本地编译的 Windows 网关程序、Bun 1.4.0、全局 OpenCode 1.18.0。使用当前配置中的 deepseek/deepseek-flash 和 deepseek/deepseek-v4-pro；生产服务端口和原代理配置保持不变。

扩展检查合计 **28 项通过，0 项失败**。以下每种协议均覆盖两个模型：

| 场景 | Chat Completions | Responses | Anthropic Messages |
| --- | --- | --- | --- |
| 思考开启 + 严格 JSON Schema + 流式输出 | 通过 | 通过 | 通过 |
| 指定严格函数 + 串行约束 + 客户端结果回传 | 通过 | 通过 | 通过 |
| 100 轮历史 + 后续真实对话 | 通过 | 通过 | 通过 |
| 两个真实并行函数调用 + 逆序结果回传 | 通过 | 通过 | 通过 |

长历史由 100 对历史消息及最终问题组成，测试首部、中部、尾部三个随机暗号，并继续下一轮回忆。OpenCode 实际报告的首请求输入为 **24,314–24,494 Token**，不是按字符串长度估算。

Responses 另验证两模型的 store=true、previous_response_id、GET 和 DELETE，包含续接请求省略 model 的情况。

压力验证：

- 默认 maxConcurrent=0：**12 路重叠的混合协议请求全部成功**，随机标记逐一匹配。冷启动阶段排队，包含排队和模型发现的整体测试约 31.6 秒；这不是 12 个供应商生成任务同时运行的证明。
- 临时配置 maxConcurrent=8：同时发出 **64 路请求，8 路成功、56 路按预期返回 429**；恢复原 maxConcurrent=0 后，新的真实调用成功。
- 首轮未节流的 12 路冷启动曾出现 OpenCode 启动退出和辅助 PowerShell CLR 初始化失败。加入启动节流并移除压测中的反复 CLR 监测后，上述压力验证通过。失败记录保留在仓库外的原始测试目录。

## 可控故障与协议验证

最终自动验证：npm test **85/85**；完整 npm run test:integration
**44/44（无跳过）**，其中包含 Windows 打包程序经真实 OpenCode 的验证。
最终二进制另经 OpenAI SDK 7.36.0 和 Anthropic SDK 0.135.0 完成
**8/8** 冒烟检查：模型发现、含 email/date 格式约束的严格输出、
Responses 会话查询/续接/删除、思考开启时的指定工具、Anthropic 流式
结构化输出，以及浏览器 DELETE 预检。

故障测试使用真实全局 OpenCode 程序、一次性提供方/认证配置和本地模拟供应商，不使用生产凭证，不切断用户机器网络：

- 连续两次 HTTP 429 后第三次恢复；三种客户端协议各验证 JSON 和 SSE。
- 持续限流在有限重试后返回 429，并保留 Retry-After，不无限等待。
- 连接中断后的下一请求可以恢复。
- 部分文本输出后断流，不重放请求、不返回成功结束事件；下一请求成功。
- 三种协议的内联图片实际经过 OpenCode SDK 转成供应商请求；文本模型在推理前拒绝图片。这里验证的是协议与 SDK 转发，不宣称两个 DeepSeek 模型具备视觉能力。
- 会话缓存的鉴权隔离、删除、过期、容量淘汰、快照不可变性，以及严格模式无效输出的拒绝均有自动测试。

## 重跑

自动测试：

```powershell
npm ci --ignore-scripts
npm test
$env:TEST_OPENCODE_COMMAND = '["C:/实际路径/opencode.exe"]'
npm run test:integration
```

TEST_PACKAGED_PROXY 可指向本地编译的 Windows 网关，启用打包程序测试；CI 使用一次性配置和本地模拟供应商。

真实回归连接独立测试网关：

```powershell
$env:OPENCODE_PROXY_LIVE_URL = 'http://127.0.0.1:8787/v1'
$env:OPENCODE_PROXY_LIVE_KEY = '<测试网关访问 Key>'
$env:OPENCODE_PROXY_LIVE_MODELS = 'deepseek-flash,deepseek-v4-pro'
$env:OPENCODE_PROXY_LIVE_CONCURRENCY = '12'
npm run test:live
```

报告默认生成在系统临时目录，可用 OPENCODE_PROXY_LIVE_REPORT_DIR 指定仓库外目录。只重跑压力场景使用 npm run test:live -- --pressure-only。

64 路并发上限场景还需要 OPENCODE_PROXY_LIVE_ADMIN_URL 和 OPENCODE_PROXY_LIVE_ADMIN_KEY；它只应连接独立测试实例，会在 finally 中恢复该实例的原设置。测试脚本不会修改全局 OpenCode 配置。

## 仍保留的边界

- DeepSeek 当前 SDK 的 effort 档位无法精确保留固定 budget_tokens，继续明确拒绝数字预算。
- 无法生成 Anthropic 可验证的签名思考块，也不能恢复供应商不透明的加密推理状态。
- OpenCode 没有不触发推理的精确 Token 计数端点，count_tokens 继续返回 501。
- 工具参数在完整 JSON 就绪后返回，不承诺逐 Token 的参数增量。
- 不支持远程附件取回、文件 ID、内置服务端工具、后台任务、自动历史裁剪或 embeddings。
