# Agent Harness Loop 设计与落地规范

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

> 文档编号：AVX-HAR-001  
> 类型：Reference  
> 版本：v0.3
> 更新日期：2026-08-28  
> 状态：Review Candidate  
> 关联：[能力组合与可选化目录规范](capability-composition.md)、[架构设计](ARCHITECTURE.md)、[流式协议](STREAMING_PROTOCOL.md)、[ADR-004](adr/ADR-004-outbox-idempotent-jobs.md)、[ADR-005](adr/ADR-005-provider-port.md)、[ADR-009](adr/ADR-009-electron-plugin-sandbox.md)、[ADR-010](adr/ADR-010-dsh-pi-adapters.md)、[ADR-012](adr/ADR-012-streaming-safety-persistence.md)、[CR-012](changes/CR-012-agent-harness-loop.md)、[需求追踪基线](REQUIREMENTS_TRACEABILITY.md)

本文规定 Aervox Agent Harness Loop 的职责、状态机、Port、持久化边界、工具执行、取消恢复和分阶段落地路线。当前阶段 0/1/2a-2e/3a/3b-A/3b-B 已有原生实现：`packages/agent-loop` 提供 Replay/Scripted/真实 OpenAI 兼容 Provider、多 Step 工具循环、API/SSE 持久化、工具账本、写工具审批、lease TTL/续租、过期抢占、fencing 单一终态和 Worker 恢复；3c+ 生产级安全补强、完整 Inbox/ContextManifest 关联、独立 Host 以及 DSH/pi Adapter 仍是后续目标。文中标为“目标”的接口、表和状态转换，只有在对应代码、迁移和契约测试落地后才可视为运行能力。

## 1. 范围与非目标

Agent Harness Loop 是驱动一次 Agent Turn 的执行能力：它领取已持久化 Turn，组装上下文，通过 Model Provider 取得模型输出，处理模型文本和工具请求，提交安全事件，并根据终止策略继续下一 Step 或结束 Turn。

本文覆盖：

- Agent、Turn、Attempt、Step、ModelRun 和 ToolExecution 的执行关系；
- 输入安全、上下文组装、模型调用、工具权限、结果回填和终止判断；
- 流式持久化、取消、重试、租约、fencing、恢复和可观测性；
- 原生 Loop Driver 与 DSH/pi Adapter 的替换边界，以及 Model Provider 的调用边界；
- 从迁移期 API 内嵌 Loop 逐步演进到异步、可替换和可恢复的完整 Loop 的阶段计划。

本文不覆盖：

- 具体模型供应商 SDK；它们由 `ModelProviderPort` Adapter 实现；
- 单个工具的业务规则；工具 Owner 通过 Tool Port 提供实现；
- Worker 的复习、日记、删除等周期任务；它们属于 Job Handler，不属于 Agent Harness Loop；
- DSH 或 pi 的 Session 格式、权限模型和持久化格式；外部运行时只能通过 Adapter 提供 Loop Driver、Model Provider 或受限 Contribution。

## 2. 当前现状与缺口

### 2.1 已有构件

| 构件 | 当前实现 | 可复用边界 |
|---|---|---|
| Turn 创建 | `apps/api/src/modules/conversation/routes.ts`；Outbox 兼容事件为 `turn.created` | 已有幂等创建 Turn、Message 和 Outbox，并创建 Attempt；目标 `agent.turn.requested` 仍需迁移期双读映射 |
| TurnAttempt | `turn_attempts` schema 与仓储 | 已落地 `leaseExpiresAt`、claim/renew/recover、CAS/fencing 单一终态；事件和工具写入的 fencing 绑定、Step 持久化仍待后续阶段 |
| TurnStreamEvent | `turn_stream_events` schema、append/list 仓储与 SSE 路由 | 已接收 attempt/safetyDecision 并从持久化事件重放；完整安全分段和更高水位订阅仍需增强 |
| ModelProviderPort | `packages/agent-loop` + API 接线 | Replay/Scripted 与 OpenAI 兼容流已可用；`llm` 模式从 LLM 配置构造真实 Provider，Provider 仍由迁移期 API 组合根选择，独立 Host/多 Provider Resolver 待后续阶段 |
| ToolRuntime | `apps/api/src/modules/tools/runtime.ts` + `createRuntimeToolProvider` | 只读白名单、写工具授权、工具结果账本和 fail-closed 已由模型输出驱动；并行度、幂等预留和完整沙箱仍规划中 |
| ModelRun/ContextManifest | `model_runs`、`context_manifests` schema 与通用 CRUD | 目前仍是通用记录，未接入每个 Turn/Attempt/Step；需 ADR 冻结 `stepId`/`attemptId` 关联和 cardinality |
| Worker loop | `apps/worker/src/index.ts` + `attempt-recovery.ts` | 已接入过期 Attempt 恢复 cycle（3b-B）；尚未由 Worker 消费 `agent.turn.requested` 驱动异步 Loop（当前 API 迁移期同步执行） |
| Pipeline | `apps/worker/src/pipeline.ts` | 已定义显式顺序与短路 helper，但不直接承担 Agent Step |

### 2.2 当前缺口

