# 并发内存分析与工作进程回收优化（2026-10-28）

本页记录第一轮独立进程优化，发生在上游渠道功能退役之前。其后的共享实例实现、
持续并发内存下降和当前产品边界见[本机 OpenCode 1 共享进程](../shared-processes.md)。

分析和测量使用本机真实全局 **OpenCode 1.18.0**，对应官方标签 `v1.18.0`、
提交 `32696c425fc0fa1ec285389346cfa1fbe22b670a`。未使用 OpenCode 2.0 的实现推断
1.x 行为，未修改全局 OpenCode 程序、供应商配置或认证文件。

## 源码结论

- [serve.ts](https://github.com/anomalyco/opencode/blob/32696c425fc0fa1ec285389346cfa1fbe22b670a/packages/opencode/src/cli/cmd/serve.ts)
  启动 headless 服务；
  [服务依赖图](https://github.com/anomalyco/opencode/blob/32696c425fc0fa1ec285389346cfa1fbe22b670a/packages/opencode/src/server/routes/instance/httpapi/server.ts)
  仍包含配置、认证、Provider、会话、工具、MCP、LSP、存储等服务，并非只加载一次 HTTP 推理转发。
- [Provider 初始化](https://github.com/anomalyco/opencode/blob/32696c425fc0fa1ec285389346cfa1fbe22b670a/packages/opencode/src/provider/provider.ts#L1336)
  先将模型目录转换为内部目录及公开模型数据，再处理供应商启停配置。仅限制可用供应商
  不能直接省掉前面全部目录转换，不能据此承诺显著降低内存。
- [实例初始化](https://github.com/anomalyco/opencode/blob/32696c425fc0fa1ec285389346cfa1fbe22b670a/packages/opencode/src/project/bootstrap.ts)
  初始化配置、插件及实例服务。代理保留全局认证插件，每个活动请求独占进程、会话和数据库，
  所以上述运行时和服务状态随活动进程数量重复存在。
- [内嵌管理页面](https://github.com/anomalyco/opencode/blob/32696c425fc0fa1ec285389346cfa1fbe22b670a/packages/opencode/src/server/shared/ui.ts)
  按需加载；API 请求未访问页面时，不能将页面资源归因为已证实的内存主因。
- [数据库配置](https://github.com/anomalyco/opencode/blob/32696c425fc0fa1ec285389346cfa1fbe22b670a/packages/core/src/database/database.ts)
  声明 `cache_size = -64000`，这是缓存预算，不能当作每进程已预分配 64 MB 的证据。

这些源码解释了重复加载和状态持有的路径，未做堆快照归因，不能量化每个子模块的内存占比，
也不能将并发内存增长直接判定为泄漏。

## 实施的修改

1. 冷启动排队结束后，再检查同模型、配置和凭证对应的健康空闲进程。此前排队的请求
   即使等到了已清理的可复用进程，也会启动新进程。
2. 在会话删除和实例重置之前预留空闲池名额。重置中的进程和健康空闲进程共用
   `maxIdleWorkers` 预算；超额完成的进程直接关闭，不先做注定无用的完整重置。
3. 移除独立进程回收之间的串行等待。正在退出的进程仍由池持有，关闭时等待全部回收，
   避免丢失清理责任。正在退出的进程不计入热模型的可用覆盖。

默认 `maxConcurrent=0`、活动请求独占进程和按凭证隔离的复用条件保持原有语义。
复用进程仍需完成中止确认、会话删除和实例重置，不能把正在重置的进程交给其他请求。

## 本地测量

Windows、Node.js 22.23.2、OpenCode 1.18.0、插件依赖 1.18.35。使用一次性全局配置、
测试认证插件和本地模拟上游；不调用真实供应商。每组 8 个同模型请求，空闲池上限 2。
一组立即完成，另一组保持全部 8 个实际上游请求同时活动后再统一结束。

PowerShell 按约 200 ms 的目标间隔采集本次启动的 OpenCode PID；实际间隔还包含查询耗时。
工作集为各进程 `WorkingSet64` 的和，可能重复计算共享页，并非机器独占物理内存。
私有提交为 `PrivateMemorySize64` 的和，并非驻留物理内存。
CPU 时间为采样期间各 PID 已观察到的累计 CPU 时间，不是完整进程审计或 CPU 百分比。

| 场景及指标 | 修改前 | 仅调度/回收修改后 |
| --- | ---: | ---: |
| 短请求启动进程数 | 8 | 5 |
| 短请求复用次数 | 0 | 3 |
| 短请求工作集合计采样峰值 | 1910 MiB | 2197 MiB |
| 短请求私有提交合计采样峰值 | 2986 MiB | 3460 MiB |
| 短请求全部终止事件耗时 | 17.87 s | 12.25 s |
| 短请求采样 CPU 时间 | 39.03 s | 28.58 s |
| 持续请求启动进程数 | 8 | 8 |
| 持续请求结束后重置次数 | 8 | 2 |
| 持续请求工作集合计采样峰值 | 3428 MiB | 3434 MiB |
| 持续请求私有提交合计采样峰值 | 5378 MiB | 5312 MiB |

结果表明减少了无效启动及超额重置，**没有证明持续并发内存峰值下降**。
短请求瞬时重叠受调度、清理速度、系统负载及采样影响，不能用进程启动总数推导峰值内存；
本次修改后短请求采样峰值反而更高。此表为单次比较，不是跨机器或生产收益承诺。

## 未采用的运行时实验

- `BUN_OPTIONS=--smol`：本机 OpenCode 1 二进制上的测量未显示持续并发内存改善，
  不将新版 Bun 文档描述直接当作此二进制已生效的依据。
- 在公开插件的参数 hook 调用 `Bun.gc(true)`：独立复测工作集合计峰值仍为 3428 MiB，
  未采用。一次与其他真实集成测试重叠的实验发生 Node 原生内存不足，已排除该次比较；
  此后实验顺序运行。
- `BUN_JSC_forceRAMSize=268435456`：持续场景工作集合计采样峰值 3122 MiB，
  相对原始基线下降约 9%；采样 CPU 时间由 40.64 s 增至 86.78 s。
  [Bun 维护者说明](https://github.com/oven-sh/bun/issues/6548#issuecomment-2254940542)
  此参数改变 GC 对可用内存的认知和回收频率，**不是硬内存上限**。收益及代价不适合作为默认设置，未写入产品或用户环境。

## 验证与适用边界

- `npm test`：178 通过；新增重置预算、非串行回收、关闭等待及失败释放预算验证。
- 真实 OpenCode 定向集成：`^resources:|^hotpath:|^reuse13:`，10 通过。
  覆盖排队期间归还进程的复用、4 路同时推理、只重置可保留进程、历史隔离、热池、
  三种协议结束事件、重置等待、工具替换、取消、首输出/空闲超时和数据库清理。
- 真实 OpenCode 渠道及并发取消回归：`^channels:|^global workers share`，4 通过；
  覆盖同工作目录的并发取消隔离、渠道轮转与绑定、全局认证保持、故障恢复和三种上游 SDK。
- 变更模块语法检查和 `git diff --check`：通过。

未运行真实供应商负载或打包产物验证。保持每个活动请求独占进程时，持续并发内存仍随
实际活动数增长。已有 `maxConcurrent` 可显式限制同时推理数，超限返回 429；本轮未修改
用户设置。若要在相同持续并发下大幅降内存，需要另行设计共享 OpenCode 服务的会话、
插件、MCP、工具权限、配置更新和取消隔离，不能仅删除当前独占进程的约束。
