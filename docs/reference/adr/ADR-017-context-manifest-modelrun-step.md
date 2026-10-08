---
id: ADR-017
type: reference
scope: decision
owner: maintainers
doc_status: review-candidate
decision_status: accepted
version: 0.3.0
updated_at: 2026-10-08
reviewed_at: 2026-10-08
review_interval_days: 90
---

# ADR-017 冻结 ContextManifest / ModelRun / AgentStep 关联与 Inbox 数据模型

决策已接受，经 CR-030 对齐本地单用户边界。`Accepted` 不表示完整实现或 G2 发布门禁通过；当前实现与差量见[验证入口](#verification-evidence)，发布状态以[追踪基线](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)为准。

关联：[Agent Loop 的 Context 与 Inbox](../agent-harness-loop.md#7-context-与收件箱)、[ADR-005](ADR-005-provider-port.md)、[ADR-016](ADR-016-base-boundaries.md)、[ADR-021](ADR-021-aervox-core-standalone-package.md)、CAP-002/007、NFR-DATA。

## Context

**提案时背景（2026-08-28）**：ModelRun 与 ContextManifest 当时只有通用记录，缺少 Attempt/Step 关联；Inbox 已定义 followup/steer/inject 语义，尚无持久化消费链。该背景解释为何冻结关联基数，不表示今天仍无这些实现。当前内核为 `packages/core`，Schema 与 Repository 分属 `packages/schema`、`packages/repositories`；不得恢复已退役的 `packages/database` 或 `packages/agent-loop` 包。

## Decision drivers

- **可追溯性**：模型调用、来源清单、Step 与 Inbox 必须能追溯到 Session、Attempt、适用 Step 及来源/授权修订，使恢复、巡检、删除和撤权能按粒度 fail closed。
- **唯一父级**：一次精确模型请求对应一份 Manifest；同 Step 的重试不能共用不变的请求身份或错配来源。
- **持久消费**：Inbox 的来源、幂等键、目标和状态不可只存在内存；claim/ack 必须支持崩溃后的安全重放。
- **扩展边界**：Inbox 经 ContextBuilder 追加输入，压缩/Skill/Subagent 经扩展点接入，不另写 Loop 或改写已提交事件。

## Considered options

| 选项 | 结论 |
|---|---|
| 模糊地“按 Step/ModelRun 固化” | 拒绝：不能确定一份来源清单对应哪次模型请求 |
| ModelRun 与 Manifest 各自关联 Step | 拒绝：Step 可含重试，两个直接父级无法保证请求与来源一一对应 |
| ModelRun 关联 Step，Manifest 只关联 ModelRun | 采用：调用、来源、Attempt 严格单父追踪 |

<a id="inbox-数据模型选项阶段-5a"></a>

Inbox 采用独立 `agent_inbox_items` 表与仓储：全内存实现无法满足恢复要求，直接复用 Session 日志又会让外部输入越权改写 TurnStreamEvent，均不采用。

## Decision

以下为已接受合同；当前部分实现不能降低这些要求。

### 关联链（单父严格下溯）

```text
TurnAttempt
  └─ AgentStep             一次模型请求及工具结果闭环，序号单调
       └─ ModelRun          一次精确 Provider 调用，每次重试新建
            └─ ContextManifest  本次调用的不可变来源清单
```

- `ModelRun` 的唯一父级为 AgentStep；每 Step 至少一条，重试产生新记录；以 `attemptId`、`stepId` 定位所属 Step。
- `ContextManifest` 的唯一父级为 ModelRun；每次 ModelRun 对应一份不可变 Manifest，多来源用多个条目表达。仅保存 `modelRunId`，不重复保存可由父级推导的 attemptId/stepId。
- AgentStep 的唯一父级为 TurnAttempt；`stepId` 在 Attempt 内单调递增，执行身份由 attemptId 与 stepId 派生。

<a id="agentinboxitem新增-agent_inbox_items-表"></a>

### AgentInboxItem

目标数据合同保留以下身份与消费语义；当前物理字段以 [Schema](../../../packages/schema/src/agent-inbox.ts) 和 [Repository Port](../../../packages/repositories/src/repositories/types/agent-inbox.ts)为机器真源，缺失字段仍是实现差量：

- `id` 为 UUID 幂等身份；Session、来源 actor、来源/授权修订与用途绑定不可变；`payload` 保存受限内容及来源标注。
- `type` 为 `followup` / `steer` / `inject`；`consumeBoundary` 为 `next-turn` / `next-step`，后者通过 attemptId/stepId 定位，前者不绑定当前 Step。
- 同一目标边界以 `orderingSeq` 排序；状态为 `pending` / `claimed` / `acknowledged` / `expired`，记录 claimedAt/ackedAt/expiresAt。
- 消费采用 claim/ack；claimed 后崩溃可安全重放，steer 只影响下一 Step 输入，不得改写已提交事件，expiresAt 负责过期回收。
- Schema 属 `@aervox/schema`，仓储和迁移属 `@aervox/repositories`；Core 只消费 Port，不导入数据库。外部插件只提交受限 inbox command，不能直接写表。

## Positive consequences

单父链允许按 Attempt/Step 定位请求、来源与删除影响；独立 Inbox 保持 Session 事件不可由外部贡献体直接改写，高级能力仍从受控扩展点接入。

## Negative consequences and risks

关联字段、独立 Step 与完整 Manifest 需要迁移和故障测试；仅增加列或记录一份 Turn 快照不能证明请求级来源链完整。历史记录缺少关联时不得伪造回填；Adapter、Port 与仓储的边界需要持续机器校验。

## Migration / rollback

- 兼容前向迁移为 `model_runs` 增加可空 attemptId/stepId，不立即回填；初始化必须幂等。Manifest 通过 modelRunId 关联，不增加第二份父级身份。
- 历史字段为空时保留“未知”语义；后续回填须有可核验来源，不能因迁移方便制造关联。
- 回滚旧代码可忽略兼容新增字段，但必须保留已提交 ModelRun、Manifest 与 Inbox 数据；不得借回滚删除来源或改变 modelRunId 关系。删列、改关联或删除记录按[数据库迁移与回滚合同](../DATABASE.md#9-cr-030-破坏性迁移)评审和验证。

<a id="实施进展2026-08-28阶段-7"></a>
<a id="验收差距复核2026-08-31"></a>

## Verification evidence

- 已有 ModelRun attemptId/stepId、Manifest 快照和 Inbox 表/消费链；实现见 [Platform Schema](../../../packages/schema/src/platform.ts)、[Core executor](../../../packages/core/src/executor.ts)、[API sink](../../../apps/api/src/modules/companion/conversation/agent-executor.ts) 与 [Inbox API](../../../apps/api/src/modules/companion/inbox/routes.ts)。
- 当前 ModelRun 在成功返回的 Step 后尽力写入，Manifest 仅首 Step 记录 `turn:history` 快照；失败/重试独立身份、每次请求来源条目与独立 AgentStep 尚未完整兑现，不能据此宣布本 ADR 全部验收完成。
- 回归入口：[context-manifest](../../../packages/core/test/context-manifest.test.ts)、[platform-modelrun](../../../packages/repositories/test/platform-modelrun.test.ts)、[agent-inbox](../../../packages/repositories/test/agent-inbox.test.ts)、[Inbox API](../../../apps/api/test/inbox-routes.test.ts)。测试存在不等于本次已运行或覆盖完整目标。
- 依赖边界由 [`import-boundary.mjs`](../../../scripts/import-boundary.mjs)守卫；恢复、删除/撤权、请求级关联与 G2 门禁须有独立证据。后续排序只在根 [plan.md](../../../plan.md)维护。
