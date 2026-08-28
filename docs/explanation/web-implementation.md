# Web 工作台实现规划（Vue 单栈）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-28

> 文档编号：AVX-WEB-001  
> 版本：v0.1（规划候选）  
> 更新日期：2026-08-28  
> 状态：Review Candidate  
> 关联：[ADR-015](../reference/adr/ADR-015-vue-full-stack.md)（Web 技术基线）· [ADR-014](../reference/adr/ADR-014-modular-monolith-structure.md)（apps/api 模块组织）· [架构设计](../reference/ARCHITECTURE.md) · [PRD](../reference/PRD.md)

本文规划 `apps/web` 的实现路径：作为 Vue 全栈单栈的一员，最大化复用 `apps/desktop` 的 renderer 资产，并严格通过 `@aervox/contracts` + `@aervox/api` 消费后端能力。

## 1. 目标与范围

**目标**：交付登录后的流式工作台（对话 + 学习 + 日记 + 复习 + 通知/反馈），与桌面端共享同一套 Vue 技术族与契约，最终可被 Capacitor 打包为移动端壳。

**范围（MVP）**：

- 对话：创建 Turn、SSE 流式消费（`useAervoxTurn` 浏览器分支）、取消、幂等；
- 学习：目标列表/创建、题目作答、复习项到期列表与完成；
- 日记：按日查询、计划主实体展示；
- 辅助：反馈、通知列表、埋点上报；
- 桌宠 UI：Web 与桌面端主工作台均通过共享 `Live2DPet` 渲染 Live2D 桌宠（沉浸式满高主体，双端同步）；Electron 另保留独立 `pet.html` 桌宠窗口与窗口控制。

**不在范围**：用户注册/登录表单（与 SQLite 阶段一致，见 CR-003）、服务端 SSR、P2 插件。

## 2. 技术选型

| 依赖 | 选择 | 说明 |
|---|---|---|
| 框架 | Vue 3 + `<script setup>` | 与 desktop 一致（单栈统一） |
| 构建 | Vite 7 + `@vitejs/plugin-vue` | 与 desktop 的 `electron-vite` 渲染层同源 |
| UI | Element Plus（复用）+ `@aervox/ui` 共享工作台与主题 CSS | Electron 与 Web 使用同一套工作台组件；桌面壳和桌宠表现层按平台保留 |
| 状态/路由 | 组件内 composables + 少量父组件协调；多页用 Vue Router | 与 desktop 的"无 router、单一注入"模式对齐，不引入 Pinia 等额外依赖 |
| HTTP/SSE | 浏览器 Fetch（`useAervoxApi` 既有降级路径）+ `useAervoxTurn` 新增 SSE 分支 | 无桌面桥时自动直连 `VITE_API_URL` |
| 校验 | `@aervox/contracts` Zod schema | OpenAPI/请求体验证统一 |

## 3. 从 desktop 复用的边界

| 资产 | 处置 |
|---|---|
| `useAervoxApi.ts` | **直接复用**：`request()` 的 `window.fairyDesktop` 判断在 web 恒为 undefined，天然走 fetch 分支 |
| `useAervoxTurn.ts` | **补分支**：新增 `streamTurnViaSSE()`（`fetch(…/events)` + `Last-Event-ID` + SSE 解析），桌面桥分支保留 |
| `PetWindow.vue` / `AppTitlebar.vue` | 桌面壳组件不迁移；Web 不引入 `PetBubble` 或 Electron 窗口控制 |
| `packages/ui` `AervoxWorkbench.vue` / `workbench.css` | 共享对话、学习、工具面板和主题；通过 `platform` / `showCompanion` 处理桌面与 Web 差异 |
| `types/chat.ts` | 复用 |
| preload/main（Electron 主进程） | **不复用**（web 无主进程）；窗口控制改空实现或隐藏 |

> 若 web 与 desktop 复用面扩大（如对话渲染组件、学习卡片），优先将公共组件提升到未来的 `packages/ui`，避免直接复制三份。

## 4. 目录结构草案

