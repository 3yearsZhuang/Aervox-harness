# Fairy Agent

[![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Vue](https://img.shields.io/badge/Vue-3-42B883?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Element Plus](https://img.shields.io/badge/Element%20Plus-UI-409EFF?logo=element&logoColor=white)](https://element-plus.org/)
[![Lucide](https://img.shields.io/badge/Lucide-Icons-F56565?logo=lucide&logoColor=white)](https://lucide.dev/)

一个基于 Electron、Vue 3 和 TypeScript 的 Aervox 桌面 AI 对话应用，配有独立悬浮桌宠窗口。桌面端通过 `@aervox/contracts` 的 Turn/SSE 契约访问 Aervox API，不在桌面端持有核心业务数据。

## 功能

- 以桌宠为核心的视觉小说式 AI 对话场景
- Vue 3 + TypeScript + Element Plus UI
- Lucide 图标系统，统一图标尺寸和交互状态
- 独立透明、可拖动、始终置顶的桌宠窗口
- 长文本逐句推进、全文展开与历史回看
- 可折叠的建议问题和自由输入区域
- 桌宠二级工具菜单：待办清单、番茄钟、对话历史
- 自定义无边框标题栏与窗口控制
- 亮色模式、暗色模式和系统主题自动适配
- 响应式侧栏、聊天区、输入区和模型选择器
- Electron `contextIsolation` 与沙箱 preload

## 技术栈

| 层级              | 技术                   |
|-----------------|----------------------|
| Desktop Runtime | Electron             |
| Frontend        | Vue 3 + TypeScript   |
| UI Components   | Element Plus         |
| Icons           | Lucide Vue Next      |
| Build           | electron-vite + Vite |
| Validation      | vue-tsc              |

## 快速开始

环境要求：Node.js 24+、pnpm 11。

```bash
pnpm install
pnpm run dev
```

在主仓根目录执行 `pnpm install`，再运行以下命令同时启动 API 和桌面端：

```bash
pnpm dev:desktop
```

桌面 renderer 不直接访问模型或 API，而是通过受限 preload IPC 交给 Electron 主进程调用 Aervox Turn/SSE。API 地址可在启动桌面端前通过服务端环境变量指定：

```powershell
$env:AERVOX_API_URL = 'http://127.0.0.1:3000'
$env:AERVOX_SESSION_ID = '<现有会话 ID>'
pnpm dev:desktop
```

桌面端不会自行创建临时会话；`AERVOX_SESSION_ID` 必须指向现有 API 能识别且当前用户有权访问的会话。模型、鉴权、持久化和安全策略继续由原有 `@aervox/api` 负责。
在主仓根目录执行 `pnpm install`，再通过 `pnpm --filter @aervox/desktop dev` 启动桌面端。

生产构建与本地预览：

```bash
pnpm run typecheck
pnpm run build
pnpm start
```

## 项目结构

```text
src/
├─ main/                 Electron 主进程与窗口生命周期
├─ preload/              安全桥接 API
└─ renderer/
   ├─ components/        标题栏、侧栏、聊天区、桌宠窗口
   ├─ composables/       可复用状态逻辑
   ├─ styles/             主窗口和桌宠主题样式
   ├─ types/              TypeScript 领域类型
   ├─ main.ts             主聊天窗口入口
   └─ pet-main.ts         独立桌宠窗口入口
```

## pnpm scripts

| 命令                  | 作用                       |
|---------------------|--------------------------|
| `npm run dev`       | 启动 Electron 开发模式         |
| `npm run typecheck` | 执行 Vue/TypeScript 类型检查   |
| `npm run build`     | 构建主进程、preload 和 renderer |
| `npm start`         | 构建并启动本地预览                |