当前 API 已可通过 `AERVOX_LOOP_PROVIDER=replay|scripted|scripted-write|llm` 执行原生 Loop，SSE 从持久化 `turn_stream_events` 重放；阶段 2e/3a/3b-A/3b-B 已覆盖真实 OpenAI 兼容流、写工具审批、lease TTL/续租、过期抢占、fencing 和 Worker 恢复。仍缺少异步 Outbox 驱动、完整分段安全门、Step/ModelRun/ContextManifest 持久化关联、Inbox、3c+ 生产级副作用恢复和外部 DSH/pi Driver；客户端 `for (;;)`/`while (true)` 只读取 SSE，不是 Agent Loop。

仍需补齐的核心能力包括：

1. 异步 Outbox 驱动和独立可扩展的 `LoopDriverPort`；
2. 按 Step 持久化 Prompt、ContextManifest、ModelRun 和 AgentStep；
3. 完整分段安全门、取消传播、预算与背压；
4. Tool 并行/幂等预留、沙箱和结果安全校验；
5. follow-up、steer 和 context injection 的受控收件箱；
6. DSH/pi 进程外 Adapter、Provider parity 和迁移回放。

## 3. 在能力组合模型中的位置

Agent Harness Loop 是 Profile 可选择的业务执行 Capability，不属于不可关闭的 Kernel Substrate。Profile 可以选择一个 Loop Driver 实现：

- Aervox 原生 `native-agent-loop` Driver；
- `adapter-dsh` 暴露的 DSH Loop Driver；
- `adapter-pi` 暴露的 pi Loop Driver；
- 测试使用的 `replay-agent-loop` Driver。

Resolver 不变量：对话能力一旦启用，且某个 Turn 需要执行模型—工具流程，Profile 必须且只能解析出一个兼容的 `LoopDriverPort`。可以不安装 DSH 或 pi，但不能出现“有 Conversation 能力却没有 Native/Replay/其他 Loop Driver”，也不能同时激活两个竞争性的 Driver。模型 Provider 可以有多个候选，但每个 Step 最终只能绑定一个已解析的 Model Provider。

当前实现尚未落地 Profile Resolver，而是通过 `AERVOX_LOOP_PROVIDER` 在 API 组合根选择 Replay、Scripted 或 OpenAI 兼容 Provider；该环境变量开关是迁移机制，不是最终的 Loop Driver 组合模型。

无论选择哪一种 Driver，以下 Kernel 不变量不变：

- Aervox Turn/Message/学习数据是业务真源；
- Policy/Consent 决定有效权限；
- TurnAttempt、TurnStreamEvent、ModelRun、工具副作用和审计必须进入 Aervox 持久层；
- 外部 Loop 不得直接写核心数据库；
- 删除、撤权和恢复遵循 Aervox Data Rights 与 RecoveryControlLedger；
- 客户端只消费 Aervox Turn/SSE 契约，不感知具体 Loop Driver 或 Model Provider。

目标依赖方向：

```text
API Turn Consumer
       │ persist + wake
       ▼
AgentLoop Definition ──> LoopDriverPort <── Native / DSH / pi / Replay Driver
                              │
       ├──────────────────────┼── ModelProviderPort
       ├──────────────────────┼── ContextBuilderPort
       ├──────────────────────┼── ToolRegistryPort + ToolPolicyPort
       ├──────────────────────┼── TurnExecutionStorePort
       ├──────────────────────┼── SafetyValidationPort
       └──────────────────────┴── AgentEventPort
```

## 4. 核心对象

| 对象 | 责任 | 持久化要求 |
|---|---|---|
| `AgentInstance` | 一个可接收 Turn/inbox 的逻辑 Agent 身份 | 可由 Profile/Persona 派生；不能替代用户或租户身份 |
| `Turn` | 一次用户可观察请求—响应边界 | 已有业务表；当前没有 revision/CAS 字段，目标是终态唯一 |
| `TurnAttempt` | Turn 的一次可领取执行尝试 | 已有 schema/仓储与 3b-A/3b-B claim/renew/recover 基础；目标是所有写边界都绑定有效 lease/fencing token |
| `AgentStep` | Attempt 中的一次模型请求及其工具结果闭环 | 新增；Step 序号单调，记录起止和终止原因 |
| `ModelRun` | 一次精确 Provider 调用 | 已有通用 schema/CRUD；目标是每 Step 至少一个，重试产生新 ModelRun，并关联 TurnAttempt/AgentStep |
| `ContextManifest` | 本次模型调用实际使用的来源清单 | 已有通用 schema/CRUD；当前仅以 `modelRunId` 关联且 Loop 尚未写入，目标粒度与 `stepId`/`attemptId` 需由 ADR/迁移冻结 |
| `ToolInvocation` | 模型提出的一次规范化工具请求 | 目标实体；当前只有 `tool_request` 事件和 invocationId，尚未持久化 schemaVersion、参数 hash 与授权快照 |
| `ToolExecution` | 一次受控工具执行尝试 | 已有阶段 2d 最小 `tool_executions` 账本；目标是补齐幂等键、资源用量、replay 声明和未知结果状态 |
| `AgentInboxItem` | follow-up、steer 或 context injection | 新增；有目标边界、顺序、来源、状态和过期时间 |
| `TurnStreamEvent` | 客户端可重放事件 | 已有 schema、仓储和 SSE 重放接线；目标是只能在真实安全检查和事务提交后发送，并在所有写入上校验 fencing |

