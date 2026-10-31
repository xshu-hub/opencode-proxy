# 本机 OpenCode 1 共享进程

可选的低内存并发模式使用真实全局 OpenCode 1，通过其公开 API 和插件 hooks 在真实工作目录中
共享实例，并按 session 隔离请求。没有修改 OpenCode 源码、二进制、全局供应商配置或认证文件，也没有代理直连供应商的推理路径。

## 开启与作用范围

在“网络与超时”勾选“低内存并发：共享本机 OpenCode 1 进程”，或在网关配置中设置
`"workerSharing": true`。必须先配置有效的 `workingDirectory`；不会回退到临时工作区。
旧配置若开启共享但未指定目录，需要补上真实目录才能启动。默认关闭；未开启时继续使用独立进程模式。
配置保存以新代际接收后续请求，已执行的旧请求继续完成。

- 同一桥接配置代际中，相同模型定义、OpenCode 程序、真实工作目录、环境和工具契约使用一个共享进程。
  契约包含完整的客户端工具定义、有效 MCP schema 和权限；同名不同 schema 的工具分属不同进程。
  `tool_choice=none` 时未启用的客户端工具不影响空工具组复用。不同模型或不同代际也使用不同进程。
  短模型名和原有别名仍有效。
- 默认 `maxConcurrent=0`，不限制实际推理并发。共享模式没有用串行推理或限流换取测量收益。
- `workerReuse` 控制全部请求结束后的空闲保留；`maxIdleWorkers` 控制空闲进程组数量。
  活动组不占用这个空闲额度。热模型保护和普通空闲回收仍生效。
- 共享模式校验 OpenCode 主版本为 1，并要求生命周期事件流握手成功。目前实际验证版本为
  **1.18.0**，不据此承诺所有 1.x 版本兼容，也不采用 OpenCode 2 的实现作为依据。

## 隔离方式

| 对象 | 请求边界 |
| --- | --- |
| 目录与实例 | 进程 cwd、内部 `x-opencode-directory`、插件 directory 统一使用真实工作目录；同组共用实例 |
| 会话 | 每个请求新建原生 session；私有绑定文件含 session、请求和组身份；插件按 session 保存注入、参数及等待状态 |
| 工具 | 每组 MCP 地址、随机令牌、工具定义与权限固定；不同契约进入不同组，工具 hook 再校验所属 session |
| 历史与输出 | 请求文件及系统提示独立，按 session 过滤事件；历史 cwd 使用真实目录、root 使用原生 worktree |
| 认证 | 供应商、API Key、OAuth 及其认证插件全部由本机全局 OpenCode 管理；网关访问 Key 仅鉴权客户端 |
| 取消与超时 | 只中止所属 session，再删除会话并销毁所属实例；不会因一个客户端取消而关闭整个共享进程 |
| 配置更新 | 新请求进入新桥接代际；旧进程和旧请求保留到完成，不在活动进程内替换配置 |

本地内置工具仍禁止执行，函数工具仍由客户端执行。第二次模型续步会被所属 session 的 hook 阻止，
不会把客户端工具的延迟执行确认当作新模型输入。删除所属 session 时仅释放它自己的等待。

请求完成后不调用 `/global/dispose` 或 `/instance/dispose`。只中止、删除所属 session，等待插件处理
`session.deleted`、清除缓存并写回匹配 session/请求/组身份的释放确认，再移除项目外的私有请求目录。
工具契约和请求文件保存在进程的临时根目录中，用户工作目录不写入代理状态。

正常回收整个组时才调用 `/instance/dispose`，通过 `/global/event` 确认该目录销毁后关闭进程。
生命周期连接断开或实例被意外销毁时，该组退出可分配集合。

如果会话中止、删除或插件释放无法确认，该进程退出可分配集合。其他已执行的请求继续运行，
新请求启动另一个干净进程；旧进程在最后一个持有者退出后关闭。不会把可疑实例重新交给其他请求。

## 与独立进程模式的区别

共享模式提供应用层实例和会话隔离。一个进程内的数据库、运行时和故障域是共享的，
不再宣称每个请求拥有不同数据库文件。OpenCode 进程崩溃可能同时使同组请求失败；
已输出请求不会自动重放。

配置的 `workingDirectory` 同时作为进程、API 实例和插件的真实目录，相对文件路径在该目录解析。
项目 `opencode.json`、AGENTS、skills 和本地工具的加载策略与目录身份是两回事，本次保持原有禁用策略，
不让项目配置覆盖全局认证或客户端的模型、提示词和工具约定。
默认全局认证插件保留；任意第三方插件若自行使用跨 session 可变状态，代理无法强制替它隔离，必要时使用独立进程模式。

预热与空闲保留按进程组管理。模型初始预热准备空工具组；首次出现新的工具契约仍有初始化开销。
活动组不受空闲数量限制，未以串行执行或降低并发换取内存收益。

## 源码依据

以下文件均固定到官方 **v1.18.0** 的提交 `32696c425fc0fa1ec285389346cfa1fbe22b670a`：

