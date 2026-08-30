# ADR-015 Vue 全栈单栈：Web 复用桌面端技术族

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-31

- 状态：Proposed（替代 `ADR-002`）
- 日期：2026-08-25

- 关联：`ADR-002`（Superseded）、`ADR-014`、`CAP-001/002/009/018`、`NFR-PERF-001`、`NFR-COMPAT-001`、`AVX-WEB-001`

> 更新日期：2026-08-31

## Context

ADR-002 将 Web 层基线定为 React 19/Vite 7；但首版桌面端 `apps/desktop` 已按 Vue 3 + Element Plus + `electron-vite` 落地（v0.2，含桌宠窗口、对话流式、主题、composables），且其 renderer 数据层已具备浏览器直连降级。若 Web 再按 React 新建，将出现 Vue/React 双前端栈；后续移动端若沿用 ADR-002 的 Expo/React Native，则形成三栈，1~2 人团队难以长期维护。另有结论：对话/学习/日记类产品对原生渲染依赖低，移动端完全可由 WebView 壳（Capacitor）承载，因此"移动端需要 RN"不再构成 Web 必须用 React 的理由。

## Decision drivers

- 桌面端（产品核心形态）已投入 Vue 资产，Web 应最大化复用而非另起 React 栈；
- 1~2 人团队承受不了多前端框架的长期维护成本（Vue+React+RN 三栈）；
- 前端必须继续消费 `@aervox/contracts` 的 Turn/SSE 协议与 `@aervox/api` 网关，与框架语言无关；
- 架构决策需保持"演进式"：不与 ADR-014（模块化单体）冲突，未来仍可按测量结果调整。

## Considered options

1. **Vue 全栈单栈（本决策）**：Web 采用 Vue 3（复用 desktop renderer 核心），移动端后续用 Capacitor 直接打包 web；三端一套 `<script setup>` + Element Plus。
2. **React Web 新建 + 桌面保持 Vue**：贴合 ADR-002 原文，但 Vue/React 双栈并存，`packages/ui` 无法共享，移动端 RN 则三栈。
3. **React Web 先行 + 桌面渐进迁移 React**：长期全栈统一 React 且桌面/移动共享 packages/ui，但桌面存量 Vue（桌宠/对话/主题）迁移成本高、风险大，现阶段投入不成比例。

## Decision

采用 **Vue 全栈单栈**，并替代 ADR-002 中 Web 层的 React 基线：

- **Web**：Vue 3 + Vite + TypeScript + Element Plus，作为 `apps/web` 工作台；核心 composables 从 desktop renderer 复用（`useAervoxApi` 请求降级模式、`useAervoxTurn` 的 SSE 浏览器分支）；
- **Desktop**：保持 Electron + Vue（现状，零改动）；
- **Mobile（后续）**：Capacitor 打包 `apps/web`，WebView 壳 + 受限桥接，不引入 RN；
- **通信协议不变**：仍为 POST Turn + GET SSE + OpenAPI 3.1（ADR-002 中与框架无关的契约部分继续有效）。

## Positive consequences

- 三端单一前端技术族，1~2 人团队维护成本最低；
- Web 可立即复用 desktop 的数据层与类型，开发速度最快；
- 桌面端为核心形态的首发壳不受影响，移动端为纯增量（web 打包）；
- 消除"React Web 与 Vue 桌面"的架构矛盾，文档与实现重新一致。

## Negative consequences and risks

- 丧失 React 生态（Vercel AI SDK 前端 hooks、RN 原生渲染等）；本项目前端流式走自有契约，AI SDK 主要工作在后端 `ProviderPort`，风险可控；
- 若未来产品出现强原生需求（离线体验、深度系统集成、大列表性能），Capacitor 需加桥或迁移 RN——为此保留评估触发点；
- ADR-002 的 Web/UI 基线废弃，历史文档需同步（本决策已列同步清单）。

## Migration / rollback

迁移即"新建 apps/web"，不迁移桌面端；桌面端代码零改动。回滚路径：若 Web 复用验证失败，可退回独立 React Web（ADR-002 原案仍在历史中），或采用 Option 3；协议与后端不受影响。

## Verification evidence

- `apps/web` 可构建并通过 workspace `ci-code`（typecheck + build + test）；
- Web 端默认不注入桌面桥时正确降级为浏览器 Fetch（含 SSE 流式消费）；
- SSE 断线重连（`Last-Event-ID`）与重复去重测试（沿用 `TC-RES-STREAM-001`）；
- Playwright 覆盖学习闭环与对话流式核心流程（沿用 `TC-E2E-STREAM-001`、`TC-E2E-COMPAT-001`）。

## 验收差距复核（2026-08-31）

- **已满足**：`apps/web` 构建 + `ci-code` 全绿；无桌面桥时浏览器降级。
- **未满足**：`TC-RES-STREAM-001` 客户端重连（Last-Event-ID）测试；Playwright E2E 未引入（`TC-E2E-STREAM-001`/`TC-E2E-COMPAT-001` 未落地）。
- **推进路径**：引入 Playwright 基线后走 G2 评审。
