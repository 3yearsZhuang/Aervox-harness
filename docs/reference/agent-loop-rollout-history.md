---
id: AVX-HAR-002
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.1.0
updated_at: 2026-09-10
reviewed_at: 2026-09-10
review_interval_days: 90
sources:
  - docs/reference/agent-harness-loop.md
---

# Agent Harness Loop 分阶段落地进展与追溯历史

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-09-10

关联：[Agent Harness Loop 设计与落地规范](agent-harness-loop.md)（AVX-HAR-001）、[CR-012](changes/CR-012-agent-harness-loop.md)、[需求追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)

本文从 [Agent Harness Loop 设计与落地规范 (agent-harness-loop.md)](agent-harness-loop.md) 拆分而来，记录 Agent Harness Loop 各阶段（阶段 2b 至阶段 6f）详细的代码落位、数据库表变更、测试用例与历史进展。

## 落地进展追溯清册

### 16.4 落地进展（阶段 2b：用户取消闭环）

2026-08-28 落地（对应 §5.1 状态机、§11.1 取消与 §16.1 `agent-loop-recovery`/`agent-loop-fencing` 的取消面）：

- `AttemptStatus` 增加 `CancelRequested`（请求位，仅 `Running` 可置）与 `Cancelled`（终态）；
- `ExecutionStorePort` 增加 `requestCancelAttempt`（CAS：仅 Running 可写，已终态拒绝）与 `isCancelRequested`（executor 检查点轮询）；
- executor 在 Step 首部、工具批次执行前与各终态提交前检查取消，取消优先于租约探活与预算/环境结论；终态以 `Cancelled` 提交（CAS），`finalize` 被抢占时不写不在不一致的 `done` 事件；
- `POST /v1/turns/:id/cancel` 路由 CAS 化：Attempt `Running → CancelRequested` 且 turns 未终态时置 `Cancelled`；已终态返回 409、未知 Turn 返回 404；
- 测试：`@aervox/agent-loop` 25（cancel 6）、`@aervox/database` 115（cancel 4）、`@aervox/api` 89（conversation-cancel 3）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

已知边界：取消请求位在 Step 之间的延迟生效窗口内，Executor 至多完成当前 Step 的已启动工具副作用（§11.1 best-effort abort）；Provider 流中断由检查点轮询在 Step 边界收敛。

### 16.5 落地进展（阶段 2d：预算对账与删除/撤权 fail-closed）

2026-08-28 落地（对应 §10 限额、§11.3 恢复、§16.1 `agent-loop-budget`/`agent-loop-deletion`）：

- §10 预算：`maxTurnDurationMs`（单 Turn 总耗时）与 `maxConsecutiveSameTool`（连续同名工具，跨 Step 累计，防死循环）已实现；触发以 `Interrupted` 收敛，`done` 事件携带 `reason`（`turn_timeout` / `repeat_tool`）；
- §11.3 fail-closed：新增 `DeletionGatePort`，Step 边界查询删除/撤权水位（`deletion_requests` 存在 `pending`/`in_progress` 即未追平）；未追平则零模型输出、零工具执行，收敛 `Interrupted`（`deletion_blocked`），并经隐私仓储接入 API 路由；
- 测试：`@aervox/agent-loop` 30（`budget.test.ts` 5：超限/不误伤/超时/闸门阻塞/放行）、`@aervox/database` 115、`@aervox/api` 91（`conversation-deletion` 2：未追平 fail-closed / 追平后正常）。
- 仍未覆盖（后续批）：`maxParallelReadTools`、token/费用预算与 `maxTokens`（依赖 Provider 上报 `usage`，属阶段 2e+）。`maxModelRetries` 已落地（B4-C：仅首可见片段前且无副作用时重试）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.6 落地进展（阶段 2c：工具幂等预留与 unknown outcome）

2026-08-28 落地（对应 §9 幂等预留管线、§11.3 恢复表、§16.1 `agent-loop-recovery` 的工具面）：

- `ToolExecutionStatus` 增加 `pending`（意图已提交/进行中）与 `outcome_unknown`（崩溃释放后结果不可知）；
- `ExecutionStorePort` 增加 `reserveToolExecution`（幂等预留：attempt+invocation 唯一，`ON CONFLICT DO NOTHING`）与 `updateToolExecutionResult`（权威结果收口同一行）；executor 工具路径改为「预留 → 执行 → 收口」，非幂等失败不自动重试；重复调用以 `duplicate` 独立留痕；
- `turn_attempts` 释放（`Interrupted`/`Failed`/`Cancelled`）后，恢复器 `markPendingOutcomeUnknown` 将遗留 `pending` 预留标记为 `outcome_unknown`（§11.3：不自动重放未知结果副作用），已接入 worker 恢复 cycle；
- 测试：`@aervox/agent-loop` 33（`idempotency.test.ts` 3：预留收口/重复不二次执行/崩溃标记）、`@aervox/database` 119（`tool-reservation.test.ts` 4：新建/幂等/收口/释放标记）、`@aervox/api` 91（工具账本断言兼容旧路径）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

已知边界：崩溃后「继续原 Attempt、从 ToolExecution 读取权威结果并继续」的恢复路径（§11.3 表格首范式）仍未实现，属阶段 3 写工具恢复范围；当前恢复语义为「释放 → 用户重试新 Attempt」。

### 16.7 测试矩阵落地文件映射（§16.1 与代码一一对应）

2026-08-28 整理：矩阵每项均有对应测试文件（未实现项明确标注待续）。

| §16.1 矩阵项 | 落地测试（包内路径） | 状态 |
|---|---|---|
| `agent-loop-contract` | `packages/agent-loop/test/contract.test.ts` | 已落地 |
| `agent-loop-replay` | `packages/agent-loop/test/replay.test.ts` | 已落地 |
| `agent-loop-state-machine` | `packages/agent-loop/test/state-machine.test.ts` | 已落地 |
| `agent-loop-fencing` | `packages/agent-loop/test/lease-guard.test.ts` | 已落地 |
| `agent-loop-tool-policy` | `packages/agent-loop/test/tool-policy.test.ts`（read/write/privileged 三档）；`approval-loop.test.ts`（审批） | 已落地 |
| `agent-loop-recovery` | `lease-guard`（过期释放）+ `cancel.test.ts`（取消）+ `budget.test.ts`（闸门）+ `idempotency.test.ts`（工具未知结果）+ `executor-b4.test.ts`（首片段前模型重试、流式中断） | 已落地（`maxModelRetries` 见 §10，B4-C） |
| `agent-loop-sse` | `apps/api/test/conversation-loop.test.ts`（持久后发送/重连重放） | 已落地 |
| `agent-loop-budget` | `packages/agent-loop/test/budget.test.ts`（step/turn-timeout/repeat-tool） | 已落地（token/费用预算待续） |
| `agent-loop-deletion` | `apps/api/test/conversation-deletion.test.ts`（未追平 fail-closed）+ `budget.test.ts`（DeletionGate） | 已落地 |
| `agent-loop-provider-parity` | `packages/agent-loop/test/provider-parity.test.ts`（终止语义表 + Native 基线 + 三方插槽 + 阶段 4 退出条件「driver 切换不改事件流契约骨架」）+ 阶段 6 `adapter-contract.test.ts`（any/every 收紧对照） | 已落地（DSH/pi 真实运行时对照待 Adapter 准入；收紧语义已机器验证） |

