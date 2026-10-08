---
id: AVX-HAR-001
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.8.0
updated_at: 2026-10-08
reviewed_at: 2026-10-08
review_interval_days: 90
---

# Agent Harness Loop 设计与落地规范

关联：[能力组合与可选化目录规范](capability-composition.md)、[架构设计](ARCHITECTURE.md)、[流式协议](STREAMING_PROTOCOL.md)、[ADR-004](adr/ADR-004-outbox-idempotent-jobs.md)、[ADR-005](adr/ADR-005-provider-port.md)、[ADR-009](adr/ADR-009-electron-plugin-sandbox.md)、[ADR-010](adr/ADR-010-dsh-pi-adapters.md)、[ADR-012](adr/ADR-012-streaming-safety-persistence.md)、[ADR-016](adr/ADR-016-base-boundaries.md)、[ADR-017](adr/ADR-017-context-manifest-modelrun-step.md)、`CR-012`（已归档）、`CR-021`（已归档）、`CR-022`（已归档）、[需求追踪基线](REQUIREMENTS_TRACEABILITY.md)

本文规定 Agent Turn 的执行、持久化、工具授权、取消恢复与验收契约。内核实现位于 [`packages/core`](../../packages/core/src/index.ts)，SQLite 适配与宿主构件位于 [`packages/host-agent`](../../packages/host-agent/src/index.ts)；原 `packages/agent-loop` 及兼容壳已按 [ADR-021](adr/ADR-021-aervox-core-standalone-package.md) 移除。接口与字段以代码和 Schema 为机器真源，本文保留跨模块不变量及尚未兑现的目标，不复制实现历史。

当前工作排序与认领只在根 [plan.md](../../plan.md) 维护；实现、剩余差量与交付证据以[追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)为准。下列代码入口用于定位现状，不表示完整生产验收或发布批准；已接受的安全要求不因现状有缺口而降低。

## 当前执行合同补充（CR-061）

本节记录 ITER-044～048 的实现边界，裁决见 [CR-061](changes/CR-061-core-execution-contract-hardening.md)。API 和内存宿主复用 `HostToolRuntime`；审批完成后再次检查控制信号，工具派发复验注册代际、启用状态和当前授权。动态工具每 Step 重新发现，模型工具声明使用该次快照，旧声明不能调用替换后的 Handler。门控上下文缺失、未知算子与畸形条件均拒绝。

Provider 的 `capabilities` 可报告工具/推理协议支持、已知上下文窗口与输出上限。OpenAI 兼容实现检查**最终序列化请求**（含完整消息和工具 Schema）加输出预留：可注入 Token 估计器，缺省用 UTF-8 字节与协议余量保守估算；未知窗口不伪造数值。用量可附缓存读写 Token。`length`、`content_filter`、无完整结束标记及非法工具参数不得执行工具，正文前缀保留且回合不标为完成。

正文按至多 4096 UTF-8 字节的窗口提交，源静默时每 50 ms 刷新待发前缀；单 Step 累计响应上限为 8 MiB，OpenAI HTTP 响应缺省也受 8 MiB 限制。50 ms 控制轮询可打断静默模型等待；已提交正文后不再重试模型。限制针对收集与提交路径，不能替代宿主对子进程或忽略信号的外部服务的资源管理。规则压缩保留系统约束和完整工具调用/结果组，以明确省略提示替代旧占位摘要；单组过大时保留整组，由最终窗口检查拒绝超限请求。

`AERVOX_LOOP_RESUME=local-results` 显式启用 API 启动恢复，缺省 `off`。单次最多扫描 10 个过期候选，串行重新取得 fencing 租约，只用当前准入的本机模型根据权威结果补完一轮正文，单候选截止 30 秒。恢复不运行回合插件钩子，不派发新工具；需要新动作时由用户发起新回合。已终态、缺失/重复配对、未知结果（即使 `replay: safe`）、审批待决、脱敏/删除内容或删除闸门阻断均不自动恢复。Worker 同时恢复时由 CAS 决定唯一执行者，Worker 已终结的 Attempt 不会复活。下一序号来自完整持久事件上界。停用开关回到既有 Worker 中断收敛，无数据迁移。

公共入口仍为 `@aervox/core` 与 `@aervox/core/core`，执行收集器、终态收敛器、工具管线/账本及内部序列化函数不再从根入口暴露。工作区消费者通过公开 Port 与 `executeTurn` 集成，内部单元测试直接引用源码模块；软件包保持 `private: true` 和零运行时依赖。公开发布前仍需独立版本与发布审核。