`AgentStep`、`ToolInvocation` 和 `AgentInboxItem` 仍是目标实体；`ToolExecution` 已有阶段 2d 最小账本，但仍需通过 CR/数据库 Expand/Contract 迁移补齐目标状态和字段。关键恢复状态不能只存在于内存日志。

## 5. Loop 状态机

### 5.1 Attempt 状态

```text
Pending
  -> Claimed
  -> InputChecking
  -> ContextBuilding
  -> Running
  -> Finalizing
  -> Completed

Claimed/InputChecking/ContextBuilding/Running/Finalizing
  -> CancelRequested -> Cancelled
  -> Interrupted
  -> Failed
  -> LeaseExpired
```

只有持有当前 lease 和 fencing token 的执行器可以追加 Step、TurnStreamEvent、ToolExecution 或提交终态。`LeaseExpired` 的旧执行器即使随后收到 Provider/Tool 结果，也必须丢弃结果并记录诊断，不能推进 Turn。这是目标不变量；当前 3b-B 已在 Step 首部用续租探活，并在 Attempt 终态提交时校验 fencing，但 TurnStreamEvent 和 ToolExecution 的每次写入尚未携带 expected fencing，须在 3c+ 补齐。

### 5.2 Step 状态

```text
Preparing
  -> ModelStreaming
  -> Validating
  -> ToolPlanning
  -> ToolExecuting
  -> ResultInjecting
  -> Continue | Concluded

Any active state
  -> Blocked | Cancelled | Failed | TimedOut
```

一次 Step 可以包含零个或多个 ToolInvocation。没有工具请求且通过最终检查时 `Concluded`；有工具结果需要模型继续判断时进入下一 Step。

### 5.3 Turn 终止原因

| 原因 | Turn 映射 | 规则 |
|---|---|---|
| `completed` | `Completed` | 模型返回最终可发布内容，或终端工具明确 conclude |
| `blocked` | `Rejected` | 输入、权限或安全策略拒绝 |
| `cancelled` | `Cancelled` | 用户取消且终态 CAS 获胜 |
| `visible-prefix-interrupted` | `Interrupted` | 已提交安全片段后基础设施中断 |
| `failed-before-visible` | `Failed` | 未产生可发布片段且无法安全恢复 |
| `max-steps` | `Interrupted` 或 `Failed` | 有安全前缀则 Interrupted，否则 Failed；不得伪装 Completed |
| `budget-exhausted` | `Interrupted` 或 `Failed` | 同上，并记录预算维度 |
| `max-tokens` | `Interrupted` 或 `Failed` | 不自动把截断结果当完整答案 |

## 6. 单次 Turn 执行算法

```text
1. claim TurnAttempt lease/fencing
2. validate tenant, consent, input safety and current deny watermark
3. claim inbox items for this Turn/Step
4. assemble Prompt sections, ContextManifest and visible Tool schemas
5. persist AgentStep start + ModelRun + request header
6. stream Provider output into bounded assembler
7. for each semantic segment:
     validate safety/structure
     persist TurnStreamEvent + draft prefix
     publish committed event
8. normalize tool calls
9. for each tool call:
     resolve Tool definition
     intersect Manifest permission, consent and ToolPolicy
     persist ToolInvocation and approval decision
     execute with timeout/idempotency/cancellation
     persist ToolExecution and result event
10. if tool results require continuation:
      append bounded result context
      continue next Step
11. otherwise run final integrity validation
12. commit Turn terminal state + done event + Outbox
13. release lease and emit audit/metrics
```

伪代码：

```ts
async function executeTurn(command: ExecuteTurnCommand): Promise<TurnOutcome> {
  const attempt = await store.claimAttempt(command.turnId, command.workerId);
  try {
    for (let stepNo = 1; stepNo <= policy.maxSteps; stepNo += 1) {
      attempt.assertLease();
      const prepared = await prepareStep(attempt, stepNo);
      const modelResult = await runModelStep(prepared);
      const toolPlan = await normalizeAndAuthorizeTools(modelResult);

      if (toolPlan.length === 0) {
        return await finalizeCompleted(attempt, modelResult);
      }

      const results = await executeTools(toolPlan, attempt.signal);
      // 终止语义由 Aervox 策略统一决定，Adapter 不得泄漏上游 any/every 语义。
      if (shouldConcludeToolBatch(results, policy.toolBatchTermination)) {
        return await finalizeCompleted(attempt, results);
      }
      await injectToolResults(attempt, results);
    }
    return await finalizeLimitReached(attempt, "max-steps");
  } catch (error) {
    return await containFailure(attempt, error);
  } finally {
    await store.releaseAttempt(attempt);
  }
}

function shouldConcludeToolBatch(
  results: ToolResult[],
  mode: "all-results-conclude",
): boolean {
  return mode === "all-results-conclude"
    && results.length > 0
    && results.every((result) => result.concludesTurn === true);
}
```

