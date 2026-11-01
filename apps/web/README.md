# Web 工作台

Aervox Web 前端，基于 Vue 3 + Vite。桌面浏览器默认工作台布局，移动浏览器默认主动陪伴界面。

## 开发

从仓库根目录运行：

```bash
./aervox dev web   # 启动 API + Web（默认 http://127.0.0.1:5173）
```

## 与桌面端的关系

Web 与桌面端均从 `@aervox/ui` 复用组件与主题，由 `@aervox/ui-host` 装配 `plugins/surfaces/*` 的根界面，并通过 `@aervox/api-client` 连接本机 API。两端各自维护平台入口，详见 [ADR-015](../../docs/reference/adr/ADR-015-vue-full-stack.md)。
