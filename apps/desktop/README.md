# 桌面端（Electron）

Aervox 桌面客户端，基于 Electron + Vue 3 渲染。支持“桌宠陪伴”和“标准工作台”两种交互模式。

架构决策见 [ADR-009](../../docs/reference/adr/ADR-009-electron-plugin-sandbox.md)、[ADR-015](../../docs/reference/adr/ADR-015-vue-full-stack.md)。

## 开发

从仓库根目录运行：

```bash
./aervox dev           # 启动 API + Worker + 桌面端
./aervox dev desktop   # 仅启动桌面端（需已运行 API）
```

## 目录结构

- `src/main/` — Electron 主进程
- `src/preload/` — 安全桥接与上下文隔离脚本
- `src/renderer/` — Vue 渲染进程，复用 Web 端 composables 与主题
- `src/renderer/public/` — 静态资源（Live2D 模型等）
