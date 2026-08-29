# Aervox｜思隅 Turn 流式协议（SPC）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-29

> 文档编号：AVX-SPC-001  
> 版本：v0.3（评审候选）  
> 更新日期：2026-08-29  
> 状态：Review Candidate  
> 关联：`ADR-002`、`ADR-012`、`CR-019`、`CR-022`、`CR-027`、`NFR-PERF-001`、`NFR-REL-001`、`NFR-SEC-001`

本文是对话流式 API 和客户端行为的可执行契约。OpenAPI 3.1 描述 HTTP 资源、鉴权和错误；本文件描述 SSE 事件 envelope、状态机、重连、取消、幂等和持久化顺序。实现必须从同一份 `packages/contracts` schema 生成服务端校验、客户端类型和契约测试，不能只依赖本文件中的示例。

## 1. 适用范围与不变量

- 普通教学/陪伴对话可以分段流式展示；日记、记忆 Revision、掌握度/评分、题目答案规范、公开内容和工具授权结果必须完整验证后原子发布，不发送渐进片段。
- Provider 的原始 chunk 只能进入服务端有界缓冲。只有通过 purpose 对应安全/结构/来源检查、已经提交数据库事务的内容才可发送给客户端。
- 所有业务事件属于一个 `workspaceId` 和 `turnId`。每次重连重新鉴权、检查同意和删除状态；不能用旧连接权限继续重放。
- 用户可见结果的事实源是持久化 `TurnStreamEvent` 和最终 `MessageVersion`，不是 Redis、内存 buffer 或客户端缓存。
- `Turn` 是唯一对外资源和流聚合；自动重试由内部 `TurnAttempt` 执行，客户端不得依赖 Attempt 身份或供应商请求 ID。

## 2. 资源与 HTTP 接口

### 2.1 创建 Turn

`POST /v1/sessions/{sessionId}/turns`

必需请求头：

| Header | 要求 |
|---|---|
| `Authorization` | 按当前登录方式鉴权；不允许把 bearer token 放入 URL |
| `Idempotency-Key` | 调用方生成的稳定键；同一认证主体、工作区、规范化端点、Session 和键只产生一个 Turn |
| `Content-Type` | `application/json` |

请求体最小字段：

```json
{
  "message": { "content": "...", "contentType": "text" },
  "clientVersion": "web-0.1.0",
  "references": []
}
```

成功响应 `201 Created`（重复幂等请求可返回 `200 OK`）至少包含：

```json
{
  "turnId": "turn_01...",
  "status": "Created",
  "eventsUrl": "/v1/turns/turn_01.../events",
  "cancelUrl": "/v1/turns/turn_01.../cancel"
}
```

服务端必须先在一个事务中写入 User `MessageVersion`、Turn 和 Outbox，再返回成功。相同幂等作用域、键和请求摘要必须返回原资源；同键不同摘要返回 `409 IDEMPOTENCY_KEY_REUSED`，不得再次调用模型。`workspaceId` 必须由认证主体和 `sessionId` 在服务端解析，不能信任请求体或自定义 Header。

### 2.2 读取事件流

`GET /v1/turns/{turnId}/events`

请求头：`Accept: text/event-stream`。客户端使用 Fetch streaming 读取，以便发送标准鉴权头和 `AbortSignal`；原生 `EventSource` 不是必需客户端。

Turn 执行与建流解耦（CR-027）：`POST /turns` 在落库后立即返回（`AERVOX_TURN_EXECUTION=background`，默认），Loop 后台执行。事件流端点采用「重放 + 活流 tail」：先全量重放已落库事件（断线重连同样由此恢复完整序列）；若 Attempt 未达终态，服务端持续按 sequence 高水位补拉增量并周期性发送 SSE 注释心跳（`: ping`），直至 Attempt 终态后排空残余事件再关闭连接。Attempt 已终态（历史回合/inline 模式）时重放即关闭。长思考回合期间流内始终有业务事件（含 `reasoning_delta`）或心跳，客户端不得以固定总时限判断回合失败，应以「空闲超时」判定连接失活。`AERVOX_TURN_EXECUTION=inline` 保留「POST 返回即事件就绪」的旧同步语义，仅用于测试与排查。