性能基线通过 `mise exec -- node scripts/benchmark-core.mjs --samples=5 --out=<path>` 生成 JSON，已记录的[受控基线](../_meta/core-benchmark-baseline.json)带构建产物摘要与环境，记录首段可见、取消延迟、提交批次字节与写入点采样堆内存；先构建 `@aervox/core`。SQLite 跨进程竞争继续使用 `scripts/worker-write-contention-drill.mjs` 的临时库和独立 Socket。基线为受控夹具测量，不能当成真实模型或用户磁盘的服务等级承诺；不把机器负载敏感的延迟阈值放入单元门禁。

## 1. 范围与非目标

Agent Harness Loop 是驱动一次 Agent Turn 的执行能力：它领取已持久化 Turn，组装上下文，通过 Model Provider 取得模型输出，处理模型文本和工具请求，提交安全事件，并根据终止策略继续下一 Step 或结束 Turn。

本文覆盖：

- Agent、Turn、Attempt、Step、ModelRun 和 ToolExecution 的执行关系；
- 输入安全、上下文组装、模型调用、工具权限、结果回填和终止判断；
- 流式持久化、取消、重试、租约、fencing、恢复和可观测性；
- 原生 Loop Driver 与 DSH/pi Adapter 的替换边界，以及 Model Provider 的调用边界；
- 从迁移期 API 内嵌 Loop 逐步演进到异步、可替换和可恢复的完整 Loop 的阶段设计与退出条件。

本文不覆盖：

- 具体模型供应商 SDK；它们由 `ModelProviderPort` Adapter 实现；
- 单个工具的业务规则；工具 Owner 通过 Tool Port 提供实现；
- Worker 的复习、日记、删除等周期任务；它们属于 Job Handler，不属于 Agent Harness Loop；
- DSH 或 pi 的 Session 格式、权限模型和持久化格式；外部运行时只能通过 Adapter 提供 Loop Driver、Model Provider 或受限 Contribution。

## 2. 当前现状与缺口

### 2.1 已有构件

| 构件 | 实现入口 | 当前边界 |
|---|---|---|
| Turn 受理与执行 | [Conversation routes](../../apps/api/src/modules/companion/conversation/routes.ts) | 持久化 Turn、Message、`turn.created` Outbox 后建立 Attempt；默认在 API 进程后台执行并立即返回 201，`inline` 仅用于测试/排查；不是持久队列驱动的独立执行进程 |
| Loop 与 Provider | [executor](../../packages/core/src/executor.ts)、[Provider](../../packages/core/src/openai-compat-provider.ts) | Replay/Scripted/OpenAI 兼容流、多 Step、审批 SPI、取消与预算；API 组合根负责注入产品上下文和权限 |
| 租约与公开事件 | [SQLite ExecutionStore](../../packages/host-agent/src/sqlite-execution-store.ts)、[心跳](../../packages/core/src/lease-heartbeat.ts) | claim/renew、事件 fencing、安全片段与事件原子提交、工具结果与事件原子提交、终态 CAS 已存在；不能据此推定全部旧写入口均有相同保护 |
| 工具执行 | [工具管线](../../packages/core/src/tool-pipeline.ts)、[工具账本](../../packages/core/src/tool-ledger.ts)、[API Runtime](../../apps/api/src/modules/ecosystem/tools/runtime.ts) | 已有输入检查、审批、幂等预留、超时、结果检查与账本；动态权限快照、资源隔离及完整副作用恢复仍需专项验收 |
| 模型调用记录 | [executor 写入](../../packages/core/src/executor.ts)、[API sink](../../apps/api/src/modules/companion/conversation/agent-executor.ts) | 每个成功返回的 Step 写 ModelRun，关联 attemptId/stepId；首 Step 写上下文快照。写入为可选、尽力而为，尚不满足每次请求/重试独立且不可缺失的 Manifest 合同 |
| Inbox 与扩展 | [Inbox API](../../apps/api/src/modules/companion/inbox/routes.ts)、[ContextBuilder](../../packages/core/src/context-builder.ts) | 已有持久 inbox、claim/ack、followup/steer/inject 消费、Skill 与压缩接缝、Subagent/Workflow Contribution；唤醒和恢复的端到端语义仍按下文验收 |
| 可复用 Host/Profile | [Agent Host](../../packages/host-agent/src/agent-host.ts)、[Profile](../../packages/host-agent/src/profile.ts)、[恢复源](../../packages/host-agent/src/sqlite-resume-source.ts) | 已有轮询、claim、容量限制、健康检查、排空和最小 Provider/Adapter 选择；这些库构件不等于 API/Worker 已切换到独立 Host |
| Worker 恢复 | [attempt-recovery](../../apps/worker/src/attempt-recovery.ts) | 默认周期把过期 Attempt 收敛为 Interrupted；续跑候选只作观测，不自动调度 Host 续跑 |

<a id="22-当前缺口"></a>

### 2.2 尚未兑现的目标