### 16.8 落地进展（阶段 2a：可观测性接口）

2026-08-28 落地（对应 §16.3 与 Kernel Substrate「Observability/Recovery」；接口先行，采集接线待阶段 4）：

- 新增 `packages/observability`（`@aervox/observability`，零第三方依赖）：`LoggerPort`（结构化日志，禁用敏感内容）、`MetricsExporterPort`（counter/gauge/histogram）、`AuditExporterPort`（不可变事件流，at-least-once 语义）、`Observability` 门面；
- 指标名目录对齐 §16.3：`metric-names.ts` 登记 18 个 counter、5 个 gauge（含阶段 4d 新增 `agent.host.running/processed/uptime_ms`）、2 个 histogram（Provider TTFT/耗时、工具执行/超时、租约/fencing/恢复、预算、SSE 重连等）；新增指标必须先在此登记；
- 默认 `createNoopObservability()`：零成本、幂等、永不抛错；
- 测试：`@aervox/observability` 5（指标目录覆盖 §16.3 关键面 + Noop 调用不抛错/child 幂等）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

未接入（待阶段 5+ 完成全链路采集）：executor 指标采样、审计留痕与 SSE 遥测尚以注释/目录形式存在，需在组合根注入 `Observability` 后启用。阶段 4 host 侧已部分接线（`createAgentHost` 注入 `Observability`，turn 完成/fencing deny/duration/审计已采集；4d 新增 `agent.host.running/processed/uptime_ms` gauge 由 `health()` 上报）。

### 16.9 落地进展（阶段 3a：Host 幂等键 + 崩溃/超时/重复投递三重恢复测试）

2026-08-28 落地（对应 §9 idempotency、§11.3 恢复、阶段 3 退出条件「崩溃/网络超时/重复投递下写工具副作用至多一次」）：

- **Host 幂等键重生成**：executor 为每次工具调用生成 `executionId = attemptId:step:seq`，作为副作用账本（预留/收口）与 `tools.execute` 的幂等标识；事件流保留 `invocationId = call.id`（模型关联面，契约兼容）并新增 `executionId` 字段；
- **三重恢复场景测试**（`packages/agent-loop/test/recovery.test.ts`）：
  - crash：预留未收口 → `outcome_unknown` 不自动重放；新 Attempt 按新 Host 键独立执行，旧预留不被消费；
  - timeout：工具超时 → `timeout_error` 收口一次，不自动重试（副作用至多一次）；
  - redelivery：已终态 Attempt 重复领取被拒（`not_runnable`），同 `executionId` 二次预留 `alreadyReserved`（副作用不重复）；
- 测试：`@aervox/agent-loop` 50（recovery 3）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.10 落地进展（阶段 3b：privileged 管理员通道）

2026-08-28 落地（对应 §9 privileged 默认拒绝 + 独立管理员放行）：

- privileged 工具收敛为与 `write_with_approval` 相同的「授权命中（granted）→ 执行 / 未批准 → 审批待决」流程（不再硬拒绝）。普通 Turn 的**授予动作**仍受管理员身份校验：`POST /v1/turns/:id/tool-approvals` 对 privileged 工具要求 `x-admin-user-id` ∈ `AERVOX_ADMIN_IDS` 白名单，否则 403 `admin_required`；CAP-033 主动智能模式的用户 `FullProfileActionGrant` 走独立动作授权快照与本地 Host 门，不把普通 Turn 自动授权伪装成管理员授予。
- 新增 `getToolApproval`（读单条待决记录供预检）与 `scripted-privileged` 测试 Provider 脚本；
- 测试：`@aervox/api` 101（`conversation-privileged` 3：未批准待决 / 非管理员 403 / 管理员 grant 后执行成功）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.11 落地进展（阶段 3c：恢复裁决基础设施）

2026-08-28 落地（对应 §11.3 首范式「工具结果已权威提交但尚未注入」；**续跑执行接线属阶段 4 host-agent**，本阶段仅裁决与候选能力）：

- `packages/agent-loop` 新增纯函数 `decideResume(events, toolExecutions)`：仅当最后一工具结果批次全部 `executed` 且无终态事件 → `{ resume: true, lastSequence }`；`terminal_event` / `mixed_batch`（严格批次语义）/ `outcome_unknown`（结果未知不自动重放）/ `no_committed_tool` 一律收敛；
- `packages/database` 新增 `findResumeCandidates`：过期 Running Attempt 且存在 `executed` 工具执行且无 `done` 终态事件（附最后 tool_result 序号）；worker 恢复 cycle 先收集候选（观测日志），`recoverExpiredAttempts` 行为不变（仍释放为 Interrupted）；
- 测试：`@aervox/agent-loop` 56（`resume-decision.test.ts` 6：裁决矩阵）、`@aervox/database` 125（候选 3：命中/终态排除/未知排除）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.12 落地进展（阶段 4a/4b/4c：内嵌异步 Host + 恢复接线 + 最小 Profile）

2026-08-28 落地（对应 §13 迁移期接线、§11.3 首范式「续跑执行接线属阶段 4 host-agent」、§3 Resolver 不变量）：

- `packages/host-agent` 新增 `SqliteExecutionStore`（自 apps/api 迁移的组合根适配，API 同步路径与异步 Host 共用；API 删除本地副本）；
- `createAgentHost`：轮询/claim（CAS+fencing 委托 executeTurn）/并发上限+背压（槽满不再领取）/优雅停机 drain/`processed`/`running` 观测；`@aervox/observability` 接入（turn 完成计数、fencing deny、duration 直方图、审计，Noop 兜底）；
- `SqliteResumeSource`（4b 恢复接线）：`findResumeCandidates` 扩展返回续跑数据面（租户/session/用户消息/当前 fencing），逐候选 `decideResume` 裁决 → `buildResumeHistory` 重建上下文 → 产出带 resume 的 ClaimableTurn 抢占续跑原 Attempt；`executeTurn` 新增 `resume` 选项（跳过 message 身份事件、sequence 从 lastSequence+1、Step/executionId 从 lastStep 之后、预填历史）；
- `createAgentProfile`（4c 最小 Profile）：Driver→Provider 绑定（replay 无依赖 / native 需 CR-015 同源 baseUrl/apiKey/modelId）+ 单例锁文件（持有者存活拒绝 / 陈旧锁接管 / 释放后可重取）；
- 测试：`@aervox/host-agent` 18（host 编排 6、store 冒烟 3、resume 源 3、profile 6）、`@aervox/agent-loop` 58（resume-executor 2：抢占续跑完成/Step 不冲突）、`@aervox/api` 101（接线后无回归）、`@aervox/database` 125（候选数据面扩展）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.13 落地进展（阶段 4d：健康检查 + 阶段 4 退出条件验证）

