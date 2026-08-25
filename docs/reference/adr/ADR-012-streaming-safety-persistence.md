# ADR-012 可恢复 Turn 流式协议、输出安全门与部分响应持久化

- 状态：Proposed（待技术、安全/隐私、AI 质量与 QA 负责人批准）
- 日期：2026-08-24
- Owner：待指定
- 关联：`CAP-002/007/008`、`NFR-PERF-001`、`NFR-REL-001`、`NFR-SEC-001`、`NFR-OBS-001`、`AIQ-TEACH-001`、`AIQ-SAFE-001`、`BR-CTRL-001`

## Context

对话需要低延迟流式体验，但系统同时承诺：

- 输出在展示前经过适用于其 purpose 的安全、结构和来源校验；
- 页面刷新、网络重连或 API 进程崩溃后，不丢失已交付的安全内容；
- 重复提交和重连不创建第二个 Turn、Assistant Message 或下游记忆候选；
- 日记、记忆、评分等高完整性产物必须全量验证后原子发布；
- 客户端、Electron、移动端和未来非 TypeScript 消费者使用稳定协议。

“SSE/Fetch streaming”如果不定义请求拆分、事件 ID、重放和持久化顺序，会产生实现歧义。直接把供应商 token 转发给浏览器，会绕过输出安全门；只在完整响应结束后落库，则 API 崩溃时可能丢失用户已经看到的内容。

## Decision drivers

- 原始供应商输出不能绕过服务端安全与权限边界；
- 已发送给用户的业务内容必须有可审计的持久事件；
- 重连是至少一次交付，客户端可以可靠去重；
- 用户取消和进程崩溃具有明确、可恢复的状态；
- 保持 TTFT 可测量，同时不为低延迟牺牲危机响应和 Restricted 内容规则；
- 核心协议可由 OpenAPI/事件 schema 描述，不绑定浏览器原生 `EventSource`。

## Considered options

1. **单个 POST 直接返回供应商 Fetch stream**：延迟最低，但不能可靠恢复、重放或保证展示前安全检查。
2. **所有输出完整缓冲、全量验证后一次返回**：边界最清楚，但普通教学对话失去流式体验，TTFT 退化为完整响应时间。
3. **WebSocket 双向会话**：能承载实时消息，但 MVP 不需要任意双向协作，会增加连接状态、扩缩容和恢复复杂度。
4. **POST 创建 Turn + Fetch 消费 SSE 事件；服务端分段安全门和持久化后再发出**：兼顾稳定资源身份、重连、低延迟和展示前检查。

选择方案 4。高完整性产物仍采用方案 2 的“完整验证后原子发布”行为，不使用渐进展示。

## Decision

### 1. 协议形态

一次用户输入分为两个协议步骤：

1. `POST /v1/sessions/{sessionId}/turns`
   - 请求包含 `Idempotency-Key`、用户消息、客户端版本和可选引用；
   - `workspaceId` 只能由服务端从 `sessionId` 和认证主体解析，不能信任 Header/body；请求在查幂等记录前必须完成 Session、workspace、purpose 和来源权限校验；
   - 服务端先持久化 User Message、Turn、TurnAttempt 和 Outbox，再返回 `turnId`、当前状态和 stream URL；
   - 幂等键作用域至少包含认证主体、workspace、HTTP method、规范化路由和 session；服务端保存规范化请求摘要、响应状态/正文和资源 ID。同一作用域同一键同一摘要返回原响应；同键不同摘要返回 `409 idempotency_key_reused`，不得返回旧资源；并发请求由数据库唯一约束和唯一 Outbox 约束收敛；
   - `Idempotency-Key` 使用可打印 ASCII、长度 1～255，保留期至少覆盖客户端最大重试窗口，过期记录不得被用来探测资源存在性。
