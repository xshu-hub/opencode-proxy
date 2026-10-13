# Magpie 前端精简版（0.7.0）

前端同步至 Magpie `a75de4c21ac28be98af8334643077d8b0bf47df7`，直接使用其 HTML、CSS、JavaScript、侧边栏、模型编辑器、连接示例、Key 管理和菜单源码。通过 `scripts/vendor-magpie.mjs` 中的校验替换与 `proxy-adapter.js` 适配独立 OpenCode 后端。

仅保留“模型”和“网关”两个主页面。设置入口保留工作目录、OpenCode 程序、超时、监听地址/端口、外观与托盘运行。模型页沿用模型芯片、搜索、全选、名称与推理档位、测试、取消及保存交互，补充默认参数、原生/自定义思考档位。保存通过 `/admin/models/batch` 原子校验；无效配置不会部分保存，活动请求继续使用旧配置。

网关页保留启动/停止/重启、三种协议连接示例、模型列表、访问 Key 的创建/自定义值/重命名/启停/复制/轮换/移除。每个 API 请求必须提供启用的 Key。未实现的预算与按 Key 限制模型按钮不展示。

已移除统计页、最近调用、详情 API、统计模块和请求存储模块。新请求不再写 statistics.json 或 requests 目录，也不复制完整请求/响应到日志；已有记录文件不删除、不加载。客户端响应中的真实 usage 仍正常转发。原 Magpie 单文件脚本中部分未调用的函数和初始化锚点仍保留，初始化后裁掉无关 DOM；没有运行其统计后端、插件、Agent 扫描或供应商代理。后续源码瘦身应与现有交互回归分开验收。

Windows 为 Wails 2 + Go + 系统 WebView2，无 Electron；Linux 为独立服务和相同浏览器管理界面。关闭 Windows 窗口隐藏到托盘；退出才停止服务。只构建本工具。

```sh
node scripts/vendor-magpie.mjs ../magpie-front-latest
npm run build:ui
npm test
```

参考目录必须是对应 commit 的 internal/gui/assets。来源和 SHA-256 记录在 `frontend/public/SOURCE.json`，保留 MIT 版权。升级上游时替换不匹配会终止导入，须核对生成脚本。