服务端使用高水位算法避免“重放结束、实时订阅建立之前”丢事件：先在一致性读取中取得 `replayUpperBound`，重放 `(cursorSequence, replayUpperBound]`；建立实时订阅后再次从数据库补拉到当前最新 sequence，再发送实时事件。允许重复投递但不得出现 sequence 空洞。游标优先使用 `Last-Event-ID: {eventId}`；若运行环境不能设置该头，可使用同值的 `?after=` 查询参数，但不得同时提供互相冲突的两个游标。服务端必须把 `eventId` 解析到对应 `(turnId, sequence)`，拒绝不存在、跨 Turn 或当前主体无权访问的游标。

建流前错误使用 RFC 9457 Problem Details；建流后的业务错误必须先持久化为事件再发送。响应使用 UTF-8 SSE framing、`Cache-Control: no-store` 和禁用代理缓冲；终态 `done` 提交并发送后关闭连接。

### 2.3 取消 Turn

`POST /v1/turns/{turnId}/cancel`

请求必须带 `Idempotency-Key`。服务端使用 compare-and-set 将 `Running/Finalizing` 更新为 `CancelRequested`，停止 Provider/工具提交；已提交安全片段保留，后续片段不得提交。重复取消返回同一个终态，不产生新的 Turn 或工具副作用。

## 3. Turn 状态

```text
Created -> InputChecking -> Running -> Finalizing -> Completed
   |             |             |          |
   +-----------> Rejected      +-------> CancelRequested -> Cancelled
                                 +------> Interrupted
                                 +------> Failed
```

| 状态 | 客户端含义 | 是否可产生普通记忆/掌握度/日记来源 |
|---|---|---|
| `Created/InputChecking/Running/Finalizing` | 处理中；可继续读取事件 | 否 |
| `Completed` | 最终结果已验证并提交 | 是，仍受各领域规则约束 |
| `Rejected` | 输入、权限或安全策略拒绝 | 否；固定安全响应可另建独立完成结果 |
| `Cancelled` | 用户或策略取消 | 否 |
| `Interrupted` | 已发送安全前缀但基础设施中断 | 否；历史可显示“不完整” |
| `Failed` | 无可发布结果或最终校验失败 | 否 |

自动重试只允许由新的 `TurnAttempt` 在尚未提交任何用户可见片段且没有外部工具副作用之前发生。首片段之后的恢复必须把原 Turn 标记为 `Interrupted`，由用户显式发起新 Turn；不得在原 Turn 内从头拼接非确定性的第二份回答。

## 4. 事件 envelope 与事件类型

每一条业务 SSE 事件使用以下 envelope：

```json
{
  "eventId": "tev_01...",
  "turnId": "turn_01...",
  "sequence": 7,
  "eventType": "delta",
  "payloadVersion": 1,
  "occurredAt": "2026-08-24T08:00:00.000Z",
  "modelRunId": "run_01...",
  "data": {}
}
```

`eventId` 全局稳定且不可复用，`sequence` 在同一 Turn 内从 1 单调递增且唯一，`payloadVersion` 采用整数版本。SSE `id:` 字段必须等于 `eventId`；网络重试可以重复投递，客户端按 `eventId` 去重，并用 `sequence` 检测空洞或乱序。heartbeat 是无 `id` 的 SSE comment，不是业务事件，也不占用 sequence。

### 4.1 `message`

表示 Assistant Message 身份已创建或可见元数据已提交。`data` 至少包含 `messageId`、`role`、`contentType` 和 `isComplete=false`。

### 4.2 `delta`

表示一段已通过安全门且已持久化的可见正文。`data` 至少包含 `messageId`、`text`、`isFinal=false`。服务端不得发送未持久化或未经检查的 Provider token。

### 4.2.1 `reasoning_delta` (CR-027)