2026-08-28 落地（对应 §13 阶段 4 第 5 条「健康检查」与退出条件「切换 Driver 不改客户端契约与数据所有权、无 DSH/pi 时原生 Profile 可运行」）：

- **Host 健康检查**（`createAgentHost` 新增 `health(): Promise<HostHealth>`）：
  - liveness 五态：`starting`（未启动）/`healthy`（活）/`draining`（停机 drain 中）/`stopped`（已停）/`stalled`（tick 超 `3×pollIntervalMs` 未推进，死锁疑点）；首次 tick 未完成时以 `startedAt` 兜底，避免永久误判 healthy；
  - readiness：可选 `probeDeps()` 注入依赖探针（source/provider/store 等），`ready = status===healthy && dependencies 全 ready`；探针抛错收敛为 `probeDeps` 故障项而非让 `health()` 抛错；
  - 容量上报：`health()` 调用时上报 gauge `agent.host.running`/`agent.host.processed`/`agent.host.uptime_ms`（登记入 `metric-names.ts`，Noop 观测缺省不抛错）；
  - 返回结构含 `running`/`processed`/`startedAt`/`lastTickAt`/`uptimeMs`/`dependencies`/`ready`，供宿主轮询或未来 HTTP `/health` 端点消费。
- **阶段 4 退出条件验证**：
  - 客户端契约不变（`packages/agent-loop/test/provider-parity.test.ts` 新增）：replay 与注入式 custom provider 各跑一 turn，事件流 eventType 集合 ⊆ 契约枚举 `{message,delta,tool_request,tool_result,done,error}`，首事件 `message`、末事件 `done`、中间 `delta`，骨架同构；
  - 业务数据库所有权（`scripts/import-boundary.mjs` `agent-loop-no-db` 健身函数）：机器验证 `packages/agent-loop` 不导入 `@aervox/database`/`@libsql`/`drizzle-orm`，数据库由宿主（`packages/host-agent` + `packages/database`）管理；
  - 无 DSH/pi 时原生 Profile 可运行（`packages/host-agent/test/profile.test.ts`）：replay 无依赖、native 需 CR-015 同源配置，均已验证。
- 测试：`@aervox/host-agent` 27（新增 `host-health.test.ts` 9：liveness 五态/readiness 探针/stalled/容量 gauge/Noop 兜底）、`@aervox/agent-loop` 59（provider-parity 新增 1：driver 切换契约骨架同构）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.14 落地进展（阶段 5a：受控收件箱 AgentInboxItem）

2026-08-28 落地（对应 §13 阶段 5 首条目 followup/steer/inject 的数据面与消费闭环；ADR-017 冻结实现）：

- **数据面**（`packages/database`）：
  - 新增 `agent_inbox_items` 表 + schema（`agent-inbox.ts`）：`(workspaceId, subjectUserId, sessionId)` 目标边界、`type`（followup/steer/inject）、`orderingSeq`、`sourceActor`、`payloadJson`、`status`（pending/claimed/acknowledged/expired）、`consumeBoundary`（next-turn/next-step）、`claimedAt/ackedAt/expiresAt`、幂等键 `(tenant, idempotencyKey)` 唯一索引、租户+状态查询索引；`init.ts` 幂等建表/索引；
  - `SqliteAgentInboxRepository`（`agent-inbox-repository.ts`）：`enqueue`（幂等：同 idempotencyKey 返回既有项；consumeBoundary 按类型推定 followup→next-turn / steer·inject→next-step）、`claimForConsumption`（next-step 需 attemptId 定位 / next-turn 忽略 attemptId；过滤过期项；CAS 单赢——已 claim 未 ack 不重复返回）、`acknowledge`（仅 claimed→acknowledged）、`getByIdempotencyKey`。
- **消费闭环**（`packages/agent-loop`，扩展点接入、不改核心控制流）：
  - `InboxPort`（enqueue/claimForConsumption/ack）+ `AgentInbox*` 领域类型（ADR-017）；
  - `ContextBuilderPort.build` 输入追加 `inboxItems`（§7.1 第 7 项）；`defaultContextBuilder` 透传不注入（后向兼容），`createInboxAwareContextBuilder` 把 inbox 项作为追加 user 消息前置（附 `[inbox:type@actor]` 标注）；
  - `executeTurn` 新增可选 `deps.inbox`：每 Step 前 claim next-step 项注入 context、读入即 ack（未 ack 项崩溃恢复后重新 claim，安全重放）；未配置 inbox 时行为与既有完全一致；
  - `InMemoryInbox`（测试骨架：enqueue 幂等 / claim 单赢 / 边界按类型推定）。
- **Host 接线**：`createAgentHost` deps 新增可选 `inbox`，透传至 `executeTurn`。
- 测试：`@aervox/database` 132（新增 `agent-inbox.test.ts` 7：enqueue 幂等/claim 单赢/ack 仅 claimed/过期过滤/租户隔离/next-turn 无 attemptId）、`@aervox/agent-loop` 67（新增 `inbox.test.ts` 7：executor claim→注入→ack 集成/inbox 不残留 claimed/后向兼容/其它 attempt 不消费/builder 注入标注/InMemoryInbox 语义）、`@aervox/host-agent` 27（接线后无回归）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。
- 已落地（阶段 7）：ContextManifest 写入（每 Turn 首 Step 快照）与 model_runs/context_manifests 的 attemptId/stepId Expand 迁移（ADR-017 迁移面；Step 级 recordModelRun + recordContextManifest 为可观测副作用，经扩展点接入不改 Loop 核心，见 §16.20）。

### 16.15 落地进展（阶段 5a-2：受控收件箱 HTTP 入口 + 过期回收）

2026-08-28 落地（对应 §13 阶段 5 首条目的 API/插件受控入口与过期兜底；补完 5a 消费闭环的 next-turn 面）：

- **契约**（`packages/contracts`）：新增 `inbox-schemas.ts`（`inboxItemTypeSchema`/`inboxSourceActorSchema`/`inboxConsumeBoundarySchema`/`inboxItemStatusSchema`/`createInboxItemRequestSchema`（type-payload-幂等键，sessionId 可选仅一致性校验）+ `inboxItemResponseSchema`）；`openapi.ts` 注册 `CreateInboxItemRequest`/`InboxItem` 与 `POST /v1/sessions/{sessionId}/inbox` 路径（tags: Inbox）。
- **API 入口**（`apps/api/src/modules/inbox/`）：
  - `routes.ts` 统一端点 `POST /v1/sessions/:sessionId/inbox`：服务端强校验（type ∈ followup/steer/inject；consumeBoundary 与 type 一致 followup→next-turn / steer→next-step / inject 皆可；payload 必填）、幂等（同 idempotencyKey 租户内唯一，重复提交返回既有项 200）；
  - sourceActor 由服务端按调用方身份注入，客户端不自报：缺省 `user`；携带 `x-plugin-id` 时校验插件已安装且启用 + 授予 `inbox.command` 权限，否则 403，通过则注入 `plugin`；
  - `port.ts` `createTenantInboxPort`：把 SQLite 仓储适配为 agent-loop `InboxPort`（绑定请求租户，ADR-016 组合根适配）。