该伪代码只表达目标控制流；`all-results-conclude` 是 Aervox 第一版策略：批次必须非空，所有已启动工具都要完成并提交确定结果，且每个结果都声明终止，才可结束 Turn；空批次和混合批次都继续下一 Step。当前阶段 2d/3a 实现尚未提供 `concludesTurn` 字段，因此实际会继续下一 Step 或命中 `maxSteps`。真实实现必须在每个持久化边界比较 Turn revision、lease 和 fencing token。

## 7. Context 与收件箱

### 7.1 Context 组装

`ContextBuilderPort` 按以下顺序生成 Step 输入：

1. 固定系统安全与产品边界；
2. 当前 Profile、Persona 和 purpose 配置；
3. 当前 Session/Turn 的安全历史；
4. 已授权记忆、学习事实、Skill 和外部来源；
5. 本 Step 可见工具 schema；
6. 上一 Step 的规范化工具结果；
7. 当前可消费 inbox item。

每个来源必须进入 ContextManifest，记录来源 ID/版本、purpose、权限快照、截断/压缩方式和内容 hash。原始 Restricted 内容默认不进入日志。目标模型是“一次 ModelRun 对应一个不可变 Manifest，多个来源对应多行 manifest entries”；当前表通过 `modelRunId` 间接表达该关系，没有 `stepId`/`attemptId`，且当前 Loop 尚未创建 ModelRun/Manifest 记录，因此在 ADR/数据库迁移中必须冻结是否新增这两个关联字段（推荐新增 `attemptId`、`stepId`，并以 ModelRun 作为唯一父级），以及每个 Step/ModelRun 的 cardinality，不能继续用“按 Step/ModelRun 固化”这一含糊表述。

### 7.2 AgentInboxItem

| 类型 | 语义 | 是否唤醒 | 消费边界 |
|---|---|---:|---|
| `followup` | 排队为当前 Turn 结束后的新 Turn 输入 | 是 | `next-turn` |
| `steer` | 修改当前执行的下一 Step 输入 | 是 | `next-step`；不能改写已提交事件 |
| `inject` | 添加下一次模型请求可见的上下文 | 否 | `next-step` 或 `next-turn` |

所有 inbox item 必须绑定 `(workspaceId, subjectUserId, sessionId)`、来源 actor、幂等键和状态；消费采用 claim/ack，崩溃后可以安全重放。外部插件不能直接修改 Session 日志，只能提交受限 inbox command。

## 8. Provider 调用

`ModelProviderPort` 只负责一次模型调用，不负责 Turn 状态机、工具调度或终态提交。当前实现的最小接口是 `stream(request)`；目标接口可增加准备阶段：

```ts
interface ModelProviderPort {
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
}
```

完整的执行控制流由 `LoopDriverPort` 提供。它负责 claim/lease、Step 与工具循环、取消/恢复和事件投影，并只能通过上面的 Model Provider 和其它 Port 访问外部能力：

```ts
interface LoopDriverPort {
  executeTurn(command: ExecuteTurnCommand, signal: AbortSignal): Promise<TurnOutcome>;
  cancelTurn(command: CancelTurnCommand): Promise<CancelOutcome>;
  recoverAttempt(command: RecoverAttemptCommand): Promise<RecoveryOutcome>;
}
```

`AgentLoopDefinition` 绑定一个 `LoopDriverPort`，再由 Driver 解析一个 `ModelProviderPort`。当前 `executeTurn()` 是 Native Driver 的过渡形态，尚未实现完整 `LoopDriverPort`。DSH/pi Adapter 必须在 Manifest 中声明自己提供的是完整 Loop Driver、Model Provider 还是受限 Contribution，以及终止、取消和恢复语义的兼容等级；不能仅凭“Provider”名称推断其职责。

Loop 必须在调用前固化 Provider、model、PromptVersion、ContextManifest、Tool schema、reasoning 配置和预算。一次重试创建新的 ModelRun，但仍属于同一 AgentStep；只有尚未持久化用户可见片段且没有工具副作用时才允许自动重试。

Provider chunk 先进入有界 assembler，不得直接写 HTTP、日志或 Message。文本、结构化输出、tool-call、usage 和 finish reason 必须被规范化为 Aervox 类型。

## 9. 工具执行管线

工具执行顺序固定为：

```text
resolve definition
  -> schema validate
  -> capability/profile gating
  -> tenant/consent/purpose policy
  -> approval decision
  -> idempotency reservation
  -> timeout/quota/sandbox execution
  -> result safety/size validation
  -> persist authoritative result
  -> inject bounded model context
```

规则：

- 模型请求工具不等于授权；
- `read_only` 可以按已批准策略自动执行；
- `write_with_approval` 必须绑定可审计授权快照；
- `privileged` 默认拒绝，只能由单独管理员通道放行；
- 写工具按业务资源/Session 串行；相互独立的只读工具可以受限并行；
- 幂等键建议为 `attemptId:stepNo:callId`，上游 callId 不可信时由 Host 重新生成；
- 非幂等副作用失败不自动重试；
- 工具结果进入模型前做大小、敏感数据、Prompt injection 和来源检查；
- 终端工具可以返回 `concludesTurn=true`，但不能绕过最终持久化和安全检查；
- Aervox 的批次终止契约是“非空且所有已完成结果均 `concludesTurn=true`”；混合批次继续下一 Step，且所有已经启动的工具都必须先产生并提交确定结果。