2. `GET /v1/turns/{turnId}/events`
   - 使用 `text/event-stream` framing，但客户端通过 Fetch 读取，以支持标准鉴权 Header、AbortSignal 和桌面/移动端复用；
   - 客户端使用 `eventId` 形式的 `Last-Event-ID` Header（Header 优先于等价 query cursor）；服务端将其映射并校验为该 Turn 的 sequence，拒绝跨 Turn 游标；不得把 bearer token 放入 URL；
   - SSE 使用 UTF-8 的 `id`、`event`、`data` 行和空行分帧；`id` 为不可变 `eventId`，`data` 是版本化 JSON envelope。公开业务事件统一为 `message`、`delta`、`done`、`error`、`redacted`，heartbeat 使用无 `id` 的 SSE comment；终态事件发送后服务端关闭连接；建流前错误使用 RFC 9457 Problem Details，建流后错误只能以已持久化终态事件表达；响应使用 `Cache-Control: no-store`，禁止 CDN 缓存和代理缓冲；
   - 重放采用高水位协议：在读取事务中确定 `replayUpperBound`，注册实时订阅后再次补拉至当前最新 sequence，再发送实时事件；补拉可重复但不得出现 sequence 空洞。不能只执行“先重放、后订阅”的非原子顺序。

OpenAPI 描述 Turn 资源和 `text/event-stream` 响应；每种 `TurnStreamEvent` payload 另有版本化 JSON Schema。未来若引入 WebSocket，必须保持 Turn/TurnStreamEvent 语义不变。

### 2. Turn 状态机

```text
Created
  -> InputChecking
  -> Running
  -> Finalizing
  -> Completed

Created/InputChecking
  -> Rejected

Running/Finalizing
  -> CancelRequested -> Cancelled
  -> Interrupted
  -> Failed
```

- `Rejected`：输入安全或权限不允许模型调用；固定安全响应可作为同一 Turn 中服务端生成、已审计的 Assistant MessageVersion，但该 Turn 仍以 `Rejected` 终态结束，不能把拒绝状态伪装成普通模型完成。
- `Interrupted`：基础设施中断且已经交付至少一个安全片段；不得自动从头拼接另一份非确定性回答。
- `Failed`：未产生可发布结果或最终完整性校验失败。
- 每个 Turn 通过内部 `TurnAttempt` 执行；Attempt 具有递增编号、lease、fencing token 和状态，同一 Turn 同时最多一个活动 Attempt。每个 `TurnStreamEvent`、工具调用和终态提交都关联 `attemptId`，只有当前 lease/fencing token 能追加事件或推进状态；`TurnAttempt` 不作为客户端资源暴露。
- 自动重试只允许发生在尚未持久化任何用户可见片段且没有外部工具副作用的 Attempt；工具调用必须有独立幂等键、授权快照和执行记录。一旦已有片段或外部副作用，后续重试由用户显式发起，并产生新的 Turn/Message version；取消不能承诺撤销已完成的外部动作。

### 3. 输出安全门

原始 Provider stream 只进入服务端受控缓冲，永远不能直接写入 HTTP 响应、日志、分析或业务 Message。

普通教学/陪伴对话采用分段安全门：

1. 将原始 token 聚合为有界语义片段或达到最大等待时间的片段；
2. 按 purpose 执行输出安全、角色边界、格式和必要的来源/引用检查；检查输入是“候选片段 + 已发布前缀”的滑动窗口/累计语义状态，不能只独立检查单个片段；高风险类别自动升级为全量缓冲；
3. 检查通过后，在一个事务中持久化 `TurnStreamEvent(delta)`、安全决策引用和 Assistant Draft 的安全前缀；
4. 事务提交后才向客户端发送该事件。

高风险或高完整性输出不渐进展示：

- 危机/紧急安全路径使用经过批准的固定响应，或完整缓冲后验证；
- 日记、记忆 Revision、掌握度/评分、题目答案规范、公开内容和工具授权结果必须全量结构化验证后原子发布；
- 输出安全分类服务不可用时，不发送未经验证的新片段。高风险输入返回固定保守响应；普通对话停止并显示可重试状态。

最终完整性检查可以拒绝尚未发送的尾部，但不能把已发送片段追认为“从未展示”。发现已交付片段存在事后风险时，应记录 Incident、停止后续输出并按政策在 UI 标记/隐藏，而不是篡改审计历史。

安全决策引用必须固定 policy/model/version、输入内容哈希和判定时间，能够在审计时重现当时的检查依据。客户端默认按纯文本或受限 Markdown 渲染，禁止直接插入 HTML；链接、引用和工具结果使用结构化字段并通过 allowlist。

### 4. 持久事件与客户端一致性