- **消费闭环补完**（`apps/api/src/modules/conversation/`）：
  - `routes.ts` 创建新 Turn 时对该 session 执行一次 `next-turn` claim 并 ack，把 followup 项注入为新 Turn 输入（payload 字符串合并到 userMessage；已消费不重复注入）；
  - `runLoopTurnOnce` 新增可选 `inbox` 转发给 `executeTurn`（每 Step 消费 next-step：steer/inject 注入上下文）。
- **过期回收**（`packages/database` + `apps/worker`）：
  - `IAgentInboxRepository.expireOverdue(now?)` + `SqliteAgentInboxRepository` 实现：跨租户把所有 `expiresAt < now` 且仍 pending/claimed 的项置为 expired（claimed 即消费中崩溃未 ack，兜底作废不重放；单批 200，可重复轮询）；
  - `apps/worker/src/inbox-expiry.ts` `runInboxExpiryCycle` 挂载到 `runTick`（普通轮询，随 worker 日志输出 `inbox_expired`）。
- 测试：`@aervox/contracts` typecheck + OpenAPI 生成通过；`@aervox/api` 109（新增 `inbox-routes.test.ts` 8：三类提交 201/幂等 200/非法 type·payload·边界 400/steer attemptId/插件身份 403→授权 201/next-turn 注入与不重复消费）；`@aervox/database` 134（`agent-inbox.test.ts` 新增 2：expireOverdue pending+claimed 回收/跨租户+幂等）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.16 落地进展（阶段 5b：Context 压缩 seam + Skill 渐进式披露接入 ContextBuilder）

2026-08-28 落地（对应 §13 阶段 5 的 Context compaction seam 与 Skill 渐进式披露；§7.1 Context 组装第 4/5 项）：

- **扩展点**（`packages/agent-loop`）：
  - `ContextCompactionPort`（`compact` 可插拔，缺省 `defaultCompactionPort` 透传、行为与既有完全一致）+ 内置规则式摘要 `createSummaryCompaction(maxMessages)`（超阈值保留首尾消息、中部一行 `[Context compaction: …]` 摘要占位，纯函数无外部依赖；生产可注入 LLM 摘要实现）；
  - `ContextBuilderPort.build` 返回类型扩展为 `PromptContext | Promise<PromptContext>`（压缩端口为 async；executor 调用点 await，既有同步实现零改动）；
  - `SkillDescriptor`（name+description，不携全文）与 `buildSkillsPrompt`（由 `apps/api` 迁入，AstrBot 渐进披露规则：仅注入技能清单，模型按需 `GET /v1/skills/:name/content` 读全文）；
  - `createSkillAwareContextBuilder`（system 段前置，已有首条 system 时插其后不翻倍）、`createComposedContextBuilder({ base, inbox?, skills?, compaction? })` 统一组合（目标消息顺序：system(skills) → inbox 追加 → 历史；压缩 seam 最外层后处理）。
- **API 接线**（`apps/api`）：
  - `skill-manager.ts` 改引用 agent-loop 的 `buildSkillsPrompt`（删除 `skill-prompt.ts` 本地副本，单一真源）；
  - `conversation` 模块默认启用 Skill 渐进披露：`skillLoader`（`SqliteSkillRegistryRepository.listSkills(true)` → name+description）注入 `runLoopTurnOnce`，无 active Skill 时退化为原行为；Context 压缩 seam 默认关闭，设置 `AERVOX_LOOP_COMPACTION=rule` 开启内置规则式摘要。
- 测试：`@aervox/agent-loop` 77（新增 `context-builder.test.ts` 9：skills prompt 构造/空清单/system 不翻倍/默认透传/规则摘要阈值与幂等/composer 组合顺序/异步 build）；`@aervox/api` 110（`conversation-loop.test.ts` 新增 1：注册 active Skill 后创建 Turn 仍成功，skillLoader 接线不破坏 Loop）；既有 5a/5a-2 无回归。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.17 落地进展（阶段 5c：Subagent/Workflow 通过独立 Tool/Provider Contribution 接入）

2026-08-28 落地（对应 §13 阶段 5 末项；ADR-017「高级能力经扩展点接入，不改 Loop 核心」）：

- **扩展点**（`packages/agent-loop`）：
  - `SubagentPort`（`delegate`：父执行键幂等，宿主持有）+ `ToolExecutionInput.sessionId` 透传（executor 仅补字段，无控制流改动）；
  - `composeToolProviders(providers, { fallback? })`：多 Contribution 合并为单一清单交付 executor；重名组装期报错；execute 按名路由，未命中委托 `fallback`（支持动态注册表 provider——`createRuntimeToolProvider` tools 实时校验不静态声明）或 fail-closed；
  - `createSubagentToolProvider({ subagent })`：贡献 `subagent_delegate`（写类，走既有审批通道，与 5a-2 受控入口对称）；委托结果经既有 tool_result 回填，失败父级可收敛/重试；
  - `createWorkflowToolProvider(defs)`：TS 步骤定义（`WorkflowDefinition`/`WorkflowStep`，天然过 typecheck）暴露 `workflow_run`（写类）；步骤顺序执行、上一步输出为下一步输入、失败携带步骤定位与部分产物；未注册流程 fail-closed。
- **数据面**（`packages/database`）：`subagent_runs` 表（父 Turn/Attempt/执行键 + 子 turn/attempt + task/toolScope/status/result/时间戳；`parentAttemptId+parentExecutionId` 幂等唯一索引）+ `SqliteSubagentRunRepository`（createRun 幂等 / finalizeRun 仅 Running 收口 / getRunByParentExecution / listRunsByTurn 租户隔离）；init 幂等 CREATE。
- **宿主执行器**（`packages/host-agent`）：`createSqliteSubagentPort`——子任务独立 turn/attempt 落库（复用 `createTurnWithOutbox`/`createTurnAttempt`，事件流在子 turn 下审计）→ 嵌套 `executeTurn`（子任务 Step 上限默认 4）→ delta 聚合正文 → run 行终态收口；隔离原则（子上下文仅 task，不注入父历史）+ 递归防护（childTools 含 delegate/workflow 即拒绝）＋崩溃/重试幂等复用。
- **API 接线**（`apps/api`）：`buildLoopProvider` 提取（Leader 与子任务共用）；conversation 模块默认接线 `subagentFactory`（request 级 tenant 绑定）+ 可选 `workflows`（`buildApp` 透传）；工具组合 = compose(subagent/workflow 静态贡献, fallback=动态 runtime)；新端点 `GET /v1/turns/:turnId/subagents`（子任务审计，租户隔离）与 `GET /v1/workflows`（注册清单元数据）。
- 测试：`@aervox/agent-loop` 90（新增 `subagent-contribution.test.ts` 13：compose 并集/重名/路由/fallback 兜底、subagent 委托透传/失败/非法输入/退化为空、workflow 顺序/失败定位/未注册/抛错）；`@aervox/database` 139（新增 `subagent-runs.test.ts` 5：创建幂等/终态收口/列表/租户隔离）；`@aervox/host-agent` 31（新增 `subagent-executor.test.ts` 4：端到端落库+正文聚合/幂等复用/递归防护/子任务失败）；`@aervox/api` 199（新增 `subagent-routes.test.ts` 4：workflows 清单/空清单退化/子任务审计租户隔离/workflow 贡献不破坏 Loop）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.18 落地进展（阶段 6：DSH/pi 进程外 Adapter 契约面 + 模拟器）

