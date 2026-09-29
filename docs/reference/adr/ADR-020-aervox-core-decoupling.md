---
id: ADR-020
type: reference
scope: decision
owner: maintainers
doc_status: approved
decision_status: accepted
version: 0.1.0
updated_at: 2026-09-29
reviewed_at: 2026-09-29
review_interval_days: 90
---

# ADR-020 Aervox Core 架构解耦：执行管线中间件、统一审批 SPI 与工具沙箱下沉

- 提出人：3yearszhuang · 2026-09-29
- 修改人：3yearszhuang · 2026-09-29

- 状态：Accepted
- 日期：2026-09-29
- 接受日期：2026-09-29（Aervox Core Evolution）

- 关联：`CAP-001～035`、`ADR-001`（模块化单体）、`ADR-005`（内部 Provider Port）、`ADR-014`（演进式模块化单体）、`ADR-016`（底座边界冻结）、`CR-056`（会话与 Agent 底座演进）

## Context

在 Aervox 原有架构中，智能体执行回路主要围绕 Fastify HTTP/SSE 服务构建，存在以下深层耦合：

1. **编排逻辑膨胀与单点耦合**：`apps/api` 的 `agent-executor.ts` 单文件超过 800 行，将模型流式交互、SSE 增量推送、指标可观测性收集、危机干预安全拦截、插件声明周期管理和主动智能策略死死杂糅在一个硬编码执行循环中；
2. **人机回环与传输层绑死**：工具执行前审批逻辑（Approval Gating）直接耦合 API 层的 SSE 事件流通道（`createApprovalGatedToolProvider`），导致 CLI 终端环境、无头脚本（Headless Script）以及单元自动化测试无法复用同一套安全审批逻辑；
3. **工具沙箱与 API 错误类耦合**：`ToolRuntime` 位于 `apps/api/src/modules/ecosystem/tools/runtime.ts`，其内部的代际调度、参数校验与门禁求值逻辑直接抛出 API 层的 `NotFoundError` / `ForbiddenError`，使得核心工具容器无法在脱离 HTTP 服务的轻量级 CLI 或 Worker 中独立复用。

## Decision drivers

1. **极速轻量与独立无头运行**：Aervox Core 需要能像独立内核一样在纯终端 CLI 或边缘进程中冷启动运行（毫秒级、零数据库、零 Fastify 网络服务强侵入）；
2. **洋葱模型可扩展性**：会话执行外围的横切关注点（安全门禁、指标、插件回调、错误自愈）应作为无状态或可插拔的中间件组合，核心执行器只聚焦模型-工具回路；
3. **统一三端人机回环 SPI**：工具安全审批策略抽象为通用端口协议，同一套内核在 CLI（TTY 交互提示）、Web/桌面（SSE 挂起恢复）与无头测试（自动通过/拒绝）中透明切换；
4. **工具沙箱底座下沉**：工具执行容器与代际隔离机制下沉至 `@aervox/host-agent`，API 仅保留薄层错误映射适配器。

## Considered options

1. **保持现状（硬编码在 API 编排层）**：拒绝。导致 CLI 只能写大量 mock 或依赖 HTTP 客户端绕道请求 API，无法实现真正解耦的独立内核。
2. **基于 Node.js EventEmitter 或 RxJS 驱动编排**：拒绝。事件发射驱动在错误捕获、超时传播和流式取消（AbortSignal）级联上存在隐式状态与调试黑盒风险，不符合确定性洋葱模型。
3. **洋葱模型中间件 + SPI 策略端口 + 沙箱底座下沉（本决策）**：选定。采用类似 Koa/Koa-compose 的 `ExecutionPipeline` 洋葱管道，建立 `ApprovalPolicyPort` 标准 SPI，并将 `HostToolRuntime` 下沉至核心包。

## Decision

### 1. 执行管线洋葱中间件（ExecutionPipeline）

在 `@aervox/host-agent` 中定义 `TurnMiddleware` 与 `ExecutionPipeline`：

```typescript
export interface TurnContext {
  turnId: string;
  attemptId: string;
  sessionId: string;
  userMessage?: string;
  controlContext: ControlContext;
  attributes: Map<string, unknown>;
}

export type TurnMiddleware = (
  ctx: TurnContext,
  next: () => Promise<TurnExecutionResult>,
) => Promise<TurnExecutionResult>;
```

在 `apps/api` 的会话执行器中，拆分出 4 个独立的纯中间件：