思考型模型的思考进度增量，`data` 包含 `messageId` 与 `text`。**非正文**：不进消息历史与安全片段，不参与 `TTFT` 与派生事实，仅作为长思考期间的活性信号与「思考中」进度反馈。来源为 OpenAI 兼容流的 `delta.reasoning_content`（DeepSeek / Qwen / vLLM）或 `delta.reasoning`（OpenRouter / Ollama 兼容端点）双格式；OpenAI 官方 Chat Completions 不透出原生推理时自然缺省。思考增量计入流活性：客户端的空闲超时计时器收到该事件同样重置。客户端对未知事件类型应忽略不影响既有展示。

### 4.3 `done`

表示 Turn 终态已提交。`data` 至少包含 `status`、`messageId`（如有）、`isComplete`、`lastSequence` 和 `contextVersion`。只有 `status=Completed` 且 `isComplete=true` 的结果可触发普通下游派生；`Cancelled/Interrupted/Failed/Rejected` 的安全前缀只能作为明确标记的不完整历史保留。

### 4.4 `error`

表示已持久化的错误诊断。`data` 至少包含 `code`、`retryable`、`message`（用户可见且不泄露内部细节）和 `lastSequence`；不得包含完整 Prompt、凭据、Restricted 原文或供应商秘密。`error` 本身不是终态，服务端随后必须提交并发送一个带 `Rejected/Cancelled/Interrupted/Failed` 状态的 `done`，客户端只以 `done` 判断流结束。

### 4.5 `redacted`

表示某个已持久事件或正文因来源删除、同意撤销或权限变化而不再可见。`data` 至少包含 `targetEventId`、`visibilityRevision`、`reasonCode` 和不含原文的替代状态；原事件不可改写，客户端收到后必须停止展示和使用被撤回正文。

### 4.6 `user_question_required` 与 `user_question_answered` (UQ-01)

- `user_question_required`：表示模型在执行过程中调用 `ask_user_question` 发起向用户提问与决策确认，Step 挂起等待。`data` 包含 `turnId`、`step`、`questions` 数组（含 `id`、`question`、`header`、`detail`、`options`、`multiSelect`、`intent`）以及 `timeoutMs`。
- `user_question_answered`：表示用户已提交对该问题的回答（通过 `POST /v1/turns/:turnId/questions/answers`），Loop 被唤醒继续执行。`data` 包含 `turnId` 与 `answers` 数组。

### 4.7 `tool_approval_required` (PET-05 / CAP-009)

表示模型请求的写工具（如 `aervox_diary_write`、`aervox_memory_store`）尚未获得用户授权，本次 Attempt 以 `Interrupted` 结束等待授权。`data` 包含 `approvalId`、`toolName`、`argumentsHash`。用户经 `POST /v1/turns/:turnId/tool-approvals` 提交决定（`granted`/`denied`）；授权后由客户端重发相同请求命中 `granted` 记录（工具名 + 参数哈希匹配），模型重新请求该工具时才真正执行。客户端对未知事件类型应忽略不影响既有展示。

标准错误码：

| Code | HTTP/流语义 | 客户端动作 |
|---|---|---|
| `IDEMPOTENCY_KEY_REUSED` | `409`，不打开新流 | 修正请求键或读取原 Turn |
| `TURN_NOT_FOUND` | `404` | 停止重连并刷新权限/历史；响应不得泄露跨工作区资源是否存在 |
| `STREAM_CURSOR_EXPIRED` | `410` | 读取 Turn 当前状态和已持久化 MessageVersion；不得自动再次调用模型 |
| `TURN_CANCELLED` | `error` 后以 `done(status=Cancelled)` 终止 | 标记不完整，不生成派生事实 |
| `MODEL_TIMEOUT` | 可重试；无可见片段且无副作用时可由新 Attempt 重试 | 显示重试入口，保持原 Turn 幂等 |
| `MODEL_UNAVAILABLE` | 降级或可重试 | 只切换已评估 Provider；无合格备用时保留输入 |
| `OUTPUT_SAFETY_BLOCKED` | 终止 | 显示保守响应/重试状态，不展示被拦截正文 |
| `PERMISSION_REVOKED` | 终止 | 清除本地未提交展示，重新获取权限状态 |