2026-08-28 落地（对应 §13 阶段 5 末项与 ADR-010「DSH/pi 仅为可选适配器」；范围：契约面 + 模拟器，不接真实外部运行时——参考项目固定 commit 准入留给 P2 验收）：

- **契约**（`packages/agent-loop/src/adapter-contract.ts`）：
  - `AdapterDriverPort`（整 Turn 代理执行：request → delta/tool_request/tool_result/batch 事件流）与 `AdapterManifest`（adapterId/version/sha256/license/terminationPolicy）；
  - `concludeAdapterBatch` 纯函数：上游 any/every 批次声明收紧为 Aervox `all-results-conclude`——全结论收敛、空批次按无结论、全不结论不收敛、**混合批次一律拒绝（mixed_batch）不静默放行 any**（reference-design-transfer §1.1 冻结语义机器验证）；
  - `verifyAdapterManifest`：固定 SHA 复核（TC-CONTRACT-STREAM-001）+ 许可证白名单（MIT/Apache/BSD；AGPL 等拒绝，ADR-010）+ 策略白名单；
  - `AdapterWireMessage` + `encodeAdapterLine`/`decodeAdapterLine`：JSON 行协议（子进程 stdio 与内存模拟器共用，shape 白名单校验）。
- **模拟器**（`adapter-sim.ts`）：`createSimAdapterDriver`（dsh-any / pi-every 双实现）+ `drainAdapterDriver`（事件收集 + 收紧判定 + 未声明批次协议缺陷标记）。
- **进程外端口**（`packages/host-agent/src/stdio-adapter.ts`）：`createStdioAdapterDriver`——spawn 子进程 → 握手（hello → 准入复核，失配 kill + `adapter_admission_failed`）→ 逐 Turn 请求-事件 ping-pong；单 Turn 总超时与握手超时；kill switch（close 幂等）；失败自动禁用（后续 run 抛 `adapter_unavailable`）。fixture：`test/fixtures/sim-adapter.mjs`（env 注入 manifest 与批次模式 all/none/mixed/none-value）。
- **Profile 准入**（`profile.ts`）：`LoopDriverId` 扩 `dsh`/`pi`；未提供已准入 Adapter 时拒绝解析（ADR-010「不安装也完整可用」不回归）；adapterId 与 driver 失配拒绝（`driver_adapter_mismatch`）。
- **测试**：`@aervox/agent-loop` 105（新增 `adapter-contract.test.ts` 15：conclude 收紧矩阵/verifyAdapterManifest SHA·许可证·策略/decode 合法非法/sim 双实现 + drain 判定与协议缺陷）；`@aervox/host-agent` 41（新增 `stdio-adapter.test.ts` 10：握手准入/SHA 失配 kill/许可证拒绝/mixed 收紧/协议缺陷/超时禁用 + Profile dsh·pi 解析矩阵）；`@aervox/api` 201 无回归。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.19 落地进展（阶段 6b/6c：Host 接入 Adapter + DSH 固定 SHA 复核真实化）

2026-08-28 落地（承接 §16.18 契约面，把 Adapter 接入 Host 执行循环并把固定 SHA 复核真实化；仍不接参考仓库构建产物）：

- **Host 接入**（`packages/host-agent/src/adapter-turn.ts` + `agent-host.ts`）：
  - `runAdapterTurn`：claim（CAS+fencing）→ adapter 整 Turn（`drainAdapterDriver` 熟悉事件 + 收敛）→ 事件**映射既有契约**落库（message/delta/tool_request/tool_result/done；`executionId=attempt:0:seq` 审计键）→ finalize；收紧：concluded→Completed、mixed_batch→Interrupted+`ADAPTER_NOT_CONCLUDED`、协议缺陷→Interrupted、异常/超时→Failed+`ADAPTER_UNAVAILABLE`；重复投递→skipped；
  - `createAgentHost({ adapter })`：存在已准入 Adapter 且非续跑时用 `runAdapterTurn` 轮询驱动，否则原生 `executeTurn`（续跑/无 adapter 路径零改动；宿主终态计数归一原生小写/adapter 大写）。
- **DSH 固定 SHA 复核真实化**（`packages/host-agent/src/dsh-reference.ts`）：`probeDSHReference` 用父仓库 submodule gitlink（`git ls-tree HEAD -- reference/deepseek-harness`）与 `DSH-01` 登记 SHA（`b150a551…`）机器比对 + package.json 版本/许可证复核（MIT 白名单）。参考仓库为 pnpm monorepo：真实 Turn 需 `git submodule update --init && pnpm install && pnpm build:lib:host` 后接入 stdio 端口（ADR-010 实施进展含指引）；本阶段不隐式构建，未就绪 fail-closed 并给出 reason。
- **测试**：`@aervox/host-agent` 51（新增 `adapter-host.test.ts` 7：runAdapterTurn concluded/mixed/协议缺陷/抛错/skipped + Host 集成 adapter 与原生双路径回归；`dsh-reference.test.ts` 3：gitlink 匹配 MIT manifest/submodule_missing/non-git fail-closed）；`@aervox/api` 202 无回归。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.20 落地进展（阶段 7：ContextManifest 写入 + ModelRun Step 级关联，ADR-017 迁移面）

2026-08-28 落地（对应 ADR-017 的 `model_runs`/`context_manifests` 关联冻结与 §16.14 原「阶段 7」项）：

- **Expand 迁移**（`packages/database`）：`model_runs` 新增 `attempt_id`/`step_id`（PRAGMA 检查 + ADD COLUMN 幂等，不回填==空，多跑幂等）；`context_manifests` 新增 `snapshot_json`（每 Turn 上下文快照）；Drizzle schema 同步 + `model_runs_tenant_attempt_idx` 索引。
- **扩展点写入**（`packages/agent-loop`）：`ExecutionStorePort.recordModelRun`（每 Step 一条：runId/attemptId/stepId/provider/modelId/purpose/status/latencyMs）+ `recordContextManifest`（每 Turn 首 Step：manifestId/modelRunId/snapshot=messages）——可观测副作用（同 recordToolExecution），写入失败不阻断执行；`InMemoryExecutionStore` 收集供断言。
- **API 接线**（`apps/api`）：conversation 注入 `SqlitePlatformRepository` 构造 `ModelRunSink`（createModelRun+completeModelRun / createContextManifest+attach 关联回写），经 `SqliteExecutionStore(…, sink)` 可选委托；缺省 no-op 兼容既有宿主。
- 测试：`@aervox/agent-loop` 108（新增 `context-manifest.test.ts` 3：单 Step 一条 run+manifest 与 snapshot 快照/多 Step 每 Step 一条 run 而 manifest 仅首条/无 meta 缺省兼容）；`@aervox/database` 142（新增 `platform-modelrun.test.ts` 3：Expand 幂等/Step 级 create+complete/manifest snapshot+attach）；`@aervox/api` 202 无回归。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。ADR-017 实施进展已更新。

