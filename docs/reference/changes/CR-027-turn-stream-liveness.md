---
id: CR-027
type: reference
scope: change
owner: architecture
doc_status: review-candidate
decision_status: proposed
delivery_status: implemented
version: 0.1.0
updated_at: 2026-08-29
reviewed_at: 2026-08-29
review_interval_days: 90
sources:
  - docs/reference/STREAMING_PROTOCOL.md
  - docs/reference/adr/ADR-015-vue-full-stack.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-027 Turn 流活性治理：执行解耦、SSE 活流与思考增量透传

- 提出人：3yearszhuang · 2026-08-29
- 修改人：3yearszhuang · 2026-08-29

关联：[流式协议](../STREAMING_PROTOCOL.md)、[需求追踪基线 §4.2](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)

## 变更原因

深度思考（思考型模型）回合必现 `desktop_turn_timeout: no terminal event received within 60000ms`。根因是三重叠加：

1. **创建与执行同步耦合**：`POST /v1/sessions/:id/turns` 内联 `await runLoopTurnOnce`，整个 Agent Loop（多步思考 + 工具调用）跑完才返回 `eventsUrl`；
2. **SSE 为事后重放**：`GET /v1/turns/:id/events` 只读一次已落库事件即 `end()`，无活流 tail、无心跳；客户端在整个回合期间收不到任何数据；
3. **客户端 60s 绝对总时限**：桌面 transport 从发消息起计时，60s 无终结事件即报错——长思考回合必然命中。

放大因素：上游 LLM 请求超时为 45s **硬总时限**（未配置、不可调，覆盖整个步骤而非空闲期）；思考增量（`reasoning_content`）被 provider 捕获后完全不上抛，即使有活流思考期也是静默的；超时后渲染层仅解绑 IPC listener，主进程 fetch 继续跑完，形成"UI 已失败、后台幽灵回合继续消耗 tokens"。

## 目标行为

- **执行解耦**：`POST /turns` 落库（turn + attempt）后立即 `201` 返回，Loop 后台执行。`AERVOX_TURN_EXECUTION=background|inline`（`@aervox/config`，默认 `background`）；`inline` 保留旧同步语义供测试/排查。后台执行的异常已在 `runLoopTurnOnce` 内部落 `error` 事件 + `Failed` 终态，路由侧兜底 `catch` 防 unhandledRejection；
- **SSE 活流**：`GET /v1/turns/:id/events` 重写为「重放 + 轮询 tail + 心跳」——先全量重放已落库事件；若 Attempt 未达终态，以 400ms 节拍轮询增量（按 `sequence` 高水位续读）、15s 无数据发 SSE 注释心跳（`: ping`）、检测到 Attempt 终态后排空残余事件再关闭；10min 兜底上限。Attempt 已终态（inline 模式/历史回合）保持重放即断的旧语义，既有断言 `first.body === second.body` 的幂等重放测试不变；
- **思考增量透传**（各供应商格式，2026-08 调研结论）：
  - `delta.reasoning_content`——DeepSeek / Qwen（DashScope `enable_thinking`）/ vLLM 事实标准；
  - `delta.reasoning`——OpenRouter 统一字段、Ollama 兼容端点；
  - OpenAI 官方 Chat Completions 不透出原生推理（走 Responses API），自然缺省；
  - Anthropic `thinking_delta` 仅作命名参考（宿主接线层仍拒绝 Anthropic 协议）。
  - provider 双格式解析后以 `ModelChunk.reasoning` 上抛（非正文，不进历史/安全片段）；executor 按「≥200 字符或 ≥400ms」节流落 `reasoning_delta` 流事件；思考增量视为模型活性，抑制首片段前重试；
- **空闲超时语义**：
  - provider `timeoutMs` 改为空闲超时（连接/首包/每段流数据重置）；租户 LLM 配置新增 `settings.requestTimeoutMs` 透传（默认仍 45s 空闲）；
  - 桌面 transport 的 60s 绝对时限改为空闲超时（每收到一条桥消息重置）；fetch transport 同样加 60s 空闲超时（`TURN_STREAM_IDLE_TIMEOUT_MS`）；
  - 主进程转发 SSE 注释心跳为 `{type:'heartbeat'}` 桥消息，维持渲染层空闲计时；
- **取消闭环**：渲染层空闲超时触发时经 `cancelTurn(requestId)` → 主进程 `AbortController` 中止上游 POST/SSE，消除幽灵回合；主进程对已取消请求不再回发 `error`；preload/env.d.ts 同步透出 `cancelTurn` 与 `requestId` 透传；
- **UI 思考反馈**：工作台 `onReasoning` 在正文到达前展示「思考中…」占位，首个正文 delta 清除；回合结束仍无正文时换兜底文案。

## 范围外

- SSE `Last-Event-ID`/`?after=` 游标重连（协议 §2.2 全量高水位语义，现实现为每次全量重放 + tail，后续按需）；
- Worker 化 Loop 执行（outbox 驱动独立进程执行 Turn；本次为同进程后台执行）；
- Anthropic 原生协议支持、Responses API 推理接入；
- Web 端桌宠窗口的思考动画（仅工作台文案占位）。

## 数据、契约与回滚

- 数据库：无表结构变更；`reasoning_delta` 复用 `turn_stream_events`；
- 契约：`streamEventTypeSchema` 新增 `reasoning_delta`；`reasoningDeltaEventDataSchema`（`messageId` + `text`）并注册 OpenAPI（`ReasoningDeltaEventData`）；`openapi.json` 随 contracts build 重新生成；`ModelProviderPort.stream` 返回类型统一为 `ModelChunk`；
- 环境变量：新增 `AERVOX_TURN_EXECUTION`（`packages/config`，默认 `background`）；LLM 配置 `settings.requestTimeoutMs`（租户级，经既有 settings record 存储）；
- 回滚策略：`AERVOX_TURN_EXECUTION=inline` 一键回退旧同步语义；`reasoning_delta` 为新增枚举值，旧客户端忽略未知事件类型不受影响（协议 §4.7 既有约定）；空闲超时阈值不变时行为只放宽不收紧。

## 验证与决策

- `packages/agent-loop/test/openai-compat-provider.test.ts`：`reasoning_content` / `reasoning` 双格式透出且不混入正文；`llm_timeout` 空闲语义回归；
- `packages/agent-loop/test/executor.test.ts`：reasoning 增量以 `reasoning_delta` 落库、序号连续、不占正文 delta；
- `packages/api-client/test/desktop-transport.test.ts`：空闲超时触发、逐消息重置（总耗时超旧绝对时限不误报）、超时调用 `cancelTurn`、`onReasoning` 转发；
- `apps/api/test/conversation-loop.test.ts`：background 模式 POST 立即 201 且 SSE 活流在终态后排空结束；inline 模式 POST 返回即终态；
- `apps/api/test/conversation-cancel.test.ts`：以 SSE 活流为「回合已完成」屏障规避 background 竞态；
- 全仓 `pnpm build` / `pnpm typecheck` / `pnpm test`（20 任务全绿）。

决策：采用「后台执行 + 轮询 tail」而非「订阅总线」——`SqliteExecutionStore` 的 done/delta/tool 事件在各自事务内直写 `turn_stream_events`，无统一发布点可挂订阅；SQLite 单机场景下 400ms 轮询的成本可忽略，且不侵入 executor/原子提交路径。
