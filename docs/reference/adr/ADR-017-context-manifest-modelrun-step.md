# ADR-017 冻结 ContextManifest / ModelRun / AgentStep 关联与 Inbox 数据模型

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

- 状态：Proposed
- 日期：2026-08-28
- 接受日期：（待 G2 架构与数据门禁）

- 关联：`AVX-HAR-001 §7.1/§7.2/§2.1/§4`（Context 组装与 AgentInboxItem）、`AVX-HAR-001 §13 阶段 5`（Inbox、压缩与高级能力）、`ADR-016`（底座边界冻结）、`ADR-005`（Provider Port）、`CAP-002/007`、NFR-DATA
- 前置决策：[ADR-016](ADR-016-base-boundaries.md) 已把 `packages/agent-loop` 限定为不得导入 `@aervox/database`/Drizzle/SQLite，本 ADR 冻结的是**数据所有权分层**（模型/记录归属）与 **shop 关系基数**，两者正交。

## Context

[AVX-HAR-001 §7.1](../agent-harness-loop.md#71-context-组装) 明确要求在此之前冻结 `ContextManifest` / `ModelRun` / `AgentStep` 的关联基数，并明确"不能继续用『按 Step/ModelRun 固化』这一含糊表述"：

- 当前 `context_manifests`、`model_runs` 是通用 CRUD 记录，只以 `modelRunId` 间接关联，**没有** `attemptId`/`stepId` 字段；
- `AgentStep` 是目标实体，当前尚未创建 schema；
- `AgentInboxItem` 在 §7.2 已定义语义（followup/steer/inject），但仍无 schema、仓储与消费实现。

同时，[阶段 5](../agent-harness-loop.md#阶段-5inbox压缩与高级能力)Inbox 落地需要先确立数据模型，而该数据模型与 `sessionId`/`attemptId`/`stepId` 的绑定关系必须线上冻结，避免进入实现后反向漂移。

## Decision drivers

1. **可追溯性（NFR-DATA）**：每个 ModelRun、ContextManifest、AgentStep、AgentInboxItem 必须能追溯到 `(workspaceId, subjectUserId, sessionId, attemptId[, stepId])`。缺少 `attemptId`/`stepId` 会使恢复、巡检和删除/撤权无法按 Attempt 粒度 fail-closed。
2. **唯一父级**：`ContextManifest` 唯一父级应为 `ModelRun`（一次模型调用一个 manifest），避免"按 Step/按 ModelRun 固化"两可表述造成的基数漂移；ModelRun 的唯一父级应为 `AgentStep`；AgentStep 的唯一父级应为 TurnAttempt。
3. **可重放恢复**：inbox 消费采用 claim/ack，崩溃后安全重放，因此必须绑定不可变来源、幂等键和状态字段。
4. **扩展点接入**：高级能力（压缩/Skill/Subagent）通过扩展点接入，不修改 Loop 核心控制流（AVX-HAR-001 §13 阶段 5 退出条件）；Inbox 只作为 ContextBuilder 的追加输入源，不改 Event 流契约。

## Considered options

1. **保持"按 Step/ModelRun 固化"的含糊表述**：拒绝。无法冻结基数，恢复/巡检无法按粒度定位，违背 driver 1。
2. **ModelRun 直接关联 Step 且 manifest 关联 Step（双父级）**：拒绝。一次 Step 可含多次重试模型调用（每次重试新 ModelRun），manifest 若直接挂 Step 会造出一对多且与模型调用不对齐的语义；必须保持 ModelRun 唯一父级。
3. **新增 `attemptId`、`stepId`，并以 ModelRun 作为唯一父级（本决策）**：选定。上游模型调用→(ModelRun, manifest) 一对一对齐；ModelRun→AgentStep→TurnAttempt 严格单父下溯，满足可追溯与删除/撤权。

### Inbox 数据模型选项（阶段 5a）

1. **全内存 inbox**：拒绝。崩溃即丢，违背 claim/ack 安全重放与 NFR-DATA。
2. **复用 Session 日志（直接写 TurnStreamEvent）**：拒绝。外部插件不能直接修改 Session 日志，只能提交受限 inbox command（§7.2），与安全边界冲突。
3. **独立 `agent_inbox_items` 表 + 仓储（本决策）**：选定。绑定租户/session/attempt、来源 actor、幂等键、类型、顺序、状态、消费时间与过期时间；消费用 claim/ack。

## Decision

冻结以下数据所有权与关联基数（阶段 5a 起进入实现，未落地前保持"目标"状态）：

### 关联链（单父严格下溯）

```text
TurnAttempt
  └─ AgentStep            （一次模型请求及其工具结果闭环；Step 序号单调）
       └─ ModelRun         （一次精确 Provider 调用；每次重试新 ModelRun）
            └─ ContextManifest（本次模型调用实际使用的来源清单；唯一父级 = ModelRun）
```

- `ModelRun`：唯一父级 = `AgentStep`；每 Step ≥1 条，重试产生新 ModelRun；**新增** `attemptId`、`stepId` 两个关联字段（迁移新增列，非新表）。
- `ContextManifest`：唯一父级 = `ModelRun`；一个 ModelRun 对应一个不可变 Manifest，多来源为多行 manifest entries；**新增** `modelRunId → attemptId/stepId` 冗余可推导但不冗余存储，仅保留 `modelRunId`。
- `AgentStep`：唯一父级 = `TurnAttempt`；`stepId` 在 Attempt 内单调递增，`executionId` 派生自 attemptId+stepId。
- 消除 §7.1 的"按 Step/ModelRun 固化"含糊表述，统一为：**以 ModelRun 为唯一父级**。

### AgentInboxItem（新增 `agent_inbox_items` 表）

| 字段 | 说明 |
|---|---|
| `id` | UUID 幂等键，claim 依赖 |
| `(workspaceId, subjectUserId, sessionId)` | 租户 + 目标边界（不可变） |
| `attemptId` / `stepId` | 消费目标（`next-turn`=null / `next-step` 定位 Step） |
| `type` | `followup`/`steer`/`inject` |
| `orderingSeq` | 顺序（同目标边界内单调） |
| `sourceActor` | 来源 actor（用户/Agent/Plugin） |
| `payload` | 内容载荷（compact 编码，含来源与用途标注） |
| `status` | `pending`/`claimed`/`acknowledged`/`expired` |
| `claimedAt` / `ackedAt` / `expiresAt` | 消费时间与过期时间 |
| `consumeBoundary` | `next-turn`/`next-step`（= §7.2 消费边界） |

- 所有权：表属 `packages/database`（数据真源底座）；`packages/agent-loop`/host 仅通过 Port 读写（不导入 database/Drizzle，遵循 ADR-016）。
- 外部插件只能通过受限 inbox command 提交，不能直接写表（§7.2 安全边界）。
- 消费采用 **claim/ack**：`claimed` 后崩溃可安全重放；`steer` 只作用于下一 Step 输入，不能改写已提交事件；`expiresAt` 兜底回收。

## Positive consequences

- 恢复/巡检/删除/撤权可按 Attempt→Step→ModelRun 严格粒度 fail-closed；
- Inbox 独立表不污染 Session 日志，外部贡献体无法越权改写；
- 高级能力（压缩/Skill/Subagent）以 ContextBuilder 追加输入接入，不改 Loop 核心控制流，满足阶段 5 退出条件。

## Negative consequences and risks

- `model_runs`/`context_manifests` 需 Expand 迁移新增 `attemptId`/`stepId` 列；存量数据按现有 `modelRunId` 反填（历史数据多数为空，接受慢启动回填）。
- `agent_inbox_items` 为新增表，需随阶段 5a 建表迁移；未建立前保持"目标"，不得在代码中假设其存在。
- 需在 CI 中为 inbox 读写增加 Adapter/Port 边界校验，防止 future drift（段 5a 落地时落地 `import-boundary.mjs` 追加规则或仓储自测）。

## Migration / rollback

- 前向：用数据库 Expand 迁移（ADD COLUMN，不回填==空）新增 `model_runs.attemptId`、`model_runs.stepId`；不立即回填，待阶段 5b（user-initted backfill）补齐。
- 回滚：仅舍这些列，不影响已写入的 `modelRunId` 主关联；`agent_inbox_items` 表未实现前无删除面。

## Verification evidence

- 阶段 5a 落地时：`packages/database` 新增 `agent_inbox_items` 表 + 仓储自测；`packages/agent-loop` 通过 Port 消费，不导入 `@aervox/database`（由 `scripts/import-boundary.mjs` 机器校验）。
- 关联链：ModelRun/ContextManifest 明确 `attemptId`/`stepId` 后，恢复/追溯测试（`agent-loop-recovery.test`）断言粒度定位。
- 本 ADR 状态为 `Proposed`，仅当 G2 架构与数据门禁通过后置 `Accepted` 并落实现有 `ADR README` 登记。
