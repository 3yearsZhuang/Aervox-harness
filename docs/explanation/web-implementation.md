# Web 工作台实现规划（Vue 单栈）

> 文档编号：AVX-WEB-001  
> 版本：v0.1（规划候选）  
> 更新日期：2026-08-25  
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
- 桌宠 UI：由 Electron 专属多窗口改为**同页浮层组件**（`PetBubble`）。

**不在范围**：用户注册/登录表单（与 SQLite 阶段一致，见 CR-003）、服务端 SSR、P2 插件。

## 2. 技术选型

| 依赖 | 选择 | 说明 |
|---|---|---|
| 框架 | Vue 3 + `<script setup>` | 与 desktop 一致（单栈统一） |
| 构建 | Vite 7 + `@vitejs/plugin-vue` | 与 desktop 的 `electron-vite` 渲染层同源 |
| UI | Element Plus（复用）+ 现有手写主题 CSS | desktop 已有 story/pet 主题风格，直接迁移 |
| 状态/路由 | 组件内 composables + 少量父组件协调；多页用 Vue Router | 与 desktop 的"无 router、单一注入"模式对齐，不引入 Pinia 等额外依赖 |
| HTTP/SSE | 浏览器 Fetch（`useAervoxApi` 既有降级路径）+ `useAervoxTurn` 新增 SSE 分支 | 无桌面桥时自动直连 `VITE_API_URL` |
| 校验 | `@aervox/contracts` Zod schema | OpenAPI/请求体验证统一 |

## 3. 从 desktop 复用的边界

| 资产 | 处置 |
|---|---|
| `useAervoxApi.ts` | **直接复用**：`request()` 的 `window.fairyDesktop` 判断在 web 恒为 undefined，天然走 fetch 分支 |
| `useAervoxTurn.ts` | **补分支**：新增 `streamTurnViaSSE()`（`fetch(…/events)` + `Last-Event-ID` + SSE 解析），桌面桥分支保留 |
| `PetWindow.vue` / `AppTitlebar.vue` | 桌面壳组件不迁移；新增 web 版 `PetBubble.vue`（同页右下角浮层）+ 浏览器版窗口控制 |
| `styles/`（story/pet/css） | 迁移，作为 web 主题基础 |
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
│   ├── components/          # PetBubble、聊天区、学习卡片、日记卡片等
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
| M4 桌宠与打磨 | PetBubble 同页浮层、主题切换、响应式布局、键盘可达性 | WCAG 2.2 AA 自查；Playwright 冒烟 |
| M5（后续） | ✅ Capacitor 最小壳已建立（`apps/mobile` v0.1，web 平台，config 指向 `../web/dist`）；原生平台（android/ios）与 auth 接入待 PG 阶段 | 壳内直连 API 可运行；`cap sync web` / `cap doctor` 通过 |

## 6. 风险与待定项

- **鉴权**：SQLite 阶段无登录，租户由 `x-workspace-id`/`x-user-id` 回退默认；web 上线前需确认如何注入租户头（与 desktop 相同的环境变量）。标识为默认可注入方案先行，正式 auth 随 PG 阶段引入。
- **CORS**：`apps/api` 需为同源或本地开发放开 CORS；在 `buildApp` 中按环境注入（改动 API 骨架，随 M1 处理）。
- **SSE 重连**：浏览器侧实现须遵循 `Last-Event-ID`（ADR-012），避免重复展示。
- **双端主题一致性**：web 与 desktop 共享 styles，避免两套视觉漂移。

## 7. 同步清单（随 ADR-015 执行）

- [x] `ADR-002` 标记 Superseded by ADR-015
- [x] 新增 `ADR-015`（Vue 全栈单栈）
- [x] 本规划文档（AVX-WEB-001）
- [x] `ADR` 索引表 / `ARCHITECTURE.md §2/§3/§11` / `DOC_REGISTRY.md` / `PRD.md` 技术栈行
