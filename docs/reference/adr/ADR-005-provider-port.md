# ADR-005 内部 Provider Port 包裹 AI SDK

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-31

- 状态：Proposed
- 日期：2026-08-23
- 关联：`AIQ-TEACH-001`、`AIQ-MEM-001`、`AIQ-DIA-001`、`RISK-010`

> 更新日期：2026-08-31

## Context

模型供应商、能力、价格、地区和安全策略会变化；业务不能直接依赖某个 SDK 或 Agent runtime。BaiShou-Next 的 AI SDK 实践可作为参考，但不能成为业务真源。

## Decision drivers

- 供应商/模型/Prompt 必须可替换、可回滚；
- 数据地区、成本与安全策略需要按调用路由；
- 正常 CI 不能依赖实时供应商，需要 stub/固定回放；
- 模型只能提出候选和工具请求，不能直写业务表。

## Considered options

1. **内部 ProviderPort 包裹 AI SDK**：领域只依赖抽象接口（选定）。
2. **直接依赖 Vercel AI SDK / Agent runtime**：开发快，但供应商/SDK 变化会传导到业务层。
3. **以参考 Agent runtime（DSH/pi 等）为应用内核**：复用能力强，但核心数据所有权和运行时稳定性风险高。

## Decision

表现层采用 Vercel AI SDK 6，领域只依赖内部 `ProviderPort`：`streamText`、`generateObject`、`embed`、`classify`，并返回能力/上下文/成本/地区声明。每次调用生成 `ModelRun`、`PromptVersion`、`ContextManifest`，模型只能返回候选和工具请求。

## Positive consequences

- 可切换供应商，做数据地区和预算路由；
- 正常 CI 可用 stub/replay，不依赖实时供应商；
- 模型输出可版本化、可审计、可回滚。

## Negative consequences and risks

- 多一层适配和回归成本；
- 每次调用需维护 ModelRun/PromptVersion/ContextManifest 版本记录。

## Migration / rollback

Provider adapter 按版本并行；新模型先离线评估、灰度，再切路由。质量/安全/成本异常时 Feature Flag 回到上一模型/Prompt，不回滚业务事实。

## Verification evidence

状态改为 `Accepted` 前至少提供：

- ProviderPort 契约测试与固定回放（`TC-CONTRACT-STREAM-001`）；
- 供应商故障、结构化输出失败与降级测试（`TC-RES-DEGRADE-001`）；
- 成本/地区声明与 AI Eval 门槛（`TC-AIEVAL-LRN-001` 等）。

## 验收差距复核（2026-08-31）

- **已满足**：ProviderPort 契约与 OpenAI 兼容流测试（`@aervox/agent-loop` 阶段 2e）；CR-027 活流与空闲超时。
- **未满足**：`TC-RES-DEGRADE-001` 故障/结构化输出失败/降级矩阵；`TC-AIEVAL-LRN-001` 等 AI Eval 门槛未建立。
- **推进路径**：降级注入测试与 AI Eval 基线落地后走 G2 评审。