当前差量包括持久接单与独立 Host 的生产接线、完整 `LoopDriverPort`、AgentStep/ToolInvocation 独立持久化、每请求/重试的 ModelRun 与来源 Manifest、工具 Schema/授权修订的一致快照，以及完整安全、背压、取消和恢复矩阵。对应验收见 §15～16，排序与认领见根计划，不在本文另建任务队列。

DSH 已有整 Turn 进程外 Adapter 接口和模拟器/夹具验证，API 可用 `AERVOX_LOOP_DRIVER=dsh` 选择；真实外部运行时及其兼容性验收不得从开关或夹具通过推定。pi 仍需真实 Adapter。客户端 SSE 读取循环不承担 Agent Loop。

## 3. 在能力组合模型中的位置

按 [ADR-021](adr/ADR-021-aervox-core-standalone-package.md)，`@aervox/core` 提供宿主无关的执行内核；学习、人格等业务能力由宿主注入。业务能力是否启用与 Driver 选择遵循[能力组合规范](capability-composition.md)，不允许借替换 Driver 绕过持久化和授权责任。目标 Profile 可选择：

- Aervox 原生 `native-agent-loop` Driver；
- `adapter-dsh` 暴露的 DSH Loop Driver；
- `adapter-pi` 暴露的 pi Loop Driver；
- 测试使用的 `replay-agent-loop` Driver。

Resolver 不变量：对话能力一旦启用，且某个 Turn 需要执行模型—工具流程，Profile 必须且只能解析出一个兼容的 `LoopDriverPort`。可以不安装 DSH 或 pi，但不能出现“有 Conversation 能力却没有 Native/Replay/其他 Loop Driver”，也不能同时激活两个竞争性的 Driver。模型 Provider 可以有多个候选，但每个 Step 最终只能绑定一个已解析的 Model Provider。

当前 [`createAgentProfile`](../../packages/host-agent/src/profile.ts) 已解析 native/replay Provider 或显式注入的 dsh/pi Adapter，并拒绝缺失配置及 Driver/Adapter ID 不匹配。API 仍由 `AERVOX_LOOP_PROVIDER` 选择 Replay/Scripted/OpenAI 兼容 Provider，由 `AERVOX_LOOP_DRIVER` 选择 native/dsh；该接线不等于已完成全量 Capability Manifest/Profile 解析。

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

| 对象 | 责任与持久化合同 |
|---|---|
| `AgentInstance` | 可接收 Turn/inbox 的逻辑执行身份；由 Profile/Persona 派生，不替代本地用户或授权主体 |
| `Turn` | 用户可观察的请求—响应边界；终态唯一，客户端只读取权威状态 |
| `TurnAttempt` | 可领取的执行尝试；claim/renew/recover 与终态 CAS 均绑定租约及 fencing |
| `AgentStep` | Attempt 内一次模型请求及工具结果闭环；序号单调，目标为独立持久实体 |
| `ModelRun` | 一次精确 Provider 请求；已存 attemptId/stepId，目标为每次重试另建记录并归属同一 Step |
| `ContextManifest` | 模型请求的不可变来源清单；唯一父级为 ModelRun，来源条目与关联基数由 [ADR-017](adr/ADR-017-context-manifest-modelrun-step.md) 冻结；当前首 Step 快照不等于完整来源清单 |
| `ToolInvocation` | 规范化工具请求，目标独立持久化 Schema 版本、参数 hash 和授权快照；当前由事件、审批及 ToolExecution 组合承载 |
| `ToolExecution` | 受控执行的预留、结果和未知状态账本；失败/未知不能被包装成已成功执行 |
| `AgentInboxItem` | 已有持久表与仓储；绑定 Session、消费边界、顺序、来源、状态和过期时间 |
| `TurnStreamEvent` | 已有持久事件与 SSE 重放；只能发布经安全检查且已提交的公开事件 |

完整字段以 [`packages/schema`](../../packages/schema/src/index.ts) 与 [Core 类型](../../packages/core/src/types.ts)为准。AgentStep/ToolInvocation 的独立实体仍是目标；关键恢复状态不能只存在于内存日志。

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

以上是概念状态机，不是数据库状态枚举或 HTTP 状态集合；机器取值以 Schema 和[流式协议](STREAMING_PROTOCOL.md)为准。只有持有当前 lease 和 fencing token 的执行器可以追加 Step、TurnStreamEvent、ToolExecution 或提交终态。旧执行器随后收到的 Provider/Tool 结果必须丢弃并记录诊断；现有事件、工具结果、安全片段与终态写入已通过带 fencing 的组合方法保护，全部旁路及恢复竞争仍需 §16 的故障验证。

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
2. validate local authorization, consent, input safety and current deny watermark
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

以上是目标执行顺序，不是已经全部实现的事务合同。原生控制流以 [executor](../../packages/core/src/executor.ts)为准，数据提交边界见 §12.2。

