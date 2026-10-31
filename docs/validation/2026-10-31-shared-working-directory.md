# OpenCode 1 共享进程真实工作目录整改（2026-10-31）

本轮将共享模式从“每个请求一个临时目录实例”改为“真实工作目录实例、按 session 隔离请求、按工具契约分组”。
本机实际验证 OpenCode **1.18.0**，真实推理固定只使用 **deepseek-flash**，没有模拟供应商或代理直连供应商。
本机代理配置和全局供应商配置未写入；临时测试网关使用一次性访问 Key，认证由全局 OpenCode 管理。

## 实现边界

- 开启共享模式必须指定有效 `workingDirectory`。进程 cwd、内部目录路由和插件 directory 都使用其真实路径。
  历史的 cwd 使用实例目录，root 使用原生 worktree；不将私有请求目录作为工作区。
- `lib/shared-contract.mjs` 对客户端工具定义、有效 MCP schema 和权限生成稳定指纹。对象属性顺序不影响指纹，
  schema 数组顺序保留；提示词、历史和采样参数不进入指纹。不同契约使用不同进程，禁用工具可复用空工具组。
- 同组只创建一次 MCP 工具表；`lib/shared-sessions.mjs` 按 session 绑定私有请求文件及缓存。
  消息、系统提示、参数和工具 hook 校验归属；混合 session 历史、错误组及错误契约均拒绝。
- 请求完成/取消时只中止和删除所属 session，等待插件删除事件处理及身份匹配的释放确认，再删除私有请求状态。
  不逐请求销毁实例；组整体退出时才等待实例销毁并关闭进程。释放异常会退役该组，保留其他活动持有者直到完成。
- 私有状态全部写在项目外的临时根目录。项目配置、AGENTS、skills 及本地工具的现有禁用策略保持不变。
  不修改 OpenCode 源码、二进制或全局认证，不增加并发上限。

## 功能验证

最终 `npm test`：**160/160 通过**。`npm run build:ui`、变更脚本语法检查及 `git diff --check` 通过。

真实模型主回归覆盖三协议各三轮对话、连续两轮工具结果回传、中文/Emoji 增量流和结束事件、
Responses 历史存取、推理前重连、输出后断流、客户端取消、并发取消、不同工具契约分组、原生进程退出后重建、
四路并发协议隔离和首字路径。另补测清理失败和真实持续并发内存；合计覆盖 22 个不同场景。

| 关键整改验收 | 观察 |
| --- | --- |
| 真实目录 | 含中文和空格的独立工作目录中，进程、插件、hook 和原生 `/path` 的目录一致 |
| 相对路径 | 原生 `/file/content?path=relative.txt` 读回同目录测试标记，工作区未出现代理状态文件 |
| 清理 | 请求结束后组引用数为 0，私有 requests 目录为空，无清理失败退役 |
| 工具定义 | 三个并发请求声明同名但不同 schema，实际使用 3 个原生进程；禁用工具后的答复复用空工具组 |
| 取消 | 取消瞬间另一原生推理仍活动，随后正常完成，共享进程不退出 |
| 清理失败 | 中断本测试 session 的删除操作；当时其他原生推理仍活动，旧组退役，新进程接收新请求，旧请求正常完成后旧组退出 |
| 断流 | 输出中途关闭真实原生事件连接，明确报错且不重放；后续请求恢复，代理文本与原生助手事件逐字一致 |
| 进程退出 | 结束本测试持有的原生进程，当前请求报错；新 PID 启动后可续接退出前保存的 Responses 历史 |

初轮主回归 20 项中 19 项通过，另一次恢复答复的精确标签不符。该次没有原生文本对照，不能回溯归因。
随后加入原生事件对照，定向验证 3/3 通过，再独立重复两次各 2/2 通过，恢复文本均与原生一致且标签正确。
没有为这一偏差改写产品输出或放宽文本断言。

原始报告均在系统临时目录，未进入 Git：

- `opencode-proxy-shared-live-1DLJlG/report.json`：主回归及首字样本，19/20。
- `opencode-proxy-shared-live-p2ZExd/report.json`：目录及原生事件对照，3/3。
- `opencode-proxy-shared-live-oA4foE/report.json`、`opencode-proxy-shared-live-uN41V2/report.json`：独立重复的原生对照，各 2/2。
- `opencode-proxy-shared-live-s966lr/report.json`：清理失败验证通过；其中内存采样因请求提前结束而无效。
- `opencode-proxy-shared-live-3ZXOCE/report.json`：最终有效内存比较，2/2。

## 真实模型持续并发内存

两组顺序执行，每组 **4 路实际原生推理**。先完成无推理预热，再同步提交请求，等待全部产生真实文本。
每次采样前后均检查所有原生推理仍活动，连续取 3 次；下表为各指标在这 3 次中的最大值。
不将请求完成后的客户端缓冲当作活动推理，不将冷启动峰值混入持续阶段。

| 指标 | 独立进程 | 共享进程 |
| --- | ---: | ---: |
| 原生进程数 | 4 | 1 |
| 私有驻留内存 | 2228.16 MiB | 674.23 MiB |
| 工作集合计 | 2516.32 MiB | 722.22 MiB |
| 私有提交合计 | 3383.74 MiB | 1006.98 MiB |

本次私有驻留下降 **69.7%**。仅统计该比较实例拥有的原生 OpenCode PID，PID 由运行中的插件回传；
不包含 Node 网关、采样器或主测试网关的预热进程。不同工具契约可能需要更多进程，不能推广为任意生产负载的固定比例。

当前机器 WMI 性能接口超时，因此最终两组均使用只读 PSAPI 采样。通过
[QueryWorkingSet](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-queryworkingset) 返回的页元数据，
累加 [Shared 位为 0](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-psapi_working_set_block) 的常规驻留页；
工作集及私有提交读取 `GetProcessMemoryInfo`。未读取进程页面内容或修改系统设置。
私有提交不等同于物理内存，工作集合计可能重复计算共享页；不采用失败或不支持的计数器返回的零值。

复测方式，全部真实推理仍只使用 deepseek-flash：

```powershell
$env:OPENCODE_PROXY_MEMORY_METHOD='psapi'
$env:OPENCODE_PROXY_LIVE_MEMORY_CONCURRENCY='4'
$env:OPENCODE_PROXY_LIVE_FILTER='real-sustained-memory-comparison'
npm run test:live:shared
```

清空过滤条件后运行 `npm run test:live:shared` 可执行全部功能场景；未设置内存并发参数时不执行额外内存负载。

## 首字样本

共享空工具组的新进程首字为 **6393 ms**，准备阶段 **3372 ms**；预热后的首请求及复用请求，
准备阶段为 **46–67 ms**，客户端首字为 **720–3532 ms**。原生模型等待时间存在波动。
这些是少量实测样本，不承诺固定的加速比例；新的工具契约首次出现时仍需初始化其进程组。

尚未覆盖小时级稳定性、真实供应商宕机/限额和任意第三方插件的跨 session 全局可变状态。
进程崩溃仍可能同时影响同组活动请求。工具由测试客户端执行并回传结果，没有外部工具副作用。