`TurnStreamEvent` 至少包含：

- `workspaceId`、`subjectUserId`、`turnId`、`attemptId`、单调递增 `sequence`、不可变稳定 `eventId`；
- `eventType`、`payloadVersion`、`createdAt`；
- 对用户可见片段的内容或内容引用；
- 安全/结构校验决策引用；
- 事件是否构成 Assistant Message 的可见正文。

不变量：

1. 任何用户可见片段在发送前必须存在已提交的 `TurnStreamEvent`；`delta` 事件按 append-only offset/sequence 重建 Assistant Message，不能靠网络到达顺序覆盖正文。
2. 同一 Turn 的 sequence 连续且唯一；网络层可以重复发送，客户端按 eventId 去重并用服务端映射的 sequence 检测空洞。
3. SSE 事件只来自调用者有权访问的 workspace、session 和 purpose；Session、Turn、Message、TurnStreamEvent 使用同 workspace/subject 的复合外键和数据库 RLS。Worker 读取来源时必须再次校验权限和同意，避免排队期间撤权的 TOCTOU；无权访问统一返回不泄露资源存在性的错误。
4. 成员移除、Session ACL/purpose 同意变更、来源删除或撤权必须主动关闭相关现有订阅；在每个业务事件发送前重新检查授权策略版本。已撤回正文不通过改变原 `eventId` 的 payload 隐藏，而是追加带新 sequence、`visibilityRevision` 的公开 `redacted` 事件，其 payload 用 `reason=revoked|deleted|policy_changed` 区分原因；事件 ID 和 payload 不可变。上述 deny/revoke 控制先按 `BR-CTRL-001` 取得独立账本的 durable ack；本地投影水位未追平、账本不可用或存在 sequence 缺口时，相关订阅和正文读取 fail closed。
5. `Completed`、`Rejected`、`Cancelled`、`Interrupted` 和 `Failed` 都必须在同一事务中更新 Turn，并写入对应的持久 `TurnStreamEvent`。成功终态发送 `done(status=Completed)`；失败、拒绝、取消或中断可先发送诊断 `error`，但随后必须在同一终态事务提交并发送 `done(status=Rejected|Cancelled|Interrupted|Failed)`，客户端只以 `done` 判断流结束。只有事务提交后才能发送终态事件，并按策略提升/封存 Draft；只有 `Completed` Turn 可以生成普通记忆候选、掌握度或日记来源。
6. `Cancelled/Interrupted/Failed` 的安全前缀可作为用户可见历史保留，但必须标记不完整，默认不能进入学习事实或长期记忆。
7. 游标早于事件保留窗口的重连返回 `410 STREAM_CURSOR_EXPIRED`，并提供当前 MessageVersion/Turn 投影 URL；不得从现存最早事件静默续播。

原始、未通过安全门的 Provider chunk 默认仅存在于进程内有界缓冲；为安全调查确需短暂保存时，必须使用 Restricted 隔离存储、独立授权和短 TTL，不能进入常规日志或追踪。

### 5. 崩溃、重连和取消

- API/Worker 崩溃后，恢复器从持久 Turn 状态和最后 sequence 判断是否可继续；没有可见片段时可以按策略重试，有可见片段时标记 Interrupted。
- 客户端断线不自动取消模型任务；服务端按资源/预算策略继续到完成或进入可恢复状态。用户显式调用 `POST /v1/turns/{turnId}/cancel` 才请求取消；重复取消返回同一状态，不能重新执行副作用。
- Cancel 使用 CAS 更新为 `CancelRequested`。每次片段和终态事务都比较 Turn revision、当前 Attempt fencing token 和允许状态；`Finalizing` 与 Cancel 的胜者由先提交的 CAS 决定，`CancelRequested` 超时由恢复器收敛为 `Cancelled` 或 `Interrupted`。Provider abort 仅是 best effort；已提交安全片段保留，失去 fencing 的后续 chunk 不得提交。
- 工具调用、权限决定和工具结果使用独立事件；模型请求调用工具不等于授权，未经批准的工具结果不能进入用户可见流。工具副作用的执行记录和幂等键必须先于重试策略建立。
- Provider 支持幂等键时传递 `turnAttemptId`；不支持时允许崩溃窗口中的重复费用，但数据库 fencing 保证单一用户可见提交。