`all-results-conclude` 的目标语义为：批次非空，所有已启动工具均已提交确定结果，且全部声明终止，才可结束 Turn；空批次或混合批次必须继续。当前原生 `ToolCallResult` 未提供 `concludesTurn` 字段，工具往返后仍进入下一 Step，直至模型自然结束或触发限额；Adapter 的终止翻译已有独立[合同与测试](../../packages/core/test/adapter-contract.test.ts)，不能与原生工具结束能力混为一谈。每个持久化边界都必须比较有效租约、fencing 与适用 revision。

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

当前 API 的跨 Turn 历史由会话仓储读取，并在固定系统提示词后、本轮输入前注入，每轮执行只读取一次。范围为同一本地数据库、同 Session、当前 Turn 插入之前的最近 20 个已完成非子任务 Turn；采用最新有效用户版本及完成 Attempt 的已批准助手正文，不包含工具原始结果或思考过程。删除、脱敏、不完整或未通过安全门的轮次不进入历史；32000 字符预算按完整对话轮保留近期内容，不生成摘要。SQLite 适配器使用插入序号区分同毫秒 Turn，后续数据库适配需保持同等顺序边界。恢复器复用同一读取规则，再追加当前 Turn 的权威事件重建历史；子任务仍保持上下文隔离。超出窗口的对话仍需后续摘要策略。

普通长期记忆由独立召回来源进入 ContextBuilder：当前用户消息使用与写入侧相同的 embedding provider 生成查询向量，与本地 `memories_fts` 结果并行检索，经 RRF 融合后最多回读 5 条权威记录。只允许 `verified`、未删除、`long_term` 记录进入模型上下文；召回失败按无记忆降级，不阻断 Turn。默认 Provider 是 256 维本地特征哈希，只提供词面和局部相似度、无需联网；生产可注入语义 embedding provider，并由 `modelId` 隔离向量空间。召回正文上限 4000 字符，以不可信数据形式注入，不能作为系统指令、工具调用或授权。

每个来源必须进入 ContextManifest，记录来源 ID/版本、purpose、权限快照、截断/压缩方式和内容 hash。原始 Restricted 内容默认不进入日志。[ADR-017](adr/ADR-017-context-manifest-modelrun-step.md) 已冻结一次 ModelRun 对应一个不可变 Manifest，多来源对应条目，Manifest 只以 ModelRun 为父级；attemptId/stepId 存在于 ModelRun。当前实现仅在首 Step 写 `turn:history` 快照，后续 Step、失败请求及重试尚未形成完整来源证据链，不能将该快照解释为满足目标的每请求 Manifest。

### 7.2 AgentInboxItem

| 类型 | 语义 | 是否唤醒 | 消费边界 |
|---|---|---:|---|
| `followup` | 排队为当前 Turn 结束后的新 Turn 输入 | 是 | `next-turn` |
| `steer` | 修改当前执行的下一 Step 输入 | 是 | `next-step`；不能改写已提交事件 |
| `inject` | 添加下一次模型请求可见的上下文 | 否 | `next-step` 或 `next-turn` |

CR-030 D2 后，所有 inbox item 必须绑定 `sessionId`、来源 actor、来源修订、幂等键和状态；消费采用 claim/ack，崩溃后可以安全重放。外部插件不能直接修改 Session 日志，只能提交受限 inbox command。

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

同一执行循环的 assistant 历史保留完整 `toolCalls`（ID、名称、参数）及该步骤的 `reasoning`，兼容 Provider 映射为 `tool_calls` / `reasoning_content`，与后续 tool 结果逐项配对。推理内容由历史持有，不在 Provider 实例跨请求共享；旧历史缺少参数时不虚构参数。跨进程恢复仍须独立验证历史保真，研究执行器暂不支持断点续跑；协议回归见 [Provider 测试](../../packages/core/test/openai-compat-provider.test.ts)。

Provider chunk 先进入有界 assembler，不得直接写 HTTP、日志或 Message。文本、结构化输出、tool-call、usage 和 finish reason 必须被规范化为 Aervox 类型。

## 9. 工具执行管线

工具执行顺序固定为：