## 10. 限额与终止策略

以下是第一版建议基线，最终数值需通过 ADR/压测冻结：

| 限额 | 建议初值 | 触发行为 |
|---|---:|---|
| `maxSteps` | 8 | 安全结束为 Interrupted/Failed |
| `maxTurnDurationMs` | 120000 | 请求取消 Provider/Tool，按可见前缀收敛 |
| `maxParallelReadTools` | 4 | 超出排队；写工具仍串行 |
| `maxToolDurationMs` | 30000 | ToolExecution TimedOut |
| `maxModelRetries` | 1 | 仅首个可见片段前且无副作用 |
| `maxConsecutiveSameTool` | 3 | 阻断循环并记录 repeat-tool 诊断 |
| `maxInboxItemsPerStep` | 20 | 多余项留待后续 Step/Turn |

预算可以按 token、费用、时间、工具调用次数和并发分别限制。任何限额触发都必须写入 Attempt/Step 终止原因和审计，不得只输出一条自然语言提示。

## 11. 取消、租约与恢复

### 11.1 取消

- 用户取消通过 Turn CAS 写入 `CancelRequested`；
- Loop 每次 Provider chunk、工具调用前后和事务提交前检查取消与 fencing；
- Provider/Tool abort 是 best effort，已完成副作用不能承诺撤销；
- `Finalizing` 与 `CancelRequested` 的胜者由先提交的 CAS 决定；
- 取消后丢弃失去 fencing 的迟到 chunk/result。

### 11.2 租约

- `TurnAttempt` claim 产生 `leaseId`、`fencingToken` 和 `leaseExpiresAt`；
- 长模型/工具调用期间由 Host 续租；
- 续租失败立即停止产生新副作用；
- 恢复器只领取未终态且 lease 过期的 Attempt；
- 同 Session 的写入结合 SessionLock 和数据库 CAS，避免两个 Turn 修改同一事实。

当前 3b-A/3b-B 已实现 claim TTL、Step 首部续租探活、过期抢占、Worker 收敛和 Attempt 终态 fencing；长时间 Provider/Tool 调用期间的周期心跳，以及事件/工具写入的 fencing 校验仍属于 3c+。

### 11.3 恢复

恢复器根据最后已提交边界决定动作：

| 最后边界 | 恢复动作 |
|---|---|
| 尚无可见片段、无工具副作用 | 新建 Attempt，可自动重试 |
| 已有可见片段 | 标记 Interrupted；用户显式新 Turn |
| 工具结果已权威提交但尚未注入 | 从 ToolExecution 读取确定结果并继续，禁止重复副作用 |
| 工具意图已提交，副作用或结果状态未知 | 不自动重放；记录 `unknown outcome`，按工具 `replay: never/safe` 和幂等声明选择合成结果、人工确认或收敛为 Interrupted |
| 工具意图已提交但确认尚未开始执行 | 记录 `TOOL_NOT_STARTED` 类合成结果后继续，或按策略收敛为 Interrupted |
| 终态已提交但事件未发送 | 重发持久 done 事件 |
| 删除/撤权水位未追平 | fail closed，不继续模型或工具调用 |

这里的恢复规则是 Aervox 自身的安全策略，不声称与 DSH/pi 完全相同。当前 3b-B Worker 恢复器只把过期的 Running Attempt 以 fencing+1 收敛为 Interrupted，不会自动继续原 Turn。DSH 的 crash repair 会为开放的 tool call 补 `TOOL_NOT_STARTED` 或 `TOOL_OUTCOME_UNKNOWN` 等 synthetic result，并把原 Turn 收敛为 Interrupted；pi 的 Harness 设计以 durable program counter 和工具的 `replay: never/safe` 约定决定是否重放，但固定版本公开 Harness 仍未完成该恢复能力。Aervox 只有在副作用状态和结果均已权威确定时，才允许继续原 Attempt；副作用或结果未知时必须记录 `unknown outcome` 并收敛或等待人工确认。

## 12. 事件与持久化边界

### 12.1 内部领域事件

建议事件目录：

```text
agent.turn.requested
agent.attempt.claimed
agent.step.started
agent.model.started
agent.model.segment.committed
agent.tool.requested
agent.tool.approval.required
agent.tool.completed
agent.step.completed
agent.turn.completed
agent.turn.interrupted
agent.turn.failed
agent.attempt.lease-expired
```

跨进程事件通过 Outbox，包含 `workspaceId`、`subjectUserId`、`turnId`、`attemptId`、`stepId`、`idempotencyKey`、`occurredAt` 和 `payloadVersion`。内部事件不等于客户端 SSE；只有经过公开契约筛选的事件才能成为 TurnStreamEvent。

当前 `apps/api` 创建 Turn 时写入的事件名仍是 `turn.created`，而目标 Loop 消费事件名为 `agent.turn.requested`。迁移期间必须保留兼容映射：Outbox consumer 同时接受两种事件，按同一个 `(turnId, idempotencyKey)` 去重，并将旧事件投影为 `agent.turn.requested`；新生产者切换后再经过一个完整的重试保留窗口，才能停止消费 `turn.created`。不能只修改事件字符串而不更新消费者和回放夹具。

### 12.2 事务边界

