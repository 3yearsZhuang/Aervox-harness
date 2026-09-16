---
id: AVX-PLAN-035
type: reference
scope: temporary-plan
owner: maintainers
doc_status: draft
decision_status: not-applicable
delivery_status: not-applicable
version: 0.1.0
updated_at: 2026-09-16
reviewed_at: 2026-09-16
review_interval_days: 30
review_triggers:
  - docs/reference/changes/CR-035-standard-workbench-mode.md
  - packages/ui/**
  - packages/api-client/**
  - apps/api/src/modules/companion/conversation/**
  - apps/api/src/modules/proactive/proactive/**
  - apps/web/**
  - apps/desktop/src/renderer/**
sources:
  - docs/reference/changes/CR-035-standard-workbench-mode.md
  - docs/reference/changes/CR-034-local-model-fallback-ladder.md
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
  - docs/reference/changes/CR-032-proactive-intelligence-plugin-ecosystem.md
  - docs/reference/changes/CR-006-plugin-config-and-pages.md
  - docs/reference/changes/CR-030-pure-local-sqlite-database.md
  - docs/reference/adr/ADR-012-streaming-safety-persistence.md
  - docs/reference/adr/ADR-017-context-manifest-modelrun-step.md
  - docs/reference/ARCHITECTURE.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# AVX-PLAN-035 临时计划：CR-035 标准 AI 工作台形态实施拆分

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-16

> [!WARNING]
> 本文件是临时执行计划，不是 UI、API、项目或任务调度的事实源。原始提案 [CR-035](reference/changes/CR-035-standard-workbench-mode.md) 仍是方向基线；本文件不改变 CR-035、CAP-026、CAP-033 或相关 ADR 的状态。

## 1. 结论与纠偏

CR-035 与现有 Vue、`packages/ui`、共享 API Client、SQLite 本地单用户和 CR-006 插槽体系相容，方向可行；但 W1 不能按原文的“纯前端、后端契约零变更”直接开工。当前只有固定 `sessionId`、内存 story 和单会话流，缺少会话枚举/历史/重命名/分组/置顶 API；W3 也不能直接把主动智能 `proactive_projects` 当成用户项目。

实施决策为 `More Evidence Required`，拆为：

| 子片 | 内容 | 前置 |
|---|---|---|
| F0/F1 | DoR、共享 Session/Project/TaskCenter 契约 | 无 |
| W1 | 标准模式壳、会话导航和最小会话 API | F1 |
| W2 | 模式选择器与只读任务中心 | F1、CR-034 路由契约 |
| W3a | 显式项目上下文与资产聚合 | W1、CAP-026 状态确认 |
| W3b | 单一外部会话格式导入器 | W3a 的 provenance/删除契约 |

## 2. F0：基线、边界与 DoR

1. 明确 CR-034 的模型层级 DTO 是 W2 的单向输入；CR-035 不复制降级决策、不改变 `toolApprovalMode` 或主动调度语义。
2. 明确 CR-033 的主动动态卡、预算和态势投影只是呈现来源；任务中心只读透传，不重造调度器。
3. 复核 CR-006 插槽、CR-032 主动事件、ADR-012 流式恢复、ADR-017 ContextManifest 和 CR-030 本地数据/迁移边界。
4. 拆分 W1/W2/W3 子 CR，定义 owner、AC/TC、SLO、成本、无障碍、隐私、用户通知、灰度和独立 flags：`standard_shell`、`session_navigation`、`task_center`、`project_context`、`conversation_import`。
5. 将 CAP-026/CAP-033 的 `Mapped/Not Ready` 状态写入计划前置条件，不在 UI 中伪造尚未闭合的知识库或主动能力。

出口：G0/G1 通过，所有子片需求、数据删除边界和回滚条件 `Ready`。

## 3. F1：共享契约（无用户行为变更）

定义并生成 Zod/OpenAPI/API Client 契约：

- `SessionSummary`、`SessionDetail`、分页 `SessionHistory`、cursor/排序、重命名、分组、置顶、归档、删除、revision/CAS 和幂等键；
- `ProjectRef` 与 `candidate → confirmed → archived` 生命周期，显式项目和主动推断候选分层；
- `TaskCenterItem` 只读联合 DTO：source、type、status、nextAt、timezone、error、deepLink 和 freshness；
- `WorkbenchModePreference`：标准/陪伴模式、版本、宿主和迁移策略；服务端 SQLite 是真源，`localStorage` 只能做缓存；
- 会话切换、SSE 断线/重连、未提交草稿、进行中 Turn、删除和撤权的状态机。

契约测试必须覆盖旧客户端固定 `sessionId` 的兼容行为；任何新增写操作都必须经过既有 API/Repository，不允许 UI 直接改表。

## 4. W1：标准模式壳与会话导航

1. 先补会话 list/detail/history/rename/group/pin/archive/delete 的 Repository 与 API，再实现侧栏；不能把 W1 标为纯前端。
2. 在 `packages/ui` 复用现有 `AervoxWorkbench`、`useWorkbenchConversation`、`useWorkbenchLayout` 和 `ConversationConsole`，将标准/陪伴模式收敛为同一业务组合式的不同布局。
3. 会话切换时固化 session snapshot，停止旧 SSE、恢复可重放事件、处理草稿和未完成 Turn；刷新、断线和并发切换不得丢失已提交消息。
4. 桌面和 Web 只替换 transport/companion adapter，不复制两套会话状态；键盘导航、焦点、窄屏布局和无障碍语义在组件层验收。

验收：双端同一 session 的历史、Turn 状态和工具审批一致；旧陪伴模式无回归；新会话、搜索、分组/置顶、刷新/重连和删除路径有 E2E 证据。

## 5. W2：模式选择器与只读任务中心

- 输入框模式选择器聚合模型/降级层级（消费 CR-034 DTO）、访问级别、项目上下文和附件；完全访问沿用既有审批语义，不新增隐式提权。
- 任务中心通过 adapter 只读聚合日记计划、复习 due、番茄钟、主动规则/冷却、scheduled jobs 和 notifications，统一状态、时区、错误、更新时间和 deep-link。
- 所有修改操作跳转原来源设置或既有端点；任务中心不写调度表、不重造执行语义、不改变主动裁决。
- 增加加载失败、过期、无权限、离线和部分来源不可用的明确状态；Web/Desktop 共用 DTO 和展示组件。

验收：来源状态对账、时区/DST、只读保证、错误可见性、模式选择器触点、L0/L1/L2 标签、工具审批和桌宠主动事件双形态一致。

## 6. W3a：项目上下文

1. 新增显式用户项目实体或建立明确的 adapter 分层；不得直接复用 `proactive_projects` 的生命周期和权限。
2. 设计 `session_project` 关系（先确定一对多或多对多）、归档、解绑、删除、CAS 和来源链；主动推断只能作为候选，用户确认后才成为项目。
3. 项目聚合会话、学习材料/知识条目、收藏和主动对象；CAP-026 尚未 Ready 时只展示已存在且已授权的资产，不伪造知识库状态。
4. 所有绑定和解绑采用 additive migration；删除项目不删除会话、学习事实或主动源事实，只写控制事件和关系变更。

验收：关联一致性、并发冲突、撤销/删除传播、来源可追溯、权限快照、空项目和迁移回滚。

## 7. W3b：迁移友好设施

首版只支持一种已确认格式，流程固定为：

```text
选择文件 → 预览 → schema/大小/深度校验 → 冲突报告 → 事务导入 → 可审计结果
```

- 外部导出是完全不可信输入：字段白名单、消息数/深度/字节上限、压缩包安全（若支持）、编码和注入净化；
- 导入记录携带 `imported` provenance、来源文件摘要、时间和批次幂等键；不得直接成为 system prompt、工具指令或长期记忆事实；
- 失败可重试、可取消、可删除导入批次，冲突不静默覆盖现有会话；保留用户可见的冲突报告；
- 许可证、格式说明和用户通知在 G0/G1 固定。

验收覆盖恶意 JSON、Prompt injection、超大输入、重复导入、部分失败、取消、删除/导出回放和重启恢复。

## 8. 双形态一致性与可观测性

服务端 SQLite 是会话、项目关系和导入批次的真源；浏览器/桌面 `localStorage` 仅保存布局缓存。统一记录：session switch latency、history/list p95、task aggregation freshness/error rate、mode parity、renderer memory/crash、导入拒绝/成功/冲突率、SSE gap/replay 和无障碍回归结果。

所有 UI 变更保留既有安全分类器、工具审批卡、persona/记忆管线和桌宠常驻路径；标准模式不得成为安全旁路。

## 9. 测试与发布门禁

每个子片独立通过：

- G2：布局/数据/威胁/隐私/迁移/成本/回滚评审；
- G3：build/typecheck、Zod/OpenAPI、Repository/API、组件、Playwright/E2E、SSE 恢复和并发测试；
- G4：UX、键盘/屏幕阅读器、性能、导入安全、删除/导出、权限和恢复测试；
- G5/G6：内部 canary、监控/值班/runbook、备份恢复、回滚演练和发布后冒烟。

## 10. 回滚与生命周期

- W1 flag off：回到现有 `NavPill`、drawer 和固定 session 客户端；新增会话元数据保留，不删除既有事实；旧客户端继续可用。
- W2 flag off：隐藏任务中心和模式选择器，所有源调度表保持原语义；CR-034 只读标签不影响路由。
- W3a flag off：停止新项目绑定，允许解绑关系但不删除会话、学习或主动事实；
- W3b flag off：停止新导入，保留可审计批次和用户可删除的导入元数据；
- 所有数据库变更采用 expand-first/additive；若必须换库，遵守“停写→备份→选择范围→staging→校验→原子换库→保留回滚包”。

正式子 CR 实施后同步 PRD/SRS、ARCHITECTURE、DATABASE、DATA_PRIVACY、THREAT_MODEL、STREAMING_PROTOCOL、TEST_STRATEGY、operations，并在 [REQUIREMENTS_TRACEABILITY.md §4.2](reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 登记 CAP、AC/TC、路径、日期和验证证据。

本临时计划在 W1/W2/W3 子 CR 通过 G1 后失效，需迁移到正式 CR 或删除。