### 16.21 落地进展（阶段 6d/6e：DSH 真 Turn 接通骨架 + 库内产物接入证据）

2026-08-28 落地（承接 §16.19/§16.20，把 6c 的「固定 SHA 复核」推进为可运行的 DSH Turn 接通骨架；6e 在参考仓库 `pnpm install && pnpm build:lib:host` 构建通过后验证库内 Agent 循环可加载）：

- **runner**（`packages/host-agent/test/fixtures/dsh-turn-runner.mjs`）：完整 stdio 协议（hello/request/delta/batch/done/error）；模型回合为**真实 LLM**（OpenAI 兼容直连：`DEEPSEEK_API_KEY` 或 `DSH_LLM_BASE_URL` 指向任意兼容端点），输出 delta→batch(全结论)→done；缺前置返回指引性 `dsh_unconfigured`（host 失败自动禁用）；启动即探测参考仓库构建状态并提示（`cd reference/deepseek-harness && pnpm install && pnpm build:lib:host`）。
- **6e 库内产物探测**（`DSH_LIB_MODE=1`）：动态 import `packages/core/agent/lib/index.js` 并验证公开导出面（`AgentRegistry`/`assembleContextFor`/`installModelSelection`/`emitAgentEvent` 等）——库内 Agent 循环可加载的机器证据；完整 Cordis 容器组装（llm/session/persistence/tools 等 service 注入）为剩余 P2 工程项。
- **adapter 组合**（`packages/host-agent/src/dsh-adapter.ts`）：`createDSHAdapterDriver({ repoRoot, env? })`——probeDSHReference（gitlink SHA + MIT）通过后才 spawn runner（`createStdioAdapterDriver` 复用，expectedSha=DSH_REFERENCE_SHA）；未就绪不 spawn 且返回 reason。
- 测试：`@aervox/host-agent` 56 +1 skipped（新增 `dsh-turn.test.ts` 6：复核通过+spawn 且 manifest 一致 / 缺 key→dsh_unconfigured 指引性拒绝 / 真模型回合（`it.runIf` key 就绪，外部 4xx 软跳过）/ probe 未就绪 fail-closed / 本地兼容端点完整回合 delta→batch→done→concluded 机器验证 / **库内产物加载证明（`it.runIf(refLibBuilt)`：import 成功 + 导出面符号）**）；`@aervox/api` 203 无回归。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。ADR-010 实施进展 6d/6e 已更新。

### 16.22 落地进展（阶段 3c+-B1：事件写入 fencing CAS）

2026-08-28 落地（对应 §3c+ 第一项「将 lease/fencing 校验扩展到每个事件写边界」与 §11.2「事件写入的 fencing 校验」前置关闭；工具结果/账本写入的 fencing 仍属 3c+ 后续项）：

- **数据库 CAS 写门**（`@aervox/database`）：`appendStreamEvent` 新增可选 `expectedFencingToken`；携带 `attemptId`+期望值时在 **BEGIN IMMEDIATE** 事务内对 `turn_attempts` 校验（fencing 一致 + 状态 Running/CancelRequested；终态仅放行收尾 `done`/`error`——适配 finalize-then-done 路径），失配抛 `FencingMismatchError`。单次写锁内校验+插入，无 SELECT→INSERT 抢占窗口。
- **Loop 语义收口**（`@aervox/agent-loop`）：新增 `LeaseLostError`；`executor.ts` 全部事件写入携带 claim fencing，catch 拦截 `LeaseLostError` → 收敛 `failed(lease_lost)` 且**不再产生任何新副作用**（§11.2）；`in-memory-store.ts` 同语义守卫 + `simulatePreemption` 钩子。
- **宿主/同步路径**（`@aervox/host-agent`、`apps/api`）：store 透传期望值并把 `FencingMismatchError` 转译为 `LeaseLostError`；`adapter-turn.ts` 携带 claim fencing；`failTurnWithError`（未 claim）携带 `expectedFencingToken=0`。
- 测试：`@aervox/database` 150（`event-fencing.test.ts` 5：正确通过 / 恢复器抢占（过期租约 fencing+1→Interrupted）后旧期望被拒且零污染 / attempt 不存在拒绝 / 终态仅 done 放行 / CancelRequested 可写）；`@aervox/agent-loop` 121（`executor-fencing.test.ts` 4：内存守卫 + 工具执行中被抢占 → `failed(lease_lost)`、无 tool_result/done/error 迟到事件、不写终态）；`@aervox/host-agent` 62（`sqlite-execution-store-fencing.test.ts` 3：桥接正确 / 失配转译 LeaseLostError / 未携带保持兼容）；`@aervox/api` 229 无回归；`mise tasks run ci-code`（17 tasks）+ check:boundary 零违规。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.23 落地进展（阶段 3c+-B2：长调用周期心跳续租）

2026-08-28 落地（对应 §11.2「长模型/工具调用期间由 Host 续租」「续租失败立即停止产生新副作用」）：

- **心跳器**（`packages/agent-loop/src/lease-heartbeat.ts` `LeaseHeartbeat`）：claim 后按固定间隔（默认 = 租约 TTL/2 = 30s）经既有 `renewAttemptLease` CAS 续租；`renew ok=false`（被抢占/恢复器已递增 fencing 或已终态）→ 判定 `lost` 并幂等单播订阅回调；传输/瞬时故障不判死（丢失必须以 CAS 语义为准），下一心跳重试。
- **executor 接线**（`executor.ts`）：`ExecuteTurnOptions` 增 `leaseTtlMs`（默认 60_000，与数据库层一致）/ `leaseHeartbeatIntervalMs`（默认 TTL/2，0 关闭）；claim 后启动、`try/finally` 兜底停止（无定时器泄漏、终态后不续租）；Provider 长流 chunk 间 `throwIfLost` 检查点；长工具调用注册 `onLost → AbortController.abort` 中止在途工具，且工具 catch 内 `heartbeat.lost` 直接收口 `lease_lost`（不写结果事件）。宿主零改动（复用 CAS 续租）。
- 效果：`ask_user_question`（最长 120s）等长调用不再因租约超时被恢复器误判为僵尸原地收敛；真被抢占时心跳探知后立即中止，与 B1 事件写入 fencing 双层兜底。
- 测试：`@aervox/agent-loop` 131（新增 `lease-heartbeat.test.ts` 5：单元 lost 判定/幂等多播/stop 后停更 + 集成——120ms 长工具调用期间续租 ≥3 且 Turn 正常完成 / 中途 `simulatePreemption`（fencing+1）→ 心跳续租失败 → 在途工具 abort → `failed(lease_lost)` 且无迟到事件/不写终态 / `leaseHeartbeatIntervalMs=0` 时仅 Step 首部探活）；`@aervox/database` 151、`@aervox/host-agent` 64、`@aervox/api` 230 无回归；`mise tasks run ci-code`（17 tasks）+ check:boundary 零违规。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.24 落地进展（阶段 3c+-B3：工具 replay 声明 + 未知结果三态政策 + 合成结果注入）