- `metricsMiddleware`：请求耗时与 Step 计数指标收集；
- `crisisSafetyMiddleware`：危机与安全分类守卫（触发时阻断执行并持久化安全终态）；
- `pluginLifecycleMiddleware`：通知生态插件生命周期钩子；
- `proactivePolicyMiddleware`：主动智能时序与门禁策略校验。

同时在内核层提供 `createErrorRecoveryMiddleware`，支持对执行中断与未捕获异常进行统一降级与安全终态收敛。

### 2. 统一审批策略接口（ApprovalPolicyPort SPI）

在 `@aervox/agent-loop` 中抽象人机回环审批 SPI：

```typescript
export interface ApprovalPolicyPort {
  evaluate(request: ToolApprovalRequest): Promise<ToolApprovalDecision>;
}
```

落地三端适配实现：

- **无头/自动化测试端**：`AutoApprovalPolicy`（支持全局通过、全局拒绝或按规则自动决策）；
- **CLI 终端交互端**：`CliInteractiveApprovalPolicy`（检测 TTY 状态，安全 fail-closed，支持控制台交互确认 `[y/N]` 与 AbortSignal 级联取消）；
- **Web / 桌面端**：`EventDrivenApprovalPolicy`（集成 API 层 SSE 挂起与状态等待机制）。

智能体执行器 `executeTurn` 原生接入 `approvalPolicy`，并通过 `withApprovalPolicy` 装饰器实现透明注入。

### 3. 沙箱容器与工具代际调度下沉（HostToolRuntime）

将原本位于 API 层的工具注册、参数模式校验、门禁求值（Gating Evaluation）与代际调度逻辑下沉至 `@aervox/host-agent` 的 `HostToolRuntime`：

- 定义与仓储层兼容的 `HostToolRegistryPort`，并提供开箱即用的 `InMemoryToolRegistry`；
- 统一下沉 `HostToolError`、`HostToolForbiddenError` 与 `HostToolNotFoundError`；
- `apps/api` 中的 `ToolRuntime` 改为直接继承 `HostToolRuntime`，仅作为将内核错误翻译为 HTTP `ApiError` 的薄适配层。

## Positive consequences

1. **核心极简解耦**：Aervox Core（`@aervox/agent-loop` + `@aervox/host-agent`）具备完整独立的执行、中间件拦截、工具沙箱和人机回环能力，可在 Node.js CLI 环境单进程独立运行（启动时间 <30ms，零外部进程依赖）；
2. **架构边界清晰**：`apps/api` 彻底退化为协议适配层（Fastify 路由、Drizzle ORM 持久化、SSE 传输），不再包含膨胀的编排私有逻辑；
3. **测试性大幅提升**：针对安全拦截、指标收集、工具审批与错误恢复的单测无需启动 API 服务器或操作 SQLite，直接在纯内存对象上完成秒级验证。

## Negative consequences and risks

1. **中间件洋葱堆栈开销**：多层 Promise 链带来微秒级调度开销（经 benchmark 实测单个 Turn 管道耗时 <0.1ms，在 LLM 推理延迟面前完全可以忽略）；
2. **上下文属性类型安全**：`TurnContext.attributes` 采用 `Map<string, unknown>` 传递跨中间件数据，需遵循属性键名规范避免命名冲突。

## Migration / rollback

- 本重构完全兼容原有 API 路由契约与 SQLite 表结构，无需数据库迁移；
- 若出现非预期行为，可随时回退 `agent-executor.ts` 调用点至直接执行，风险极低。

## Verification evidence

1. **包级单元测试**：
   - `packages/agent-loop/test/approval-policy.test.ts`（7/7 通过）；
   - `packages/host-agent/test/pipeline.test.ts`（6/6 通过）；
   - `packages/host-agent/test/cli-approval.test.ts`（7/7 通过）；
   - `packages/host-agent/test/host-tool-runtime.test.ts`（6/6 通过）。
2. **API 模块回归测试**：
   - `apps/api/test/modules/companion/agent-executor.test.ts` 等 73 个 API 核心测试套件 100% 通过；
   - `apps/api/test/modules/ecosystem/tool-runtime.test.ts` 100% 通过。
3. **无头内核全流程验证**：
   - `node scripts/run-headless-agent.mjs --smoke` 自动化 7 步验证（冷启动、对话、工具循环、超时中断、ExecutionPipeline 中间件链、审批 SPI fail-closed 拦截、零网络侵入）全部通过。