- [实例路由中间件](https://github.com/anomalyco/opencode/blob/32696c425fc0fa1ec285389346cfa1fbe22b670a/packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts)
  将请求路由目录交给实例存储，再提供该实例的上下文。
- [实例存储](https://github.com/anomalyco/opencode/blob/32696c425fc0fa1ec285389346cfa1fbe22b670a/packages/opencode/src/project/instance-store.ts)
  按目录缓存实例，并在实例 disposer 完成后发出对应目录的销毁事件。
- [插件实现](https://github.com/anomalyco/opencode/blob/32696c425fc0fa1ec285389346cfa1fbe22b670a/packages/opencode/src/plugin/index.ts)
  和 [MCP 实现](https://github.com/anomalyco/opencode/blob/32696c425fc0fa1ec285389346cfa1fbe22b670a/packages/opencode/src/mcp/index.ts)
  使用实例状态保存 hook、连接和工具定义。
- [实例销毁生命周期](https://github.com/anomalyco/opencode/blob/32696c425fc0fa1ec285389346cfa1fbe22b670a/packages/opencode/src/server/routes/instance/httpapi/lifecycle.ts)
  区分 endpoint 应答与后续销毁操作，因此代理等待实际销毁事件。

## 初版内存对比（2026-10-28，历史记录）

以下数字来自初版临时实例设计，不能作为真实目录整改后的测量结果。
整改后的真实模型验证和内存测量见 [2026-10-31 验证记录](validation/2026-10-31-shared-working-directory.md)。
Windows、Node.js 22.23.2、全局 OpenCode 1.18.0、插件依赖 1.18.35。
每组 8 个同模型请求，通过一次性全局配置、测试认证插件及本地模拟供应商运行。
测试等待全部 8 个实际上游调用同时活动，保持其未完成，再连续采样 3 次；两组顺序执行。

下表取各指标在这 3 次**持续活动阶段**采样中的最大值，不是整个冷启动过程的峰值。

| 指标 | 独立进程 | 共享进程 | 下降 |
| --- | ---: | ---: | ---: |
| OpenCode 进程数 | 8 | 1 | 87.5% |
| 私有驻留内存合计 | 2962 MiB | 844 MiB | 71.5% |
| 工作集合计 | 3347 MiB | 892 MiB | 73.3% |
| 私有提交合计 | 5279 MiB | 1150 MiB | 78.2% |

使用 `Win32_PerfFormattedData_PerfProc_Process` 按本次启动的进程 ID 采样。
私有驻留对应 `WorkingSetPrivate`；工作集可能重复计算共享页；私有提交对应 `PrivateBytes`，
不能等同于物理内存。此结果证明该本地负载下的明显下降，不代表真实供应商长历史、大附件或生产压力测试。

可复测命令，`TEST_OPENCODE_COMMAND` 应指向本机真实 OpenCode 1，报告放在仓库外：

```powershell
$env:TEST_OPENCODE_COMMAND='["C:/path/to/opencode.exe"]'
$env:OPENCODE_PROXY_MEMORY_REPORT=Join-Path $env:TEMP 'opencode-shared-memory.json'
node --test --test-name-pattern='^shared: sustained memory' test/global.test.mjs
```

可用 `OPENCODE_PROXY_MEMORY_CONCURRENCY` 修改本地比较规模，允许 2–16，默认 8。
Windows 采集私有驻留/工作集/私有提交；Linux 通过 `/proc/<pid>/smaps_rollup` 采集驻留和私有驻留。
无报告路径时跳过这项资源测试，常规集成测试继续检查功能隔离。

## 初版已执行验证（2026-10-28，历史记录）

- `npm test`：158 通过，0 失败；覆盖进程启动去重、启动等待取消、清理失败退役、
  外来 session/本地工具拒绝、销毁确认、旧配置备份及退役接口。
- `npm run test:integration`：57 通过，0 失败，2 跳过；使用真实全局 OpenCode 1.18.0
  和一次性配置。覆盖原有独立进程模式及共享模式的会话、同名不同 schema 工具、
  工具结果历史、取消、认证、实例清理失败、三种客户端协议和配置代际切换。
- 内存比较用例另行启用并通过，结果见上表。
- `npm run build:ui`：通过。使用本机 Bun 1.4.0 编译 Windows 服务端，并复制当前插件资源后，
  运行 `^shared:|^managed20:` 定向集成：8 通过，0 失败，1 跳过（内存报告路径未设置）。
  其中共享模式打包验证确认三个协议同时推理时只有一个原生 OpenCode 进程，
  原有打包管理、模型及协议回归也通过。
- 变更模块语法检查和 `git diff --check`：通过。

上述自动化集成和内存测量使用本地模拟供应商，无生产凭证或付费模型调用。
另已使用当前全局配置的真实 `deepseek-flash` 验证多轮对话、连续工具结果、流式输出、
同名工具并发隔离、取消、断流及进程退出后的恢复：主回归 16/16、补充回归 4/4。
首字耗时、提示修正和故障边界见[共享模式真实模型验证](validation/2026-10-28-shared-live.md)。
未构建或验证 Windows Wails 桌面 EXE，也未在 Linux 本地运行；CI 已选择共享用例，
此处不将工作流配置当作 CI 已通过的证据。

## 上游渠道退役

代理已移除上游渠道配置、代理保存的供应商 Key、轮转、粘性绑定、故障换 Key、管理接口和页面。
只使用本机全局 OpenCode 的供应商及认证。原有网关访问 Key 和 Responses 按客户端隔离的
`store=true` 内存历史保留，其作用与供应商认证无关。

读取旧配置时忽略并移除 `channels` 字段。旧值非空时，先将原文件原样备份为同目录下的
`<配置文件>.before-local-only.<随机ID>.json`，然后保存本机模式配置；空数组不产生备份。
备份不进入管理接口或日志，已加入 Git 忽略规则。新配置不再接受 `channels` 字段。
这段迁移只会在应用读取指定配置时执行，本轮验证仅使用临时测试配置。