```text
resolve definition
  -> schema validate
  -> capability/profile gating
  -> local authorization/consent/purpose policy
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
- `write_with_approval` 必须绑定可审计授权快照；CAP-033 主动智能模式下，`FullProfileActionGrant` 也必须绑定动作类别、目标 scope、授权修订和可撤销快照；
- CreateTurn 的 `toolApprovalMode` 默认为 `ask`；用户经风险确认选择 `full_access` 时，宿主只可对 `write_with_approval` 先写授权账本再自动执行；
- `full_access` 是 Turn 级权限快照，不改写工具自身的 `safetyLevel`；运行中的 Turn 禁止切换，关闭只影响后续 Turn，不撤回已开始的副作用；
- 完全访问产生的自动授权必须与显式授权区分；恢复 `ask` 后，显式授权查询不得命中这些记录；
- `privileged` 在普通 Turn 中默认拒绝，只能由单独管理员通道放行；若当前主动智能模式存在用户确认且覆盖目标的 `FullProfileActionGrant`，可按同一工具门校验后放行，不能由模型/插件自授；
- Subagent/Workflow 等静态 Contribution 的写工具必须经同一授权门，不得因 Provider 组合路由绕过审批策略；
- 写工具按业务资源/Session 串行；相互独立的只读工具可以受限并行；
- 幂等键建议为 `attemptId:stepNo:callId`，上游 callId 不可信时由 Host 重新生成；
- 非幂等副作用失败不自动重试；
- 工具结果进入模型前做大小、敏感数据、Prompt injection 和来源检查；
- 终端工具可以返回 `concludesTurn=true`，但不能绕过最终持久化和安全检查；
- Aervox 的批次终止契约是“非空且所有已完成结果均 `concludesTurn=true`”；混合批次继续下一 Step，且所有已经启动的工具都必须先产生并提交确定结果；
- **工具 Prompt 约束与同步硬规则**：所有在系统中注册或贡献的工具（含内置工具与后续新增工具），必须登记明确的调用时机（何时使用/何时禁止）及约束要求——内核自有工具登记在 `BASE_TOOL_GUIDANCE`（`packages/core/src/base-prompt.ts`），宿主/插件贡献工具由宿主经 `customGuidance` 注入（参考 apps/api `HOST_TOOL_GUIDANCE`，ADR-021 内核提纯修订）；未在 System Prompt 中声明指导原则的工具禁止进入生产可用清单。

### CAP-033 主动动作分支

CAP-033 的后台主动动作仍复用本管线，但授权来源改为用户确认的 `FullProfileActionGrant`。Host 在 `approval decision` 前同时校验主动智能激活租约、动作类别（`local`/`external`/`privileged`/不可逆）、目标 scope、授权 revision、OS/身份授权、deny watermark 和幂等键；任一条件失效即拒绝。动作结果、用户通知和撤权状态写入 CAP-033 本地审计面，不能通过普通 Turn 自动授权记录替代。

## 10. 限额与终止策略

以下保留第一版建议基线，最终数值需通过 ADR/压测冻结；它们不是当前运行默认值。实际默认值以 [executor options](../../packages/core/src/executor.ts) 和宿主配置为准（例如当前 `toolTimeoutMs` 默认 5000，Turn 时长和连续工具限制默认 0，表示关闭）。

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

原生执行路径使用 `ControlContext`（BTD-05 统一控制）：模型请求（含重试）与工具派发共享调用预算；子任务继承父截止、本地处理限制和剩余额度，子任务消耗回记父级，额外取消信号与父信号合并。Token 执行预算是保守准入/消费限额：输入消息和工具定义、输出正文/思考/工具请求先按 UTF-8 字节计量，Provider 累计 `totalTokens` 只可向上补记；它不等同供应商账单。OpenAI 兼容 Provider 同时收到剩余 `max_tokens`。零额或不足以容纳输入时不派发，流式超额中断并写明原因。没有设置预算时沿用原行为；费用、模型窗口和动态授权修订的全量验收仍在原队列。

`SessionLedgerPort` 仅选取状态/事件方法，工具副作用和模型遥测仍属执行 Port。API 组合根选择 SQLite；Core 的 headless/内存示例证明库可以独立运行，连接版 `apps/cli` 则消费本机 API，两者不是同一宿主形态。原生 Loop 及 Adapter 的执行终态通过带 fencing 的原子提交更新 Turn、Attempt 和终止事件；CAS 失败不由 API 补写覆盖。当前 Adapter 尚无预算/本地策略协商能力，对这些约束明确拒绝派发，不能静默忽略。

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

现有实现已覆盖 Step 首部续租、长调用期间心跳、过期抢占，以及事件/工具结果/安全片段/终态的 fencing 校验；位置见 §2.1，反例回归见 §16.1。该范围不自动覆盖独立审批/预留等所有旧写入口，也不能代替真实副作用取消的故障演练。

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

这些是 Aervox 的恢复规则，不继承外部 Driver 的默认行为。当前 [Worker 恢复周期](../../apps/worker/src/attempt-recovery.ts)仍将过期 Attempt 收敛，不调度续跑；[Core 裁决](../../packages/core/src/resume.ts)与 [Host 恢复源](../../packages/host-agent/src/sqlite-resume-source.ts)已经提供基于权威工具结果的续跑构件。

对于已识别批次中的 `pending/outcome_unknown`，只有相关未确定工具全部声明 `replay: safe`，才可注入 `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 合成结果后继续；合成结果不证明副作用成功，也不授权重放。未声明、`never` 或 `pending_approval` 一律收敛。没有权威依据的结果不得猜测；完整生产恢复还须验证候选领取竞争、上下文保真和所有故障边界。

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