## 5. 重连、保留与断点恢复

1. 客户端保存最后已处理的 `eventId`，断线后以 `Last-Event-ID` 重连；服务端解析该事件的 sequence，先重放同一 Turn 中 `sequence > cursorSequence` 的持久事件。
2. 重放及实时连接存续期间，每个业务事件发送前都必须校验当前授权/同意策略版本；成员移除、来源删除、同意或插件/外部权限撤销必须主动关闭相关连接。仍可披露撤回状态时发送不含旧正文的 `redacted`，否则返回不泄露资源存在性的统一终止结果；不得把历史正文重新泄露。
3. `TurnStreamEvent` 是传输/恢复数据而非长期会话副本。MVP 在线正文重放窗口默认 24 小时，具体值必须进入保留策略；任何事件正文的保留上限不得超过对应 `MessageVersion` 的可见保留、有效同意和来源可用期三者中的最短者。窗口结束、来源删除或权限撤销后只保留不含正文的最小事件元数据/tombstone，长期历史由 `MessageVersion` 承担。
4. 游标过期返回 `410 STREAM_CURSOR_EXPIRED` 和当前 Turn 状态/`lastSequence`。客户端只能读取已持久化 MessageVersion 或显示重新开始按钮，不得隐式重跑模型。
5. 客户端收到重复、乱序或未知 `payloadVersion`：按 `eventId/sequence` 去重；未知版本停止渲染并请求兼容降级，不猜测字段含义。

## 6. 超时、失败、降级和取消

- 服务端必须限制 Turn 总时长、累计输出、单段大小、并发流和空闲时间；SSE heartbeat 只维持连接，不改变业务状态。Provider 上游超时应采用**空闲超时**语义（每收到一段流数据即重置，含思考增量），不得以固定总时限掐断持续输出的思考型模型（CR-027）；租户可经 LLM 配置 `settings.requestTimeoutMs` 调整空闲上限。客户端（Web/Desktop）侧同样以空闲超时收敛 UI，超时后必须中止上游在途请求（如桌面 `cancelTurn` IPC → 主进程 `AbortController`），避免"UI 已失败、后台继续消耗 tokens"的幽灵回合。
- Provider 超时/5xx/限流按路由策略熔断；只可切换已通过同一 EvalSet 和安全审查的备用模型。没有合格备用时保留 User Message，返回可重试状态。
- 输出安全分类服务不可用时，普通对话停止发送新片段；高风险输入使用固定保守响应。不得为降低延迟跳过安全门。
- API/Worker 崩溃后，恢复器依据 Turn 状态和最后 sequence 决定是否用新 `TurnAttempt` 重试或收敛为 `Interrupted`；旧 Worker 必须通过 fencing token，不能晚提交。
- Provider、工具调用和权限决定如需暴露，使用独立事件类型和权限检查；模型请求工具不等于已获授权。

## 7. 可观测性与测试门禁

TTFT 定义为：Turn POST 被服务端接受，到第一个**通过安全门且已持久化**的用户可见 `delta` 提交的时间。必须分别记录输入检查、Provider 首 token、片段缓冲、安全检查、数据库提交和网络发送耗时。

进入 G1 前必须有契约和故障测试：幂等重复提交、事件 sequence 唯一、断线/刷新/Last-Event-ID 重放、游标过期、取消 CAS、首片段前重试、首片段后 Interrupted、旧 Worker fencing、Provider 降级、分类服务不可用、删除/撤权后重连、原始 Provider chunk 不出现在客户端/日志，以及高完整性产物不渐进展示。测试 ID 至少包括 `TC-CONTRACT-STREAM-001`、`TC-RES-STREAM-001`、`TC-SEC-STREAM-001` 和 `TC-E2E-STREAM-001`。

## 8. 兼容与变更

新增字段必须向后兼容；删除或改变事件语义必须提升 `payloadVersion`、更新 OpenAPI/JSON Schema 和变更请求，并保留上一版本客户端的兼容窗口。替换 AI SDK、Provider 或传输实现不得改变 Turn/TurnStreamEvent 状态和幂等语义。