以下动作必须原子提交：

- Turn + 用户 MessageVersion + `agent.turn.requested` Outbox；
- 安全片段 + TurnStreamEvent + Draft prefix；
- ToolInvocation + 授权快照 + 幂等预留；
- ToolExecution 结果 + result event；
- Turn 终态 + done TurnStreamEvent + 下游 Outbox。

模型调用和外部工具不能与 SQLite 事务保持同一个长事务；采用“持久意图 → 外部调用 → fencing 校验后的结果提交”。

## 13. 目录规范

目标目录：

```text
capabilities/
  agent-runtime/
    capability.yaml
    src/
      definition.ts
      policies.ts
      events.ts
      application/
        execute-turn.ts
        prepare-step.ts
        finalize-turn.ts
      consumers/
        turn-outbox.ts
        api-admin.ts

providers/
  agent-loop/
    native/
      provider.yaml
      src/
        executor.ts
        inbox.ts
        model-step.ts
        tool-pipeline.ts
        recovery.ts
    replay/
    dsh/
    pi/

packages/
  capability-contracts/src/agent-loop/
  host-agent/

apps/
  agent/                       # 独立部署形态；迁移期可在 API 内挂载

adapters/
  dsh/agent-loop/
  pi/agent-loop/
```

迁移期允许 `native-agent-loop` 运行在 API 进程，但必须通过相同 Definition/LoopDriver/ModelProvider 接口。生产分离时，只替换 Host/Driver 绑定，API Turn/SSE 和业务数据不变。

## 14. DSH 与 pi 适配边界

### 14.1 DSH

本文借鉴 DeepSeek Harness 的 `DSH-01`：Turn/Step 双层循环、system prompt assembly、typed events、Tool pipeline、followup/steer/inject、可逆 effect 和 Loop Driver 可替换设计。固定版本的 DSH 工具批次采用 any/OR 聚合：任一已提交成功结果声明 `concludesTurn` 后，同一模型工具批次仍按调度规则执行并按模型顺序提交结果，再将批次标记为 concluded；Aervox 不直接继承该语义，而由 Adapter 翻译为本文件第 9 节规定的 `all-results-conclude`，混合批次必须继续下一 Step。

不直接采用：

- DSH Session log 作为 Aervox 业务真源；
- Cordis Context 直接暴露给业务模块；
- DSH 权限系统替代 Aervox Consent/ToolPolicy；
- DSH Loop 直接连接 Aervox SQLite。

`adapter-dsh` 必须把 DSH 事件、工具调用和终止原因规范化为本文件的 Port/事件，并使用 Aervox Attempt/fencing 持久化。它可以实现完整 `LoopDriverPort`，也可以只提供 `ModelProviderPort`/受限 Contribution；Manifest 必须声明实际等级，并在收集整批确定结果后调用 `shouldConcludeToolBatch()` 重新判定；无法保证该翻译时必须拒绝激活完整 Driver，不得静默提前结束。

### 14.2 pi

pi 的低层 `agent-loop.ts` 已实现内存中的 outer/inner loop，其工具批次采用 every/all：非空且所有结果 `terminate=true` 才能终止；固定版本的 `AgentHarness` v2 公开 `prompt`、`resume`、`abort` 和队列能力仍返回 `HarnessNotImplemented`，不能当作已完成的持久化 Harness。pi Extension 的事件、Tool、Provider 和上下文注入可映射为 Agent Loop Contribution，但 Extension 默认拥有完整宿主权限。`adapter-pi` 必须进程外执行，且只能通过受限 RPC 提交 Tool/Provider/Inbox Contribution；若包装低层 loop，仍需实现 Aervox 的 lease、fencing、持久化和恢复契约，不能直接把 v2 scaffold 当作 API 进程内 Loop。

## 15. 分阶段落地计划

### 阶段 0：冻结契约与测试骨架（已落地基础路径）

目标：建立可独立测试的 Definition，不改变现有 HTTP 行为。当前已落地阶段性 Port、Replay/Scripted Provider、内存 Store 和契约测试；完整 `LoopDriverPort` 抽象仍待收敛。

- 新建 `AgentLoopDefinition`、`LoopDriverPort`、`ModelProviderPort`、Context/Tool/Execution Store Port；
- 定义 Step、ToolInvocation、ToolExecution、Inbox schema；
- 建立 replay Loop Driver、replay Model Provider 和内存 Execution Store；
- 加 import 边界：Loop 应用层不能导入 SQLite/Drizzle；
- 建立契约测试、状态机属性测试和固定回放夹具。

当前基础路径已满足同一 replay 输入产生确定的 Step/Event/终态序列；`all-results-conclude` 的空批次、全终止和混合终止契约测试仍归入 3c+。

### 阶段 1：无工具的单 Step Loop（已落地基础路径）

目标：已完成基础替换；保留迁移期回退开关。

- API 创建 Turn 并创建 Attempt；Outbox 仍写 `turn.created`，迁移映射待异步消费者接入；
- Native executor claim TurnAttempt；
- Replay Provider 产生文本流，SSE 事件持久化后可重连重放；
- 完整分段安全门、ContextManifest 持久化和异步消费仍是后续补强项。