跨进程事件通过 Outbox，包含 `turnId`、`attemptId`、`stepId`、来源/授权修订、`idempotencyKey`、`occurredAt` 和 `payloadVersion`。内部事件不等于客户端 SSE；只有经过公开契约筛选的事件才能成为 TurnStreamEvent。

当前 `apps/api` 创建 Turn 时写入的事件名仍是 `turn.created`，而目标 Loop 消费事件名为 `agent.turn.requested`。迁移期间必须保留兼容映射：Outbox consumer 同时接受两种事件，按同一个 `(turnId, idempotencyKey)` 去重，并将旧事件投影为 `agent.turn.requested`；新生产者切换后再经过一个完整的重试保留窗口，才能停止消费 `turn.created`。不能只修改事件字符串而不更新消费者和回放夹具。

### 12.2 事务边界

以下是必须维持或补齐的原子提交边界：

| 原子边界 | 当前实现与剩余要求 |
|---|---|
| Turn + 用户 MessageVersion + 接单 Outbox | 当前写 `turn.created`；切换为 `agent.turn.requested` 须遵守 §12.1 的兼容、去重与保留窗口 |
| 安全片段 + TurnStreamEvent + Draft prefix | 仓储已提供 `recordSafeSegmentAtomically` / 批量变体；完整 Draft 与安全校验语义仍按流式协议验收 |
| ToolInvocation + 授权快照 + 幂等预留 | 已有审批幂等复用和执行预留；独立 ToolInvocation 及全体快照的一次性提交仍待补齐 |
| ToolExecution 结果 + result event | 已有 `recordToolOutcomeAtomically`，同一事务核对 fencing 并提交 |
| Turn 终态 + done/error 事件 + 下游 Outbox | 已有 `finalizeAttemptWithEventAtomically` 提交终态及收尾事件；下游 Outbox 同事务要求不能由该方法名推定已满足 |

具体方法由 [ExecutionStore 适配](../../packages/host-agent/src/sqlite-execution-store.ts)委托仓储。模型调用和外部工具不得置于 SQLite 长事务内；采用“持久意图 → 外部调用 → fencing 校验后的结果提交”。

## 13. 目录规范

当前路径按职责分工，不复制另一套实现：

| 目录 | 职责 |
|---|---|
| `packages/core/src` | Loop 状态机、控制、通用工具/Provider/Context Port 与内存实现；不得依赖 SQLite、Drizzle、UI 或伴学产品模块 |
| `packages/host-agent/src` | SQLite ExecutionStore 适配、Profile、可复用 Host、恢复源与进程外 Adapter |
| `apps/api/src/modules/companion/conversation` | HTTP/SSE、产品上下文、Provider/工具装配与执行触发 |
| `apps/worker/src` | 周期恢复、Outbox 与其他后台任务；不自行复制模型—工具循环 |

目标 `capabilities/`、`providers/`、`adapters/`、独立 `apps/agent` 等目录只由[能力组合规范](capability-composition.md)维护。独立部署前须冻结 Host/Driver 绑定与数据责任；迁移不能改变 API Turn/SSE、业务数据所有权或 claim/fencing。

## 14. DSH 与 pi 适配边界

### 14.1 DSH

本文借鉴 DeepSeek Harness 的 `DSH-01`：Turn/Step 双层循环、system prompt assembly、typed events、Tool pipeline、followup/steer/inject、可逆 effect 和 Loop Driver 可替换设计。固定版本的 DSH 工具批次采用 any/OR 聚合：任一已提交成功结果声明 `concludesTurn` 后，同一模型工具批次仍按调度规则执行并按模型顺序提交结果，再将批次标记为 concluded；Aervox 不直接继承该语义，而由 Adapter 翻译为本文件第 9 节规定的 `all-results-conclude`，混合批次必须继续下一 Step。

不直接采用：

- DSH Session log 作为 Aervox 业务真源；
- Cordis Context 直接暴露给业务模块；
- DSH 权限系统替代 Aervox Consent/ToolPolicy；
- DSH Loop 直接连接 Aervox SQLite。

`adapter-dsh` 必须把 DSH 事件、工具调用和终止原因规范化为本文件的 Port/事件，并使用 Aervox Attempt/fencing 持久化。它可以实现完整 `LoopDriverPort`，也可以只提供 `ModelProviderPort`/受限 Contribution；Manifest 必须声明实际等级，并在收集整批确定结果后通过 [`concludeAdapterBatch`](../../packages/core/src/adapter-contract.ts) 重新判定；无法保证该翻译时必须拒绝激活完整 Driver，不得静默提前结束。

