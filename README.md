# OpenCode Proxy for Magpie

将本机全局 OpenCode 中已可用的模型注册为 Magpie 供应商。所有推理经过真实 OpenCode，保留其供应商配置、登录、认证插件及请求处理。

调用链：客户端 → Magpie 网关 → 本插件 → 真实 OpenCode → 供应商。

Magpie 负责客户端协议转换、访问 Key、路由、模型控制和统计；插件只接受内部 Chat Completions 请求，并将其桥接到 OpenCode。没有独立 HTTP 网关、桌面端、管理界面或配置文件。

## 安装

先确保同一运行用户能正常使用全局 OpenCode。Magpie 的插件宿主使用 Bun，本插件不安装或修改 OpenCode。

从本地仓库安装：

```sh
npm ci --ignore-scripts
magpie plugin add D:/projects/opencode-proxy
magpie plugin login opencode-proxy
```

也可以在 Magpie 的 Plugins 中添加该目录，再启用供应商 Local OpenCode。支持免密启用的 Magpie 会直接启用；旧版若显示 Key 输入框，填 `local`。这只是本机接入标记，供应商凭证始终由 OpenCode 管理。

发布 npm 包后可使用 `magpie plugin add @xshu-hub/opencode-proxy`；本次改造不会自动发布。

在 Magpie 中刷新供应商模型后选择 `opencode-proxy/<短模型名>`，例如 `opencode-proxy/deepseek-flash`。重名模型保留供应商前缀以消除歧义。插件只发布已连接的 OpenCode 供应商模型，不暴露凭证、上游地址或请求头；Magpie 自身及本插件的模型不回流到模型列表。

**仅安装在 Magpie 中。** 不要将本包加入 OpenCode 的 plugin 配置；OpenCode 内仍使用原有供应商认证插件。

## 可选配置

在 Magpie 中打开 **Plugins → Installed → Local OpenCode → Options**，编辑 JSON 后保存，再关闭并重新启用插件。首次使用本地目录插件或更新插件元数据后，可重启 Magpie 以刷新 Options 入口。

指定工作目录时，在现有 JSON 中加入 `workingDirectory`（目录必须已存在；Windows 路径建议使用正斜杠）：

```json
{
  "workingDirectory": "D:/projects/your-project"
}
```

配置通过 Magpie 插件的 Options 保存，无需另建 config.json。其余可选参数例如：

```json
{
  "command": ["opencode"],
  "workerReuse": true,
  "maxIdleWorkers": 2,
  "workerIdleMs": 60000,
  "startupTimeoutMs": 15000,
  "firstOutputTimeoutMs": 120000,
  "idleTimeoutMs": 180000,
  "timeoutMs": 0
}
```

`command` 是程序及可选启动参数数组；绝对路径适用于 Magpie 找不到 PATH 中 OpenCode 的情况。`workingDirectory` 可指定 OpenCode 使用的真实目录。`workerSharing: true` 可启用兼容 OpenCode 1 的共享进程模式，必须同时指定真实目录；默认关闭。

配置保存后重新启用插件以确保宿主载入新配置。默认推理并发不限，由 Magpie 的供应商设置控制接入并发。模型发现不发起推理，也不自动预热。健康进程在完成清理后复用，默认最多保留两个空闲进程，60 秒后回收。

## 行为与边界

- 仍通过 OpenCode 的公开会话 API 和 hooks 完成推理；这次改造删除外围产品层，不改变为供应商直连。
- 保留客户端系统提示、历史、函数工具、思考参数与内联附件的 OpenCode 桥接。函数工具由客户端执行，本地内置工具受限，不继续自动推理。
- 插件仅声明 Chat Completions，Responses、Messages 等客户端协议由 Magpie 转换；不会再次进行这些协议的转换，也不提供 Responses 存储接口。
- 模型与输入能力来自 OpenCode 的模型目录。供应商签名思考块、加密推理、远程文件和托管工具受 Magpie 转换、OpenCode SDK 及供应商能力限制。
- 原生工具名称和 ID 可先返回，参数要等 OpenCode 发布完整 JSON；插件无法补出逐字符参数增量。流式文本、usage、背压、取消和错误继续传递。
- 模型发现随 Magpie 刷新；失败时让 Magpie 保留其上次模型列表并显示失败。插件不采集持久化统计、不保存请求日志，也不提供账号余额或供应商价格数据。
- OpenCode 重试被中止时保留上游报错原因；免费用量或额度超限按 429 返回。模型出现在列表中并不代表当前账号仍有该模型的可用额度。
- Magpie 退出或重启插件宿主后，桥接工作进程会检测父进程退出并停止。正常释放时先取消推理、删除会话并确认清理，再归还进程。

## 开发与验证

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack
```

`npm run test:integration` 需要设置 `TEST_OPENCODE_COMMAND` 为真实 OpenCode 程序的 JSON 命令数组。测试使用临时用户配置及本地模拟供应商，不使用生产凭证。

`npm run test:magpie-host` 需要 `TEST_MAGPIE_HOST` 指向 Magpie 的 `internal/plugin/host.js`，且 Bun 可用；使用独立临时宿主配置验证插件加载和模型/请求契约。

桥接核心保留原 Magpie MIT 版权声明，见 LICENSE 和 NOTICE.txt。