```text
apps/web/
├── src/
│   ├── api/                 # 复用的 request 桥 + SSE 流式（源自 desktop composables）
│   │   ├── request.ts
│   │   └── stream-turn.ts
│   ├── components/          # 平台壳组件（Web 不含桌宠）
│   ├── composables/         # useAervoxApi、useAervoxTurn（复用）
│   ├── router/              # Vue Router 路由表（/chat、/learning、/diary、/review、/settings）
│   ├── styles/              # 主题（迁移 desktop story/pet 风格）
│   ├── types/               # 领域 DTO
│   ├── App.vue
│   └── main.ts
├── index.html
├── package.json
└── tsconfig.json
```

## 5. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| M1 骨架 | `apps/web` 建仓（Vite+Vue+TS）、复用 request 桥、Vue Router 空路由、CI 接入 | workspace `ci-code` 通过；`pnpm dev:web` 可启动且直连本地 API |
| M2 对话流式 | `streamTurnViaSSE` + 聊天 UI + 建议问题/自由输入；turns 创建与取消 | SSE 流式消费端到端可用；test 新增（降级 fetch、SSE 解析） |
| M3 领域页面 | 学习目标/题目作答/复习项、日记查询、通知/反馈/埋点 | 页面走通；复用 desktop composables 语义 |
| M4 工作台与打磨 | ✅ 沉浸式共享工作台双端同步：居中构图（桌宠内移 + 卡片锚定中线右侧，消除中部留白）、顶部左侧液态玻璃菜单胶囊（圆形⇄圆角长条弹性展开、选项高光扫过、全部映射既有功能）、Live2D 左侧满高区域（实际像素底边对齐、高度驱动最大化）、右侧功能卡片升格为页面主元素（纵向满高均分两槽、大图标 + 标题/副标题/摘要/打开提示分层、亚克力玻璃 + 顶部高光条、8 项已有功能可选、持久化、可更换）、对话模式选择器（4 模式，前缀随消息发送）、输入框 IME 修复（组合期不收起、候选 Enter 不发送）、最大化纯文本消息面板（1440px / 62vh）、收起式半透明输入、悬浮设置、WinUI3 风格云母背景（雾蓝主题，双端亮暗同步）、`clamp()` 全尺寸自适应 | UI/Web/Desktop typecheck + build + test；`check:boundary` 零违规（落地登记见[追踪基线 §4.2](../reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)） |
| M5（后续） | ✅ Capacitor 最小壳已建立（`apps/mobile` v0.1，web 平台，config 指向 `../web/dist`）；原生平台（android/ios）与 auth 接入待 PG 阶段 | 壳内直连 API 可运行；`cap sync web` / `cap doctor` 通过 |

## 6. 风险与待定项

- **鉴权**：SQLite 阶段无登录，租户由 `x-workspace-id`/`x-user-id` 回退默认；web 上线前需确认如何注入租户头（与 desktop 相同的环境变量）。标识为默认可注入方案先行，正式 auth 随 PG 阶段引入。
- **CORS**：`apps/api` 需为同源或本地开发放开 CORS；在 `buildApp` 中按环境注入（改动 API 骨架，随 M1 处理）。
- **SSE 重连**：浏览器侧实现须遵循 `Last-Event-ID`（ADR-012），避免重复展示。
- **双端主题一致性**：Web 与 desktop 共享 `@aervox/ui` 工作台与主题，平台壳差异通过属性适配，避免两套视觉漂移。
- **设置窗口一致性**：两端共享 `AervoxWorkbench` 的设置入口与双栏设置窗口；左侧分类、右侧详情在窄屏退化为横向分类栏。主题、助手称呼、回车发送、界面密度、番茄钟时长和提醒偏好保存在当前设备，Electron 主题继续通过受限 IPC 同步到窗口壳。

本次实现对应 [CR-005](../reference/changes/CR-005-shared-workbench-web-without-pet.md) 与 [CR-007](../reference/changes/CR-007-live2d-sekai-viewer-pet.md)：Web 工作台使用共享 `Live2DPet`。沉浸式重构后双端主工作台均内嵌 Live2D 满高主体（Electron 经 `show-companion` 开启，桌面端可在设置中关闭），独立 `pet.html` 窗口继续保留。

## 7. 同步清单（随 ADR-015 执行）

- [x] `ADR-002` 标记 Superseded by ADR-015
- [x] 新增 `ADR-015`（Vue 全栈单栈）
- [x] 本规划文档（AVX-WEB-001）
- [x] `ADR` 索引表 / `ARCHITECTURE.md §2/§3/§11` / `DOC_REGISTRY.md` / `PRD.md` 技术栈行