### 14.2 pi

pi 的低层 `agent-loop.ts` 已实现内存中的 outer/inner loop，其工具批次采用 every/all：非空且所有结果 `terminate=true` 才能终止；2026-09-29 更新后的固定参考版本中，lane Harness 已实现 `prompt`、`resume`、`abort`，但 `watchSession` 仍未完成；CLI/SDK 继续走 `Agent + AgentSession + SessionManager`，新 durable 路线在本次最终固定 SHA 已完成首个可持久恢复的无工具聊天回合，但工具执行和忙时 Inbox 尚未完成，三者不能合并表述为完整持久内核（[版本与证据](../explanation/reference-design-transfer.md#upstream-20260929)）。pi Extension 的事件、Tool、Provider 和上下文注入可映射为 Agent Loop Contribution，但 Extension 默认拥有完整宿主权限。`adapter-pi` 必须进程外执行，且只能通过受限 RPC 提交 Tool/Provider/Inbox Contribution；若包装低层 loop，仍需实现 Aervox 的 lease、fencing、持久化和恢复契约，不能直接把外部 Harness 当作 API 进程内 Loop。

<a id="15-分阶段落地计划"></a>

<a id="15-阶段设计退出条件与历史进展"></a>

## 15. 阶段设计与退出条件

原阶段编号保留为契约引用；历史实现过程见 [Aervox-docs-archive](https://github.com/3yearsZhuang/Aervox-docs-archive) 的 `archive/agent-loop-rollout-history.md`。当前代码边界集中于 §2，以下验收不能用历史通过记录替代。

<a id="阶段-0冻结契约与测试骨架已落地基础路径"></a>
<a id="阶段-1无工具的单-step-loop已落地基础路径"></a>
<a id="阶段-2只读工具多-step-loop2a-2e-已落地基础路径"></a>
<a id="阶段-3写工具审批与恢复3a3b-a3b-b-已落地基础路径"></a>
<a id="阶段-3c生产级安全与恢复补强规划"></a>
<a id="阶段-4独立-host-与-profile-选择"></a>

| 原阶段 | 退出条件 |
|---|---|
| 0 契约与骨架 | Definition/Driver/Provider/Context/Tool/Store 边界明确；Schema、内存 Store、固定回放与状态机测试可验证；相同 replay 输入产生确定的 Step/Event/终态，Loop 不导入数据库 |
| 1 单 Step | Turn/Attempt 受理与事件兼容映射可回放；刷新后从持久事件恢复完整回答，原始 Provider chunk 不直达客户端 |
| 2 多 Step 工具 | 固定夹具覆盖两步工具链、失败、超时、重复工具和 maxSteps；ToolSpec、参数 Schema 快照、空/全量/混合终止批次、受限并行、结果安全和背压均有证据 |
| 3 审批与租约 | 写工具绑定参数 hash 与授权快照；租约丢失、重复终态、CancelRequested 竞争和过期抢占可重现；未知副作用不自动重试 |
| 3c+ 安全与恢复 | 每个写边界核对 fencing；ToolInvocation、幂等预留、replay 声明、未知结果、删除/撤权水位、预算、取消与恢复矩阵闭合；每请求 ModelRun/Manifest 和 Step 可追溯 |
| 4 独立 Host | 独立接单、claim、容量背压、优雅排空与健康检查真实接线；切换 Driver 保持客户端契约/数据责任；无 DSH/pi 时 native/replay 可运行，崩溃后已受理工作可追踪 |
| 5 Inbox 与扩展 | followup/steer/inject、压缩、Skill、Subagent/Workflow 经受控 Port/Contribution 接入；独立子任务可审计、上下文隔离且递归受限；外部 Adapter 通过兼容、许可证及安全验收 |

<a id="阶段-5inbox压缩与高级能力"></a>

阶段 5 的数据合同由 [ADR-017](adr/ADR-017-context-manifest-modelrun-step.md)规定，工具授权仍遵守 §9。模型可见工具名必须匹配 `[A-Za-z0-9_-]+`；高级能力通过扩展点组合，不另写一套 Loop 或绕过状态机。

## 16. 测试与验收

### 16.1 必测矩阵

下面链接到当前测试入口，描述必须持续守卫的行为；文件存在不代表所有目标均已验证，也不替代本次运行结果。

| 行为 | 当前测试入口 | 验收边界 |
|---|---|---|
| 契约、回放与状态机 | [contract](../../packages/core/test/contract.test.ts)、[replay](../../packages/core/test/replay.test.ts)、[state-machine](../../packages/core/test/state-machine.test.ts) | 确定性与终态唯一 |
| fencing 与原子提交 | [executor-fencing](../../packages/core/test/executor-fencing.test.ts)、[SQLite Store](../../packages/host-agent/test/sqlite-execution-store-fencing.test.ts) | 旧执行器不能提交 chunk、工具结果或终态；全体旁路仍须覆盖 |
| 审批与工具 | [tool-policy](../../packages/core/test/tool-policy.test.ts)、[tool-ledger](../../packages/core/test/tool-ledger.test.ts)、[adapter-contract](../../packages/core/test/adapter-contract.test.ts) | 权限、预留、未知结果与 Adapter 批次翻译；原生终端工具合同仍待实现 |
| 恢复 | [recovery](../../packages/core/test/recovery.test.ts)、[resume-source](../../packages/host-agent/test/sqlite-resume-source.test.ts) | 首片段前重试、可见后中断、确定结果续跑和合成结果；生产接线与完整故障矩阵独立验收 |
| 输入与上下文 | [inbox](../../packages/core/test/inbox.test.ts)、[Inbox API](../../apps/api/test/inbox-routes.test.ts)、[context-manifest](../../packages/core/test/context-manifest.test.ts) | 受控消费与当前快照粒度；每请求来源证据链仍待闭合 |
| 限额与取消 | [budget](../../packages/core/test/budget.test.ts)、[control-context](../../packages/core/test/control-context.test.ts)、[cancel](../../packages/core/test/cancel.test.ts) | step/token/time/tool 限额与取消传播；费用和 Provider 窗口不得由字节预算替代 |
| Host 与 Provider | [profile](../../packages/host-agent/test/profile.test.ts)、[host-health](../../packages/host-agent/test/host-health.test.ts)、[provider-parity](../../packages/core/test/provider-parity.test.ts) | native/replay 独立可用与接口一致；真实 DSH/pi 运行时另验 |

SSE 必须验证持久后发送、高水位补读、弱网重连与游标过期，见[流式协议](STREAMING_PROTOCOL.md)及[测试策略](TEST_STRATEGY.md)。删除/撤权后的零召回、零副作用和 fail closed 必须跨 API、Host、记忆与工具路径验证，不能只由 Loop 单元测试证明。

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

### 16.4 落地进展与追溯

代码合入与发布证据维护于[追踪基线](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)，原阶段 2b～6f 的历史记录见 §15 的归档入口。新增证据直接关联 PR 与自动化测试，不在本文追加终端日志或复刻历史状态表。

## 17. 回滚策略

- 当前保留 Replay Provider 作为无外部模型依赖的可回退执行路径；
- 新增表先 Expand，不删除旧字段；
- Native Loop 失败时可以切换 Replay/固定保守响应 Driver，但不能重放已产生副作用的 Turn；
- 独立 Agent Host 回滚为 API 内嵌 Driver 时保留相同 claim/fencing；
- DSH/pi Adapter 异常时禁用 Adapter，保留 Aervox 原生 Turn、事件和导出；
- 回滚不得删除已提交的安全片段、ModelRun、ToolExecution 或审计记录。

## 18. 决策与后续文档

当前需要推进哪些决策以及它们的先后关系，由根 [plan.md](../../plan.md)维护。本节保留实施相关阶段时必须处理的架构决策范围，不能用计划中的排序代替评审或豁免验收。

新增或改写以下已接受边界前，须按 CR/ADR 流程审议；已有 [ADR-017](adr/ADR-017-context-manifest-modelrun-step.md) 的关联链和 Inbox 决策无需重复立项：

- 独立 `apps/agent` 部署、接单和恢复所有权；
- AgentStep/ToolInvocation 的持久模型或既有模型关联基数；
- 默认 Step、时间、成本和并行上限；
- Native/DSH/pi Driver 与 Model Provider 的兼容等级；
- followup/steer/inject 公开范围、权限或唤醒语义的变化。

实现每一阶段后必须更新[需求追踪基线 §4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)，并在[参考设计迁移 §6.1](../explanation/reference-design-transfer.md#61-落地登记唯一真源)查询 `DSH-01` 与 `PI-01` 来源说明。

## 19. 机器验证

文档使用 `mise tasks run ci-docs` 校验。代码落地后，Manifest、Port、事件、数据库状态机和 Provider parity 必须由 schema/contract tests 机器验证；任何只写在本文、无法由类型、schema、测试或运行时断言约束的关键不变量都视为未完成。

## CR-056 执行边界补充

所有 Driver 的准入控制遵循[ADR-010 控制合同](adr/ADR-010-dsh-pi-adapters.md#cr-056-控制合同补充)。宿主注入产品上下文及控制，Loop 不依赖具体数据库或 UI。先保留既有原生 claim、账本与终态拥有者，再通过等价测试迁移装配。客户端暂态进度不能覆盖权威终态；HTTP/SSE 继续使用既有契约，新增水位必须先进入流式契约。此处是已接受约束，具体实现进度见 CR-056（已归档至 Aervox-docs-archive）。