### 6. SLI、限额和可观测性

- 模型 TTFT 定义为：Turn POST 被服务端接受，到第一个**已通过安全门且已持久化**的用户可见片段提交的时间。
- 分别监控输入检查耗时、Provider 首 token、片段缓冲、安全检查、数据库提交和网络发送，不能只看供应商 TTFT。
- 记录 Turn/Attempt 状态、事件数、重连次数、取消、Interrupted、被拦截片段、输出检查失败和重复 Provider 调用；日志不记录完整 Restricted 内容。
- 设置最大 Turn 时长、最大累计输出、片段大小、并发流和空闲超时；SSE 使用 heartbeat 保持代理链路，但 heartbeat 不写成业务事件。
- 设置每连接有界发送缓冲；慢消费者达到阈值后断开并依靠 cursor 恢复，不能反压 Turn Worker。并发流限额按用户、workspace、Turn 和实例分别计数，超限返回 `429` 与 `Retry-After`，重连采用指数退避和 jitter。
- 事件保留期至少覆盖 Assistant Message 的在线重连窗口，并配置明确下限；长期历史由 MessageVersion 承担，不能无限保存每个传输 heartbeat。

## Positive consequences

- 输出安全门、持久化和用户展示顺序明确，不再直接暴露供应商 token；
- 页面刷新、断线和多端重连可以从稳定事件游标恢复；
- 重复 POST 和重复 SSE 事件不会形成第二个业务结果；
- 普通对话保留低延迟，高完整性产物保持原子发布；
- 协议不绑定原生 EventSource、Vercel AI SDK 或单一模型供应商。

## Negative consequences and risks

- 增加 Turn、Attempt、Event、Draft 和恢复器的数据及运维成本；
- 分段安全检查会增加 TTFT、模型/分类成本，并可能在句子边界产生短暂停顿；
- 最终检查仍可能在安全片段交付后停止回答，需要清晰的“不完整”UI；
- 持久片段增加数据库写放大，需要批处理、限额和容量测试；
- 对已发送内容只能隐藏或更正，无法保证用户从未看到，需保留事后事件处置流程。

## Migration / rollback

- 新协议以 Feature Flag 和 `/v1` 新端点灰度；旧直接 stream 只在未进入生产时保留，不能与新协议共同写同一个 Assistant Message。
- Schema 使用 expand/contract；先创建 Turn/TurnStreamEvent 表和双读投影，再切换客户端，最后删除直接 Provider stream 路径。
- 回滚应用版本时保留 Turn/TurnStreamEvent 数据，客户端可降级为轮询 Turn 状态和已持久事件；不得重新调用模型或删除已交付前缀。
- AI SDK 只作为 Provider/stream 适配实现。若替换 SDK，Turn/TurnStreamEvent 协议、状态机和安全门不变。

## Verification evidence

状态改为 `Accepted` 前至少提供：

- OpenAPI 和所有 TurnStreamEvent JSON Schema 的契约测试；
- SSE framing、事件集合、终态关闭、Problem Details/终态错误、重放高水位和游标过期 `410` 的契约测试；
- POST 幂等、并发重复提交、事件 sequence 唯一和 SSE 重放/去重测试；
- 重放与实时订阅交界并发、连接存续期间撤权/删除、同键异 payload、跨 Session/workspace 幂等冲突测试；
- 网络断线、API 崩溃、Worker 崩溃、数据库提交失败、Provider 超时和客户端刷新恢复测试；
- 原始 Provider chunk 永不直接到达客户端/日志的安全测试；
- 分段安全检查失败、分类服务不可用、危机固定响应、工具越权和删除后重连测试；
- 在首片段前自动重试、首片段后 Interrupted、显式 Cancel 和旧 Worker 晚提交 fencing 测试；
- 取消与片段/`Completed` 提交的确定性竞态、工具副作用幂等和慢消费者断开恢复测试；
- 日记、记忆、评分等高完整性产物不产生渐进可见片段的集成测试；
- TTFT 分解、数据库写放大、100 并发流、代理空闲超时和 2 倍峰值压测；
- 证明只有 `Completed` Turn 会产生记忆/掌握度/日记来源 Outbox 的端到端测试。