退出条件：客户端刷新后可以从持久事件恢复真实单 Step 回答，原始 Provider chunk 不直达客户端。

### 阶段 2：只读工具多 Step Loop（2a-2e 已落地基础路径）

目标：基础只读工具链和真实 OpenAI 兼容 Provider 已完成；并行、完整安全门和生产级背压继续补强。

- 已接入 ToolRuntime 的只读工具、`tool_request/tool_result` 事件和 `tool_executions` 账本；
- 已支持串行多 Step、timeout、重复工具检测、结果回填和 `maxSteps`；
- 阶段 2e 已接入 OpenAI 兼容流，并把当前 ToolSpec 清单传给模型；
- 完整 ToolInvocation 实体、参数 schema 快照、受限并行和结果安全门仍待 3c+。

退出条件（已满足基础路径）：固定回放覆盖两步工具链、工具失败、超时和 `maxSteps`；终端工具的空/全量/混合终止批次、生产级并行与背压测试仍待 3c+。

### 阶段 3：写工具、审批与恢复（3a/3b-A/3b-B 已落地基础路径）

目标：基础审批、租约与恢复已完成；生产级副作用幂等和恢复矩阵继续补强。

- 阶段 3a 已接入 `write_with_approval`、参数 hash 匹配、授权决定端点和 `pending_approval` 证据；
- 阶段 3b-A 已接入 lease TTL 与 Step 首部续租探活；
- 阶段 3b-B 已接入过期抢占、fencing 单一 Attempt 终态和 Worker 恢复器；
- 完整 CancelRequested 竞争、事件/工具迟到写入丢弃、删除/撤权水位和未知副作用恢复仍待 3c+。

退出条件（基础路径已满足）：租约丢失、过期抢占和重复终态提交有测试覆盖；非幂等工具的进程崩溃恢复与至多一次语义仍需按工具声明扩展。

### 阶段 3c+：生产级安全与恢复补强（规划）

目标：把当前最小实现提升为可长期运行的安全执行器。

- 将 lease/fencing 校验扩展到每个事件、工具结果和终态写边界；
- 完成 ToolInvocation 持久化、幂等预留、unknown outcome 收敛和工具 replay 声明；
- 接入真实分段安全门、取消传播、预算、并行调度和背压；
- 为 ModelRun/ContextManifest 增加 Turn/Attempt/Step 关联并补齐删除/撤权水位检查。

退出条件：故障注入、重复投递、租约抢占和未知副作用场景均有可重放证据，且旧执行器不能写入任何公开事件或终态。

### 阶段 4：独立 Host 与 Profile 选择

目标：把 Loop 从 API 组合根中抽出；独立 Host 已落地（4a/4b/4c/4d 全闭环），DSH/pi Adapter 仍未实现。

- 新建 `packages/host-agent` 和可选 `apps/agent`（已新建 `packages/host-agent`：内嵌异步 Host + SQLite ExecutionStore 组合适配 + 恢复源 + 最小 Profile + 健康检查）；
- Profile 绑定 Native/Replay/DSH/pi Loop Driver，并为每个 Driver 解析一个 Model Provider（已落地最小 Profile：replay 无依赖 / native 需 CR-015 同源配置；DSH/pi 仅在完成进程外 Adapter、许可证和安全评审后启用）；
- API 只负责 Turn command 和 SSE query；
- Agent Host 通过 Outbox/claim 驱动；
- 增加健康检查、并发调度、背压和优雅停机（已全落地：轮询/claim+背压/优雅停机 drain；4d 健康检查 `health()` 含 liveness 五态 + readiness 依赖探针 + 容量 gauge）。

退出条件：切换 Loop Driver 不改变客户端契约和业务数据库所有权，且无 DSH/pi 时原生 Profile 仍可运行。（已验证：`agent-loop-provider-parity.test.ts` driver 切换事件流契约骨架同构；`agent-loop-no-db` import-boundary 健身函数机器验证 agent-loop 不触数据库；`profile.test.ts` 验证无 DSH/pi 时原生 Profile 可运行。）

### 阶段 5：Inbox、压缩与高级能力

目标：支持持续 Agent 工作而不污染基本 Loop。

- followup、steer、inject；
- Context compaction seam；
- Skill 渐进式披露接入 ContextBuilder；
- Subagent/Workflow 通过独立 Tool/Provider Contribution 接入；
- DSH/pi Adapter 进行兼容、许可证和安全验证（仍属规划）。

退出条件：高级能力均通过扩展点接入，不修改 Loop 核心控制流。

## 16. 测试与验收

### 16.1 必测矩阵

| 测试 | 覆盖 |
|---|---|
| `agent-loop-contract.test` | Definition/Loop Driver/Model Provider/Store 一致性 |
| `agent-loop-replay.test` | 固定模型流和工具流的确定性回放 |
| `agent-loop-state-machine.test` | Attempt/Step 合法转换与终态唯一性 |
| `agent-loop-fencing.test` | 旧 executor 不能提交 chunk/tool/终态 |
| `agent-loop-tool-policy.test` | read/write/privileged、审批、撤权和 `all-results-conclude`（后者待 3c+） |
| `agent-loop-recovery.test` | 首片段前重试、首片段后 Interrupted、确定结果继续、unknown outcome 收敛（完整矩阵待 3c+） |
| `agent-loop-sse.test` | 持久后发送、高水位重放、断线恢复 |
| `agent-loop-budget.test` | step/token/time/cost/tool 限额 |
| `agent-loop-deletion.test` | 删除/撤权后零召回与 fail closed |
| `agent-loop-provider-parity.test` | Native/Replay/DSH any/pi every 映射为 Aervox `all-results-conclude`（DSH/pi 接入时建立） |