2026-08-28 落地（对应 §11.3 行 4/5「按工具 `replay: never/safe` 和幂等声明选择合成结果、人工确认或收敛」与 §3c+「unknown outcome 收敛和工具 replay 声明」关闭；人工确认路径留待后续基于 UQ-01 的恢复交互）：

- **数据面**（`@aervox/database`）：`tool_registrations.replay` 列（`safe`/`never`/NULL=未声明，fail-closed），新库建列 + 旧库 `addColumnIfMissing` 幂等补齐；`registerTool` 读写 replay；`listToolExecutionsByTurn` LEFT JOIN tool_registrations 返回 replay（恢复裁决数据面就绪）。
- **恢复裁决**（`resume.ts`）：`ResumeExecutionLike` 增 replay；批次聚合改为按 executionId 的 step 段归批（含同 Step 崩溃残留 `tool_request`——「工具意图已提交」边界，§11.3 行 5）；三态政策——批次含结果未确定（`pending`/`outcome_unknown`）且相关工具**全部**声明 `replay: safe` → 返回 `reason: "synthesized"` + 合成清单（`pending`→`not_started` / `outcome_unknown`→`outcome_unknown`）；`pending_approval` **永远收敛**（等待授权是业务语义，不可被合成绕过）；未声明 / `never` → fail-closed 收敛（保持原语义）。
- **恢复执行**（`sqlite-resume-source.ts`）：传入 replay；`synthesized` 时向重建上下文注入合成 tool 消息（`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` + executionId），指导续跑模型不再重复执行副作用后继续原 Attempt；**合成结果只进重建上下文，不写事件/账本**——事件流保持仅权威提交边界（§12.2）。
- **注册链路**（`apps/api`）：`POST /v1/tools` 支持 `replay` 枚举校验透传。
- 测试：`@aervox/database` 151（`tool-registry.test.ts` replay 存取矩阵）；`@aervox/agent-loop` 131（`resume-decision.test.ts` 6→11：synthesized 双形态 / 未声明与 never 收敛 / pending_approval 不绕过 / 多未确定项全 listing）；`@aervox/host-agent` 64（`sqlite-resume-source.test.ts` +2：replay:safe + pending → 产出含 TOOL_NOT_STARTED 合成 tool 消息；replay:never → 收敛不产出）；`@aervox/api` 230（tools-plugins replay 透传 + 非法 400）；`mise tasks run ci-code`（17 tasks）+ check:boundary 零违规。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.25 落地进展（阶段 3c+-B4：工具结果入口校验 + 流式可中断 + 模型调用重试）

2026-08-28 落地（对应 §9「工具结果进入模型前做大小、敏感数据、Prompt injection 和来源检查」、§10 `maxModelRetries`「仅首个可见片段前且无副作用」、§11.1「取消后丢弃失去 fencing 的迟到 chunk」的流式面）：

- **结果入口校验**（`tool-result-safe.ts` `inspectToolResult`）：工具输出回填上下文前做大小截断（默认 8000 字符，可配）+ Prompt injection 启发式（中英双语典型越权样本，保守匹配）。注入命中 → 以受控摘要 `blocked_tool_injection` 替代完整内容（fail-closed，样本不进模型）；超长 → 截断后回填。敏感数据分级/来源分类（DATA_PRIVACY/audit 体系）为后续扩展点。
- **流式可中断**（`executor.ts`）：Provider 流 chunk 间隙 ≥100ms 节流执行 `prematureTermination`（取消 / 删除撤权水位 / 总时长预算），命中即提前终止迭代收敛——流式期间用户取消/删除不再等整 Step 结束（§11.1 迟到 chunk 丢弃）。
- **模型调用重试**（`executor.ts` `ExecuteTurnOptions.maxModelRetries`，默认 1，0 关闭）：仅「首个可见片段前且无副作用」（首 Step 且 `textAccumulator` 为空）允许重试一次；已有 delta/事件、租约丢失（LeaseLostError/heartbeat.lost）一律不重试。
- 测试：`@aervox/agent-loop` 143（新增 `tool-result-safe.test.ts` 5：注入中英双语命中/超长截断/自定义上限/正常透传；`executor-b4.test.ts` 7：回填注入被摘要替代且原文不进上下文、超长截断回填、正常透传、首调用抛错自动重试一次完成、`maxModelRetries=0` 持续失败仅调一次、流式第二 chunk 前取消收敛且后续文本不产出）；`@aervox/database` 151、`@aervox/host-agent` 64、`@aervox/api` 232 无回归；`mise tasks run ci-code`（17 tasks）+ check:boundary 零违规。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.26 落地进展（阶段 3c+-B4-D：跨包原子写对）

2026-08-29 落地（对应 §12.2「ToolExecution 结果 + result event」「Turn 终态 + done」原子提交）：

- **Port 扩展**（`packages/agent-loop/src/ports.ts`）：`ExecutionStorePort` 新增 `recordToolOutcome`（工具结果账本收口 + tool_result 事件原子）与 `finalizeAttemptWithEvent`（终态 CAS + done/error 事件原子）；in-memory 实现同语义。
- **数据库原子事务**（`@aervox/database`）：`recordToolOutcomeAtomically` / `finalizeAttemptWithEventAtomically` —— BEGIN IMMEDIATE 内先做 fencing+状态守卫（前者守卫失败抛 `FencingMismatchError` 无部分写入；后者终态 CAS 失败返回 false 不写事件，杜绝孤儿 done/error）。
- **executor 接线**（`executor.ts`）：工具结果收口（executed/rejected/timeout_error/duplicate）改走 `recordToolOutcome`（duplicate 账本无预留行时插入独立记录）；5 处终态路径（Cancelled / Completed / Interrupted×2 / Failed(tools_disabled) / catch error+Failed）全部改走 `finalizeAttemptWithEvent`，CAS 失败按 contested 收敛。
- **宿主桥接**（`sqlite-execution-store.ts`）：转译 `FencingMismatchError`→`LeaseLostError`（与 appendEvent 同语义）。
- 测试：`@aervox/database` 154（新增 `atomic-write-pairs.test.ts` 3：同事务收口+事件 / fencing 失配抛错且无部分写入 / 终态+done 同事务且二次提交 false 不写第二个 done）；`@aervox/agent-loop` 143 无回归（cancel 终态竞态用例改 override `finalizeAttemptWithEvent`；duplicate 账本独立留痕保持）；`@aervox/host-agent` 65（`sqlite-execution-store-fencing.test.ts` +2：原子桥接 + 转译 + CAS false）；`mise tasks run ci-code`（17 tasks）+ check:boundary 零违规。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.27 落地进展（阶段 3c+-E：授权快照幂等 + 安全片段/Draft 原子化）

