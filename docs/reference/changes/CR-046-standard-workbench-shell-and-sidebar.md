---
id: CR-046
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: verified
version: 1.0.0
updated_at: 2026-09-14
reviewed_at: 2026-09-14
review_interval_days: 90
sources:
  - docs/reference/changes/CR-035-standard-workbench-mode.md
  - docs/reference/PRD.md
  - docs/reference/DATABASE.md
  - docs/reference/capability-registry.md
---

# CR-046 标准工作台交互壳与会话侧栏 (W1)

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

- 状态：Accepted / Verified
- 关联变更：[CR-035 标准 AI 工作台形态](CR-035-standard-workbench-mode.md) · [CR-030 纯本地 SQLite 单库](CR-030-pure-local-sqlite-database.md)
- 关联能力：`CAP-013`（流式对话）、`CAP-019`（桌宠交互与情感表达）、`CAP-020`（技能/插件系统）

---

## 1. 提案范围与目标

作为 CR-035 标准工作台形态的阶段 1（W1），本提案交付面向熟悉范式迁移用户的核心交互壳层与原生多会话导航：

1. **会话列表侧栏 (`WorkbenchSidebar.vue`)**：提供品牌标题、`+ 新建对话` 快捷按钮（含 ⌘N / Ctrl+N 徽标）、会话快速过滤搜索框、时间分组列表（置顶、今天、最近 7 天、更早）、内联重命名与级联删除确认；
2. **多会话状态与传输层 (`useAervoxSessions.ts`)**：提供统一的 Vue 响应式状态管理，与 `transport.ts` 动态对齐活跃 `sessionId`，支持本地存储偏好恢复；
3. **双形态无缝切换**：在 `useWorkbenchLayout.ts` 中引入 `workbenchMode`（`companion` ↔ `standard`）与 `standardSidebarCollapsed` 折叠状态，状态保存至 `localStorage`；
4. **共享底层对话与安全契约**：标准模式与桌宠陪伴模式共用完全一致的流式回合（`ConversationConsole`）、输入底座（`ComposerDock`）、插件运行时、主动智能与安全审批门禁；在标准模式下桌宠作为非阻塞悬浮挂件常驻，保障情感陪伴护城河；
5. **后端 REST 契约与 SQLite 仓储**：基于纯本地 SQLite 单库提供会话枚举 `GET /v1/sessions`、创建 `POST /v1/sessions`、重命名 `PATCH /v1/sessions/:sessionId` 与级联删除 `DELETE /v1/sessions/:sessionId`。

---

## 2. 验证与落地依据

- `@aervox/contracts`：新增 `sessionItemSchema`、`listSessionsResponseSchema`、`createSessionRequestSchema`、`renameSessionRequestSchema`，并通过 OpenAPI 规范校验；
- `@aervox/repositories`：在 `IConversationRepository` 与 `SqliteConversationRepository` 实现会话查询、重命名与级联物理删除；
- `apps/api`：会话管理路由注册并通过自动化单测 `session-routes.test.ts`；
- `@aervox/api-client`：实现 `useAervoxSessions` 与 `setSessionId`，通过自动化单测 `sessions.test.ts`；
- `@aervox/ui`：交付 `WorkbenchSidebar.vue`、`AervoxWorkbench.vue` 双模式布局与 WinUI3 云母质感主题适配，通过自动化单测 `standard-workbench.test.ts` 与构建检查。