### 16.2 架构验收

- Conversation route 不包含模型或工具循环；
- Agent Loop 应用层不导入具体 SQLite、Drizzle 或外部 SDK；
- Tool schema 展示、授权和执行来自同一 registry/version；
- 所有用户可见片段先持久化后发送；
- 每个 ModelRun、ToolExecution 和终态可追溯到 Attempt/Step；
- 同 Turn 只有一个有效 fencing token 可以提交；
- Loop Driver 可通过 Profile 替换，Model Provider 与 Driver 的兼容等级可独立验证；
- 无外部 DSH/pi 时原生 Profile 可运行；
- DSH/pi 不拥有 Aervox Session/Message/学习数据。

### 16.3 可观测性

至少记录：

- Turn/Attempt/Step 数量、状态和终止原因；
- Provider TTFT、完整耗时、重试和成本；
- 分段安全检查与数据库提交延迟；
- Tool 排队、审批、执行、失败、timeout 和副作用重放；
- lease 续租失败、fencing 拒绝和恢复次数；
- maxSteps、预算、重复工具和上下文截断触发次数；
- SSE 重连、慢消费者断开和游标过期。

日志默认不记录完整 Prompt、用户 Restricted 内容或工具敏感结果。

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
- 仍未覆盖（后续批）：`maxParallelReadTools`、`maxModelRetries`、token/费用预算与 `maxTokens`（依赖 Provider 上报 `usage`，属阶段 2e+）。落地登记见[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

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
| `agent-loop-recovery` | `lease-guard`（过期释放）+ `cancel.test.ts`（取消）+ `budget.test.ts`（闸门）+ `idempotency.test.ts`（工具未知结果） | 已落地（「首片段前自动重试」待续，见 §10 maxModelRetries 未覆盖） |
| `agent-loop-sse` | `apps/api/test/conversation-loop.test.ts`（持久后发送/重连重放） | 已落地 |
| `agent-loop-budget` | `packages/agent-loop/test/budget.test.ts`（step/turn-timeout/repeat-tool） | 已落地（token/费用预算待续） |
| `agent-loop-deletion` | `apps/api/test/conversation-deletion.test.ts`（未追平 fail-closed）+ `budget.test.ts`（DeletionGate） | 已落地 |
| `agent-loop-provider-parity` | `packages/agent-loop/test/provider-parity.test.ts`（终止语义表 + Native 基线 + 三方插槽 + 阶段 4 退出条件「driver 切换不改事件流契约骨架」） | 已落地（DSH/pi 适配器对照仍待进程外 Adapter 准入） |

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

- privileged 工具收敛为与 `write_with_approval` 相同的「授权命中（granted）→ 执行 / 未批准 → 审批待决」流程（不再硬拒绝），但**授予动作**受管理员身份校验：`POST /v1/turns/:id/tool-approvals` 对 privileged 工具要求 `x-admin-user-id` ∈ `AERVOX_ADMIN_IDS` 白名单，否则 403 `admin_required`；
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

## 17. 回滚策略

- 当前保留 Replay Provider 作为无外部模型依赖的可回退执行路径；
- 新增表先 Expand，不删除旧字段；
- Native Loop 失败时可以切换 Replay/固定保守响应 Driver，但不能重放已产生副作用的 Turn；
- 独立 Agent Host 回滚为 API 内嵌 Driver 时保留相同 claim/fencing；
- DSH/pi Adapter 异常时禁用 Adapter，保留 Aervox 原生 Turn、事件和导出；
- 回滚不得删除已提交的安全片段、ModelRun、ToolExecution 或审计记录。

## 18. 决策与后续文档

本文是 `CR-012` 的 Reference，既记录阶段 0/1/2a-2e/3a/3b-A/3b-B 的已落地边界，也记录 3c+、独立 Host 和 DSH/pi Adapter 的目标。正式实施下一阶段前应新增架构决策，冻结以下难以逆转的内容：

- Agent Loop 是否作为独立 `apps/agent` 部署；
- AgentStep/ToolInvocation/ToolExecution/Inbox 的数据模型；
- 默认 Step、时间、成本和工具并行上限；
- Native、DSH 和 pi Loop Driver、Model Provider 的兼容等级；
- followup/steer/inject 的公开与内部接口边界。

实现每一阶段后必须更新[需求追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)，并在[参考设计迁移 §6.1](../explanation/reference-design-transfer.md#61-落地登记唯一真源)查询 `DSH-01` 与 `PI-01` 来源说明。

## 19. 机器验证

当前文档通过 `mise tasks run ci-docs` 验证。代码落地后，Manifest、Port、事件、数据库状态机和 Provider parity 必须由 schema/contract tests 机器验证；任何只写在本文、无法由类型、schema、测试或运行时断言约束的关键不变量都视为未完成。
