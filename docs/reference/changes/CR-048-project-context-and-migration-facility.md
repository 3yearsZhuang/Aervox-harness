---
id: CR-048
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: verified
version: 1.0.0
updated_at: 2026-09-15
reviewed_at: 2026-09-15
review_interval_days: 90
sources:
  - docs/reference/changes/CR-035-standard-workbench-mode.md
  - docs/reference/PRD.md
  - docs/reference/capability-registry.md
---

# CR-048 项目上下文绑定与会话迁移设施 (W3)

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-15

- 状态：Accepted / Verified
- 关联变更：[CR-035 标准 AI 工作台形态](CR-035-standard-workbench-mode.md) · [CR-046 标准工作台交互壳与会话侧栏](CR-046-standard-workbench-shell-and-sidebar.md) · [CR-047 模式切换器与统一任务中心](CR-047-mode-selector-and-task-center.md)
- 关联能力：`CAP-026`（收藏空间与知识库条目）、`CAP-033`（主动智能推断项目）

---

## 1. 提案范围与目标

作为 CR-035 标准工作台形态的阶段 3（W3），本提案完整落地项目上下文组织层、外部迁移导入设施与全局命令面板：

1. **项目上下文绑定（Project Context）**：
   - 数据库新增 `projects` 表（名称、描述、颜色、图标、归档标记），并在 `sessions` 补充 `project_id` 外键与索引；
   - 提供标准 RESTful CRUD 接口（`GET /v1/projects`、`POST /v1/projects`、`PATCH /v1/projects/{id}`、`DELETE /v1/projects/{id}`）；
   - 会话列表支持 `projectId` 维度条件过滤；删除项目时原子解绑会话而保留会话实体；
2. **外部客户端会话迁移设施（Migration Facility）**：
   - 提供 `POST /v1/sessions/import` 接口，支持批量解析外部历史消息并生成标准会话、Turn 与消息版本；
   - 兼容标准数组、嵌套 `messages` 对象与 ChatGPT 导出的 `mapping` 树；
3. **全局快捷键与命令面板（Command Palette）**：
   - 全局支持 `⌘K` / `Ctrl+K` 唤起命令面板，支持按键快速执行会话新建、项目切换、导入会话与系统设置；
   - 侧边栏集成项目筛选胶囊与快速操作栏。

---

## 2. 落地实现与验证

- **契约与架构**：`packages/contracts/src/project-schemas.ts`、`packages/schema/src/project.ts`；
- **仓储层实现**：`packages/repositories/src/repositories/sqlite/project-repository.ts`（`SqliteProjectRepository`）、`SqliteConversationRepository.importSession`；
- **服务端路由**：`apps/api/src/modules/project/routes.ts`、`apps/api/src/modules/project/index.ts`；
- **客户端与组件**：`packages/api-client/src/useAervoxProjects.ts`、`packages/ui/src/components/workbench/CommandPalette.vue`、`packages/ui/src/components/workbench/modals/ProjectManagerModal.vue`、`packages/ui/src/components/workbench/modals/ImportSessionModal.vue`；
- **测试覆盖**：
  - 契约测试：`packages/contracts/test/project-contract.test.ts`
  - 仓储单测：`packages/repositories/test/project-crud.test.ts`
  - 路由测试：`apps/api/test/project-routes.test.ts`
  - 客户端测试：`packages/api-client/test/projects.test.ts`
  - UI 单元测试：`packages/ui/test/command-palette.test.ts`
