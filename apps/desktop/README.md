# 桌面端（Electron）

Aervox 桌面客户端，基于 Electron + Vue 3 渲染。支持“桌宠陪伴”和“标准工作台”两种交互模式。

架构决策见 [ADR-009](../../docs/reference/adr/ADR-009-electron-plugin-sandbox.md)、[ADR-015](../../docs/reference/adr/ADR-015-vue-full-stack.md)。

## 开发

从仓库根目录运行：

```bash
./aervox dev           # 启动 API + Web + 桌面端 + Worker
./aervox dev desktop   # 启动 API + 桌面端
```

## 目录结构

- `src/main/` — Electron 主进程
- `src/preload/` — 安全桥接与上下文隔离脚本
- `src/renderer/` — Vue 渲染进程，装配共享界面与桌面平台桥接
- `src/renderer/public/` — 静态资源（Live2D 模型等）

共享组件与主题由 `@aervox/ui` 提供，`@aervox/ui-host` 装配 `plugins/surfaces/*` 的根界面，客户端逻辑由 `@aervox/api-client` 提供。Web 与桌面端各自维护平台入口，并复用这些共享包。