2026-08-29 落地（对应 §12.2「ToolInvocation + 授权快照 + 幂等预留」「安全片段 + TurnStreamEvent + Draft prefix」）：

- **授权快照幂等**（`@aervox/database` `recordToolApproval`）：同 `(toolName, argumentsHash)` 已存在 `pending` 授权则复用既有行，不重复插入——授权匹配键跨 turn 复用（schema 约定），重复写工具意图不产生多行待决授权；`granted/denied` 后新请求才新建。
- **安全片段表**（`@aervox/database` `schema/safe-segments.ts` `safe_segments`）：`turn_id`/`attempt_id`/`sequence`/`text`/`committed`(0|1 可见前缀)/`stream_event_id`（关联 turn_stream_events）+ 租户列，`(turn_id, sequence)` 唯一；init 建表与索引。
- **原子提交**（`recordSafeSegmentAtomically`）：BEGIN IMMEDIATE 内 fencing+状态守卫（同 appendEvent fenced 语义）→ 同事务插入 safe_segments（committed=1）与 delta 事件并回填事件关联，崩溃不把片段与事件拆散；守卫失配抛 `FencingMismatchError` 无部分写入。`listCommittedSegments` 按 sequence 升序返回可见前缀（中断恢复/可见前缀重建）。
- **executor 接入**（`executor.ts`）：两处 delta 写入（无工具 isFinal / 有工具 isFinal:false）改走 `recordSafeSegment` 原子提交——每个可见片段与其事件同生共死；`ports.ts` 增 `recordSafeSegment`/可选 `listCommittedSegments`；in-memory 同语义 + `safeSegments` 断言钩子；host-agent store 委托 + `FencingMismatchError`→`LeaseLostError` 转译。
- 测试：`@aervox/database` 160（新增 `segment-approval.test.ts` 6：E1 幂等复用/不同 hash 新建/已决后新请求新建；E2 同事务写入+事件关联 / fencing 失配无部分写入 / 可见前缀升序）；`@aervox/agent-loop` 143 无回归；`@aervox/host-agent` 65（fencing 桥接 +1 recordSafeSegment 原子+可见前缀+失配转译）；`@aervox/api` 230 无回归；`mise tasks run ci-code`（17 tasks）+ check:boundary 零违规。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.28 落地进展（CR-022：Turn 级完全访问）

2026-08-29 落地（对应 §9 工具审批决策）：

- **契约与快照**：`CreateTurnRequest.toolApprovalMode = ask | full_access`，缺省 `ask`；API `preValidation` 将已解析值绑定到本请求租户上下文，不修改冻结中的对话路由。
- **自动授权与审计**：完全访问下，`write_with_approval` 以 `tool_approvals` pending→granted 记录本次快照后才执行；`decidedBy=permission:full_access:<actor>` 区分自动授权，显式授权查询排除该前缀，关闭后同参数不会继续放行。
- **统一写工具门**：动态 ToolRuntime 与静态 Subagent/Workflow Contribution 共用授权语义；普通 Turn 的 `privileged` 仍收敛到管理员审批通道，CAP-033 的全动作授权通过同一门的独立 `FullProfileActionGrant` 分支校验（当前仅完成契约骨架，执行分支待专项实现）。
- **双端交互**：共享 Workbench 输入区显示权限开关；开启必须经风险说明和显式勾选，运行中锁定，状态仅保留在当前浏览器/桌面会话；Web fetch 与 Electron IPC 传递同一字段。
- **测试**：`conversation-approval.test.ts` 覆盖默认待决、自动执行与关闭后不泄漏；`conversation-privileged.test.ts` 覆盖普通 Turn 管理员门；`tool-approval-policy.test.ts` 覆盖静态 Contribution 工具；API Client `transport.test.ts` 覆盖 `full_access` 请求体透传。CAP-033 的 Host/数据面专项授权、来源、保留和动作测试尚待补齐。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.24 落地进展（阶段 CAP-033：主动智能本地数据面与动作授权）

2026-08-29 已落地部分路径：独立加密本地 Vault、owner-only `proactive-access.token`（`0600`）与字面 loopback/redirect 拒绝、版本化 ProfileRevision/SourceGrant/ActivationLease、`FullProfileActionGrant` 工具门、Aervox activity/operation 与剪贴板采集、确定性本地提炼 Worker、来源级撤销删除、导出和后台 heartbeat。系统应用、浏览器、屏幕、文件、通信、音视频、位置和传感器适配器仍未全部接入；本地 Provider 出网证明、生产 OS Broker、全量删除传播和专项门禁继续阻断 CAP-033 的 `Ready`。

验证证据：`@aervox/database` 162 tests、`@aervox/api` 241 tests、`@aervox/worker` 6 tests、Contracts OpenAPI build 已通过；完整端到端和平台权限矩阵待补齐。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

### 16.29 落地进展（阶段 6f：AERVOX_LOOP_DRIVER=dsh API 接线）

2026-08-31 落地（承接 §16.21 骨架，把 DSH Adapter 从「仅测试消费」推进到 API 组合根可开关；ADR-010 实施进展 6f 同步）：

- **配置**（`packages/config`）：`ApiLoopDriver = "native" | "dsh"`（`AERVOX_LOOP_DRIVER`，默认 native，启动期枚举校验；pi 为保留项不进枚举，配置期 fail-fast 防静默无效果）；
- **解析器**（`apps/api/src/modules/conversation/dsh-adapter.ts`）：`resolveDshTurnAdapter` lazy 单例——缓存已准入 stdio handle（逐 Turn ping-pong 复用，不重复 spawn）与 probe 禁用态（后续 Turn 快速失败）；repoRoot 取 `AERVOX_DSH_REPO_ROOT`，缺省从 cwd 向上查找 `reference/deepseek-harness`；准入即 `probeDSHReference`（gitlink 固定 SHA + MIT），未就绪不 spawn；
- **接线**（`apps/api/src/modules/conversation/agent-executor.ts`）：`runLoopTurnOnce` dsh 分支 → `runDshAdapterTurn` → `runAdapterTurn` 整 Turn 执行（claim → 事件映射既有契约落库 → finalize；Provider/工具/上下文组合全部跳过）；终态对齐 turns 表（Completed/Interrupted/Failed 回写，skipped 不覆盖）；准入失败 fail-closed（`ADAPTER_UNAVAILABLE` error 事件 + Failed，不静默回退 native）；专注模式 terms 抽取抽为 `extractStudyTerms` 供原生与 adapter 双路径复用；
- **测试**：`apps/api/test/conversation-dsh.test.ts` 4（准入失败 fail-closed 不回退 native / 禁用态缓存快速失败 / resolver `submodule_missing` reason / `it.runIf` 子模块就绪 + 本地兼容端点整 Turn message→delta→done Completed 机器验证）；`@aervox/config` 6（loopDriver 缺省/覆盖/pi·bogus fail-fast）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。
