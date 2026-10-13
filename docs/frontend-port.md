# Magpie 前端精简版（0.6.0）

旧版 `frontend/src/app.js` 自制界面已删除。当前以 Magpie `210234a5f33e0f2643f82b4337e249cf0fe81371` 的完整前端源码为底稿，不再仅复制 CSS 和几个控件。

保留的真实渲染器：`renderProviders`、`renderModels`、`renderGatewayView`、`renderGatewayModels`、`renderConnect`、`renderActivity`、`renderGatewayKeys`、`renderUsage`、`renderLedger`、统计图表、原模态框和搜索菜单。供应商编辑器裁去供应商 HTTP 地址/凭证/路由等区域，沿用模型芯片、批量选择、名称与推理档位及保存栏，增加 OpenCode 参数。设置保留原分区标签、行布局及选择控件，内容适配独立工具。

裁掉 Agent 配置写入、会话扫描、资源库、插件市场、路由组、Magpie 升级、WebDAV 与登录功能。全局 OpenCode 仍负责供应商和认证；不会复制认证文件。为了保留原脚本初始化，少数不可见的 DOM 容器和未调用的函数定义仍在底稿中；相关模块脚本不再加载，页面和入口已移除。

`frontend/public/proxy-adapter.js` 将独立后端 DTO 转换为原前端需要的数据。所有模型保存经过 `/admin/models/batch` 原子校验与持久化。任何一项无效，整批不保存；活动推理继续使用旧工作进程。

访问 Key 在本机和局域网请求中都必须提供。原 Magpie 的“本机任意 Key”入口已经删除。保留创建、自定义值、重命名、启停、复制、轮换和移除；未实现的 Key 预算和模型范围按钮不展示。

统计页保留原 Magpie 计算和图表。概览使用持久化累计总量/日总量，全时期模型明细使用累计模型统计。请求页、筛选、趋势和 CSV 使用明确标注的最近 250 条明细，不冒充全部历史。当前期间内模型/Key 分组、费用及订阅剩余额度仍未具备完整数据。`docs/magpie-parity.md` 为 0.5.0 的历史审查，应以本文件的现状说明为准。

导入与构建：

```sh
node scripts/vendor-magpie.mjs ../magpie
npm run build:ui
```

只复制前端源码、应用可核验的替换并构建独立工具。不会构建 Magpie。Web UI 和 Windows EXE 使用同一套资源。源文件 SHA-256 与许可证记录在 `frontend/public/SOURCE.json` 和 `NOTICE.txt`。
