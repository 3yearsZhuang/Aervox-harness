---
id: AVX-SPC-001
---

# Aervox｜思隅 Turn 流式协议（SPC）

关联：`ADR-002`、`ADR-012`、`CR-019`、`CR-022`、`CR-027`、`CR-030`、`NFR-PERF-001`、`NFR-REL-001`、`NFR-SEC-001`

本文是对话流式 API 和客户端行为的可执行契约。OpenAPI 3.1 描述 HTTP 资源、鉴权和错误；本文件描述 SSE 事件 envelope、状态机、重连、取消、幂等和持久化顺序。实现必须从同一份 `packages/contracts` schema 生成服务端校验、客户端类型和契约测试，不能只依赖本文件中的示例。

共享行为所有权见 [ADR-030](adr/ADR-030-behavior-ownership.md)。Fetch 与 Electron 主进程共用无 Vue 的 Turn 客户端；创建与后续订阅使用同一认证配置，业务幂等键不与 IPC 请求标识混用。受理回执先交付，再按顺序交付事件；提前 EOF 不能冒充终态成功。Electron 保留凭据和受信 sender，续跑使用有类型的观察命令，由主进程构造资源地址，不扩大任意 URL 白名单。

观察断线、窗口关闭和闲置错误只结束观察；用户明确取消才调用服务端取消入口。共享会话控制器分别表达等待答案、等待工具审批与真正执行完成，界面可改变呈现，不改变协议状态。

ConversationController 为三个第一方 surface 保存当前 Turn、待答问题、待批工具与最后已消费事件游标。受理结果未知时，显式重试复用原业务幂等键；已知 Turn 的观察失败则从该游标恢复观察，把后续正文追加到原回复，不创建新 Turn。异步事件消费者失败时不推进控制器游标；恢复观察保留已经展示的待答问题及审批。切换会话解除本地观察与状态，不代替用户取消服务端执行。尚未识别 Turn 且该预留从未出现未知结果时，明确的 API 拒绝（400/401/403/404/405/410/413/415/422）释放提交预留；408/409/425/429、服务端或网络失败保留原业务幂等键，409 幂等冲突不能证明旧请求未受理。一旦出现未知结果，后续重试的明确拒绝也不能释放旧预留。已识别的 Turn 即使观察返回这些错误也不重新提交。移动界面在提交、观察、待答、待批或未知回执时保留原所有者，只读列表/回看不解除观察；用户明确停止得到确认后，或已知终态/确定未受理后才允许实际切换或新建。

工作台两种模式、主动陪伴和桌宠共用完整问题组件，支持多问题、多选和自由填写；默认推荐项须经用户明确提交。下一问题到达时重置输入，旧回答写入返回不得清掉新问题。授权决定经服务端提交后仅观察返回 continuation 的游标，不重发原消息。

结构化 `done` 先判定持久终态再触发完成回调：`Cancelled` 为停止；`Failed/Rejected`、明确未完成或非等待原因的 `Interrupted` 为失败，保留已收正文且不提供观察重试。仅仍有待决交互并且没有中断原因（审批可为 `pending_approval`）时，`Interrupted` 保留等待；超时、删除等明确中断必须清理旧交互。只有完整成功才表示完成，不能把流正常关闭等同成功。重置、关闭或取消成功会解除本地在途回答/审批的等待，迟到响应不得改写新会话。

共享终态提交为新生成的 `done` 携带权威 outcome 的 `reason`，包括 `max_steps` 与 `pending_approval`，避免失效问题被误判为仍在等待。历史已持久化的无原因 `Interrupted` 仍可能歧义，保留旧待决交互兼容；本次不回填或改写历史事件，完整跨进程恢复另行验收。

客户端侧顺序与去重由[Schema 白名单](../../packages/contracts/src/stream-projection.ts)与 [TurnStreamProjector](../../packages/api-client/src/projector.ts)承载：Fetch 传输在三次连接尝试内保留同一 Turn、同一 Projector 与最后已投递事件游标，HTTP 410 明确失败而不新建 Turn，重复或乱序事件按序号丢弃；Electron IPC 复用同一 Projector，并在终态后丢弃迟到消息。服务端重放与实时读取均取持久事件，并在编码时使用同一字段白名单；字段投影不代替来源资格、授权和保留检查。

本文同时保留已接受的目标要求与现行兼容行为。逐帧撤权、事件保留清理和统一事件负载等未闭合项须独立验收，不能从分页、取消或客户端回归推定完成；以下在对应章节标明差量，不降低原要求。

## 1. 适用范围与不变量

- 普通教学/陪伴对话可以分段流式展示；日记、记忆 Revision、掌握度/评分、题目答案规范、公开内容和工具授权结果必须完整验证后原子发布，不发送渐进片段。
- Provider 的原始 chunk 只能进入服务端有界缓冲。只有通过 purpose 对应安全/结构/来源检查、已经提交数据库事务的内容才可发送给客户端。
- 所有业务事件属于一个 `turnId`。每次重连重新鉴权、检查同意和删除状态；不能用旧连接权限继续重放。
- 用户可见结果的事实源是持久化 `TurnStreamEvent` 和最终 `MessageVersion`，不是内存 buffer 或客户端缓存。
- `Turn` 是唯一对外资源和流聚合；自动重试由内部 `TurnAttempt` 执行，客户端不得依赖 Attempt 身份或供应商请求 ID。

## 2. 资源与 HTTP 接口

### 2.1 创建 Turn

`POST /v1/sessions/{sessionId}/turns`

必需请求头：

| Header | 要求 |
|---|---|
| `Authorization` | 按本机访问令牌鉴权（loopback 默认；非 loopback 强制 Token）；不允许把 bearer token 放入 URL |
| `Idempotency-Key` | 调用方生成的稳定键；本地数据库内全局唯一，不得跨 Session 或业务意图复用 |
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

服务端必须先在一个事务中写入 User `MessageVersion`、Turn、首个 Attempt、请求摘要和 Outbox，再返回成功。同键同摘要返回原资源；同键不同意图或跨 Session 返回 `409 IDEMPOTENCY_KEY_REUSED`，分别以 `reason: intent_mismatch` 或 `session_mismatch` 标识，不再次调用模型。摘要在会话政策过滤后、Inbox 合并前计算，覆盖结构化消息和附件、引用、有效 metadata、工具审批模式及服务端认证 actor；省略值使用有效默认值，对象键序不影响身份，数组保序。生成 ID、clientVersion、API/Worker 调度配置不属于业务意图，后续入队消息不改变原请求身份。

旧 Turn 缺少可验证摘要时返回同一 409，`reason: intent_unavailable`；不从合并正文或当前配置猜测回填，也不自动换键重放。执行与恢复只能从摘要绑定的持久受理回执读取原始 metadata、审批模式和 actor，不能由 Worker 投递或调用方补造；回执缺失、被改或旧记录缺少摘要时拒绝自动执行，保留现有记录供检查。首输入固定为受理时的 User version 1，其正文与当前软删/脱敏标记在同一 SQL 快照读取；首输入不存在、脱敏或身份已软删时不从后续版本或 Outbox 正文副本恢复执行。准备和模型/工具检查点另复验首输入存在且未软删，不重复物化正文；检查后的全部持久写者竞态与完整来源传播仍待闭合。子任务与父执行键复用的意图绑定证据见 ITER-071，不据此宣称完整恢复完成。

CR-030 D2 后不再接受或解析租户 Header；请求只能访问当前本地数据库实例，非 loopback 调用必须通过显式 token 认证。

### 2.2 读取事件流

`GET /v1/turns/{turnId}/events`

请求头：`Accept: text/event-stream`。客户端使用 Fetch streaming 读取，以便发送标准鉴权头和 `AbortSignal`；原生 `EventSource` 不是必需客户端。

Turn 执行与建流解耦（CR-027）：`POST /turns` 在落库后立即返回（`AERVOX_TURN_EXECUTION=background`，默认），Loop 后台执行。事件流端点采用「重放 + 活流 tail」：先全量重放已落库事件（断线重连同样由此恢复完整序列）；若 Attempt 未达终态，服务端持续按 sequence 高水位补拉增量并周期性发送 SSE 注释心跳（`: ping`），直至 Attempt 终态后排空残余事件再关闭连接。Attempt 已终态（历史回合/inline 模式）时重放即关闭。长思考回合期间流内始终有业务事件（含 `reasoning_delta`）或心跳，客户端不得以固定总时限判断回合失败，应以「空闲超时」判定连接失活。`AERVOX_TURN_EXECUTION=inline` 保留「POST 返回即事件就绪」的旧同步语义，仅用于测试与排查。

服务端使用高水位算法避免“重放结束、实时订阅建立之前”丢事件：先订阅进程内唤醒通知，再读取 `replayUpperBound`，按页重放 `(cursorSequence, replayUpperBound]`，随后从数据库补拉到当前最新 sequence。通知只合并为一个待处理标记，不保留事件正文；实时和重放均按 SQLite 持久顺序投递。允许重复投递但不得出现 sequence 空洞。游标优先使用 `Last-Event-ID: {eventId}`；若运行环境不能设置该头，可使用同值的 `?after=` 查询参数，但不得同时提供互相冲突的两个游标。服务端必须把 `eventId` 解析到对应 `(turnId, sequence)`，拒绝不存在、跨 Turn 或当前主体无权访问的游标。

SSE 传输分页每次最多读取 256 条事件，并在物化 JSON 前按 SQLite UTF-8 `data` 字节长度选择不超过 256 KiB 的前缀。为保持已持久历史可重放，首条事件单独超过预算时仍完整读取和发送，不能截断或跳过；该预算不包含 envelope、JSON 解析/序列化临时内存和字符串元数据，不能作为连接内存的绝对字节上限。目前工具事件没有统一持久载荷配额，单个超大历史事件仍是剩余资源风险。Resume 等全历史权威读取保留原接口，传输分页不改变它们的语义。

每个连接只有一个写入和查询执行者；完整 UTF-8 SSE 帧由一次 `write` 写入。返回 `false` 后等待 `drain`，期间不追加帧、不查询下一页，也不因广播累积正文。写队列允许达到 Writable 高水位再加一个完整事件帧；超大单事件仍可超过该高水位。默认等待 `drain` 最长 30 秒（两倍 15 秒心跳周期），连接总时长最多 10 分钟，从开始重放计时；这些值是本机连接保护默认值，尚未经吞吐性能调优。超时、断连、读取失效或宿主关停仅关闭订阅并清理定时器和监听，不取消已经受理的 Turn、不重新执行模型，也不伪造 `error`/`done`。关停在 HTTP 服务等待活连接之前关闭 SSE；旧 Attempt 的终态通知须再次核对同 Turn 的全部 Attempt，不能关闭仍在运行的审批续接。出现背压或单事件超预算的连接关闭时，通过宿主可观测性记录 `sse.connection.closed`，字段只包含固定关闭原因、分页数、超预算事件数和写队列数字，不记录事件正文。

关闭前须在同一 SQLite 语句快照内读取全部 Attempt 的终态判断与事件高水位；不能把旧终态和后续续跑的高水位拼接为关闭依据。快照仍有新事件时继续排空，快照包含运行中续接时保持订阅；读取完成之后新受理的续接由独立请求与重连处理。

建流前错误使用 RFC 9457 Problem Details；建流后的业务错误必须先持久化为事件再发送。响应使用 UTF-8 SSE framing、`Cache-Control: no-store` 和禁用代理缓冲；终态 `done` 提交并发送后关闭连接。需要本次流交付的插件增强事件在有界完成阶段产生，并在 `done` 之前持久化；该阶段继续持有租约并受取消、删除与预算检查。完成前重新读取事件水位，再原子提交终态；不能依赖 `done` 后追加事件让已经终结的客户端继续显示。

### 2.3 取消 Turn

`POST /v1/turns/{turnId}/cancel`

请求必须带 `Idempotency-Key`。服务端使用 compare-and-set 将 `Running/Finalizing` 更新为 `CancelRequested`，停止 Provider/工具提交；已提交安全片段保留，后续片段不得提交。重复取消返回同一个终态，不产生新的 Turn 或工具副作用。

当前[应用取消命令](../../packages/host-runtime/src/modules/companion/conversation/application.ts)不使用请求幂等键创建新事实，而以原 Attempt 的状态与领取身份实现重复取消。尚未领取且 lease 为空、fencing 为初始值时，在同一写者事务中提交 `Cancelled` Attempt、Turn 与唯一 `done`；已领取时只请求 `CancelRequested` 并通知当前 owner，由执行器提交终态。响应如实区分 `CancelRequested` 与 `Cancelled`，重复取消已取消的 Turn 返回同一状态，其它已终结 Attempt 返回 409，无 Attempt 为 404。客户端继续通过持久事件确认物理执行停止，不能把本地等待释放当作该证明。

共享 ConversationController 对取消请求的本地等待最多 30 秒；超时以 `TimeoutError` 报告结果未知，保留当前观察并允许重试。reset/dispose 会中止取消请求和本地等待，即使 IPC 未响应也能释放调用者；迟到结果不能修改新会话。只有成功响应才进入本地已停止状态，物理停止仍须由持久终态确认。

<a id="session-history-page"></a>

### 2.4 读取持久会话历史

`GET /v1/sessions/{sessionId}/history` 使用现有本机认证，响应 `Cache-Control: no-store`。请求、回执和错误的唯一字段声明见[共享契约](../../packages/contracts/src/session-history-api.ts)，headless Client 供 CLI 和界面复用；读取不创建或取消 Turn、不调用模型、不回填数据库。

读取在同一事务快照复验 Session 政策/派发、首输入存在、当前身份与版本指针、关联身份软删。只返回当前未被替代的持久版本，不回退旧版或事件正文；允许未完成回合，`status` 与 `isComplete` 表达实际状态。`contentKind=accepted_input` 仅标识已知原子接单的原始 User 首版：有效意图摘要、首版与消息身份同 ID，且该版仍为当前版本；正文可能包含合并的 Inbox，不能标注为完整原始手输。编辑后的 User、导入和未关联记录使用 `contentKind=message`，仅降低标签的来源声明，不改变其正文可读资格。界面及 CLI 文本为每条记录显示实际持久版本号；版本号在 Turn 内分配，自动 Assistant 发布也会生成新版本，不表示人工编辑次数。旧未关联记录保留真实 versionId，messageId 为 null、legacy/readOnly 为 true，不补造身份；导入的有效关联记录保留当前身份。以 system/assistant 开头、缺少首个 User 的导入轮不满足当前来源证明，仍不显示，不放宽删除保护补读。

`isRedacted` 或仍保留的旧 `redacted` 事件标记使正文返回 null、visibility=withheld、readOnly=true。当前标记未区分固定危机回复与撤回，该历史入口保守隐藏两者；实时固定回复交付合同保持。已清理且无持久标记的旧撤回状态无法从事件推断，完整历史修复和授权/同意传播仍须另验。

`limit` 默认 20、范围 1～50，限定扫描的回合候选数；按 Turn 插入顺序向前翻页，每页从旧到新返回。不为填满可见条目额外扫描隐藏回合，空 items 也可能有 nextCursor。游标绑定 Session 和最后扫描的 Turn，锚点物理删除或政策/派发不符返回 410；各页是各自快照，不能当作完整导出。未知/重复参数或无效游标返回 400，缺 Session 返回 404。调用方显式请求下一页，读取中断只解除当前 GET。

单轮最多 100 条消息、序列化后最多 256 KiB，整页 JSON 最多 512 KiB；SQL 先检查 NUL 安全的正文/元数据字节及消息数，再物化回执。超限或 JSON 转义后游标超过 16384 个字符时，统一返回 422 `HISTORY_ITEM_TOO_LARGE`，不返回截断的成功轮。减小 limit 可处理整页超限，单轮自身超限仍拒绝。该限制约束回执与正文物化，不证明 SQL 扫描/排序耗时或全部临时分配有硬上限。

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

自动重试只允许由新的 `TurnAttempt` 在尚未提交任何用户可见片段且没有外部工具副作用之前发生。首片段之后因基础设施中断的恢复必须把原 Turn 标记为 `Interrupted`，由用户显式发起新 Turn；不得在原 Turn 内从头拼接非确定性的第二份回答。

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

本节列出**内核**事件类型，其类型枚举与对外投影白名单由 `@aervox/contracts` 持有。插件可声明自有事件类型：经 `registerPluginApiContribution({ streamEventTypes, eventProjections })` 登记后，`eventType` 采用开放字符串，对外投影仍按登记的模式 fail-closed 收敛（未登记的事件类型投影为空对象）。客户端不为任何插件事件预留专用回调，统一经通用插件事件出口接收（见[插件开发规范 §5](plugin-config-and-pages.md#5-前端-ui-插槽扩展规范ui-extension-slots)）。

### 4.1 `message`

表示 Assistant Message 身份已创建或可见元数据已提交。`data` 至少包含 `messageId`、`role`、`contentType` 和 `isComplete=false`。

### 4.2 `delta`

表示一段已通过安全门且已持久化的可见正文。`data` 至少包含 `messageId`、`text`、`isFinal=false`。服务端不得发送未持久化或未经检查的 Provider token。

### 4.2.1 `reasoning_delta` (CR-027)

思考型模型的思考进度增量，`data` 包含 `messageId` 与 `text`。**非正文**：不进消息历史与安全片段，不参与 `TTFT` 与派生事实，仅作为长思考期间的活性信号与「思考中」进度反馈。来源为 OpenAI 兼容流的 `delta.reasoning_content`（DeepSeek / Qwen / vLLM）或 `delta.reasoning`（OpenRouter / Ollama 兼容端点）双格式；OpenAI 官方 Chat Completions 不透出原生推理时自然缺省。思考增量计入流活性：客户端的空闲超时计时器收到该事件同样重置。客户端对未知事件类型应忽略不影响既有展示。

### 4.3 `done`

表示 Turn 终态已提交。`data` 至少包含 `status`、`messageId`（如有）、`isComplete`、`lastSequence` 和 `contextVersion`。只有 `status=Completed` 且 `isComplete=true` 的结果可触发普通下游派生；`Cancelled/Interrupted/Failed/Rejected` 的安全前缀只能作为明确标记的不完整历史保留。

接单准备、Native 和 Adapter 共用取消、删除、预算与失败裁决。准备阶段已被阻断时可以直接提交终态，不创建空 Assistant 身份。取消的 `done.reason=cancelled`，中断保留具体原因；`done/error.lastSequence` 对应原子提交的事件序号。丢失租约或 fencing 后不得发布终态，子任务摘要只能按持久 Attempt 对账，不能把本地失去执行权映射为已完成的失败。

### 4.4 `error`

表示已持久化的错误诊断。目标负载包含 `code`、`retryable`、`message`（用户可见且不泄露内部细节）和 `lastSequence`；不得包含完整 Prompt、凭据、Restricted 原文或供应商秘密。统一目标是随后用带 `Rejected/Cancelled/Interrupted/Failed` 的 `done` 表示终态。

当前兼容路径仍由 Core 原子提交 `Failed` Attempt 与 `error`，不保证再发送 `done`；`TurnStreamProjector` 收到 `error` 即终结，迟到消息被丢弃，投影 Schema 也兼容历史可选字段。客户端不能在该路径无限等待第二个终态，统一负载与双事件目标仍需明确迁移及兼容验证。

### 4.5 `redacted`

表示某个已持久事件或正文因来源删除、同意撤销或权限变化而不再可见。`data` 至少包含 `targetEventId`、`visibilityRevision`、`reasonCode` 和不含原文的替代状态；原事件不可改写，客户端收到后必须停止展示和使用被撤回正文。

### 4.6 `user_question_required` 与 `user_question_answered` (UQ-01)

- `user_question_required`：表示模型在执行过程中调用 `ask_user_question` 发起向用户提问与决策确认，Step 挂起等待。`data` 包含 `turnId`、`step`、`questions` 数组（含 `id`、`question`、`header`、`detail`、`options`、`multiSelect`、`intent`）以及 `timeoutMs`。
- `user_question_answered`：表示用户已提交对该问题的回答（通过 `POST /v1/turns/:turnId/questions/answers`），Loop 被唤醒继续执行。`data` 包含 `turnId` 与 `answers` 数组。

### 4.7 `tool_approval_required` (PET-05 / CAP-009)

表示模型请求的写工具（如 `aervox_diary_write`、`aervox_memory_store`）尚未获得用户授权，本次 Attempt 以 `Interrupted` 结束等待授权。`data` 包含 `approvalId`、`toolName`、`argumentsHash`。用户经 `POST /v1/turns/:turnId/tool-approvals` 提交决定（`granted`/`denied`）；宿主在同一事务中保存决定、预留唯一新 Attempt 并移交确认尚未执行的工具意图。响应中的 `continuation.attemptId` 与 `continuation.afterEventId` 指向新尝试及审批事件游标。客户端使用新的投影器订阅原 Turn 的 `events?after=<afterEventId>`，不得重发消息；旧 Attempt 的终态与投影器保持终结。相同决定重复提交返回同一游标，不创建新尝试，冲突决定或尚未中断/已取消的尝试返回 409。客户端对未知事件类型应忽略不影响既有展示。

所有工具来源均从宿主写入的审批绑定快照校验安全等级。`privileged` 批准需要当前管理员白名单中的 `x-admin-user-id`，否则返回 403；缺少绑定身份的旧待决记录、已停用/跨代插件或失效的动态实现返回 409，审批保持待决，仍允许用户拒绝。已执行的同决定重试只返回既有接续结果，不重新派发工具。

HTTP 创建和审批续跑与 Worker/Bot 共用应用执行入口，从有效的受理回执恢复 metadata、审批模式及可信 actor；后续审批请求的 actor 不替换原始执行身份。预留续跑前先验证受理回执，缺失或不一致时返回 `409 turn_intent_unavailable`，不记录决定或创建新 Attempt；这也适用于拒绝后需要继续执行的路径。同一活动 Attempt 的并发派发共享一次执行，持久 CAS/fencing 继续承担最终写入门禁。

标准错误码：

| Code | HTTP/流语义 | 客户端动作 |
|---|---|---|
| `IDEMPOTENCY_KEY_REUSED` | `409`，不打开新流 | 修正请求键或读取原 Turn |
| `TURN_NOT_FOUND` | `404` | 停止重连并刷新本地历史；响应不得向未认证远程调用泄露资源是否存在 |
| `STREAM_CURSOR_EXPIRED` | `410` | 读取 Turn 当前状态和已持久化 MessageVersion；不得自动再次调用模型 |
| `TURN_CANCELLED` | `error` 后以 `done(status=Cancelled)` 终止 | 标记不完整，不生成派生事实 |
| `MODEL_TIMEOUT` | 可重试；无可见片段且无副作用时可由新 Attempt 重试 | 显示重试入口，保持原 Turn 幂等 |
| `MODEL_UNAVAILABLE` | 降级或可重试 | 只切换已评估 Provider；无合格备用时保留输入 |
| `OUTPUT_SAFETY_BLOCKED` | 终止 | 显示保守响应/重试状态，不展示被拦截正文 |
| `PERMISSION_REVOKED` | 终止 | 清除本地未提交展示，重新获取权限状态 |

## 5. 重连、保留与断点恢复

1. 客户端保存最后已处理的 `eventId`，断线后以 `Last-Event-ID` 重连；服务端解析该事件的 sequence，先重放同一 Turn 中 `sequence > cursorSequence` 的持久事件。
2. 重放及实时连接存续期间，每个业务事件发送前都必须校验当前授权/同意策略版本；来源删除、同意或插件/外部权限撤销必须主动关闭相关连接。仍可披露撤回状态时发送不含旧正文的 `redacted`，否则返回不泄露资源存在性的统一终止结果；不得把历史正文重新泄露。
3. `TurnStreamEvent` 是传输/恢复数据而非长期会话副本。MVP 在线正文重放窗口默认 24 小时，具体值必须进入保留策略；任何事件正文的保留上限不得超过对应 `MessageVersion` 的可见保留、有效同意和来源可用期三者中的最短者。窗口结束、来源删除或权限撤销后只保留不含正文的最小事件元数据/tombstone，长期历史由 `MessageVersion` 承担。
4. 游标过期返回 `410 STREAM_CURSOR_EXPIRED` 和当前 Turn 状态/`lastSequence`。客户端只能读取已持久化 MessageVersion 或显示重新开始按钮，不得隐式重跑模型。
5. 客户端收到重复、乱序或未知 `payloadVersion`：按 `eventId/sequence` 去重；未知版本停止渲染并请求兼容降级，不猜测字段含义。

新原子接单在同一事务建立 User Message 身份与首个版本，保留原版本 ID。受信 `message` 事件先原子绑定 Assistant 身份和空版本；终态、取消及现有恢复写者在其终态事务内，将同消息身份、已提交且 approved 的安全片段发布为不可变 MessageVersion，再推进当前指针。`Interrupted` / `Failed` / `Cancelled` 保留可见前缀并继续表达不完整，不进入自动日记或检索素材。已受理续接的正文发布从已保存版本及持久 sequence 水位后追加，不依赖已清理的旧正文；控制事件清理后的真实审批接管仍须另验。人工编辑后的版本不被迟到执行覆盖。来源首版物理删除、相关身份软删、政策不符或删除未验证时不写入新正文；`redacted` 事件同时持久标记版本，事件清理不能恢复派生资格。该实现不迁移旧 unlinked/import 行，也不从旧事件补造已删除的长期历史。

模型上下文对新关联消息读取当前 MessageVersion，仍只投影已完成轮、最近 20 个候选及 32000 字符的完整问答预算；旧未关联记录维持原来的 approved 在线事件读取。查询在同一快照复验首输入、当前身份、软删与脱敏，不回退到旧版本或事件副本。该预算不约束候选查询的全部行/正文内存；用户历史分页另遵守 [2.4](#session-history-page) 的资格和预算，不复用模型投影作为显示真源。

当前 SSE 建流和空闲轮询使用窄来源查询，在同一 SQL 快照验证 Session/Turn、策略与派发一致、User version 1 存在及同 Turn 现存消息身份未软删；不可用与不存在的建流请求统一 404。每个业务帧发送前重新读取当前持久事件并复验这些条件，不发送背压期间缓存页中的正文；事件消失或来源不可用时仅关闭观察，不取消 Turn、不追加 `error`/`done`。空闲连接沿用 100ms 轮询，不依赖进程内通知。查询完成至 socket 写入仍存在并发窗口，已经写入的字节不能追回；这不是跨进程原子网络撤权。

本切片不把 `isRedacted` 单独当作删除：它也用于将固定危机求助回复排除出记忆用途，现有受信固定回复仍可交付。任意脱敏来源的在线披露、授权/同意版本、已物理删除的非首输入来源关联、完整派生清理和 24 小时自动正文清理仍待独立验收；模型上下文投影已复用来源资格，用户历史接口按 [2.4](#session-history-page) 读取当前版本。逐帧新增一次 SQL，版本及消息身份关联的成本随历史规模增长，不能作为全局资源有界的证据。无效游标的现行 410 为 `stream_cursor_expired`，不附加状态和高水位。

## 6. 超时、失败、降级和取消

- 服务端必须限制 Turn 总时长、累计输出、单段大小、并发流和空闲时间；SSE heartbeat 只维持连接，不改变业务状态。Provider 上游超时应采用**空闲超时**语义（每收到一段流数据即重置，含思考增量），不得以固定总时限掐断持续输出的思考型模型（CR-027）；用户可经 LLM 配置 `settings.requestTimeoutMs` 调整空闲上限。客户端（Web/Desktop）侧同样以空闲超时收敛 UI，超时后必须中止上游在途请求（如桌面 `cancelTurn` IPC → 主进程 `AbortController`），避免"UI 已失败、后台继续消耗 tokens"的幽灵回合。
- Provider 超时/5xx/限流按路由策略熔断；只可切换已通过同一 EvalSet 和安全审查的备用模型。没有合格备用时保留 User Message，返回可重试状态。
- 输出安全分类服务不可用时，普通对话停止发送新片段；高风险输入使用固定保守响应。不得为降低延迟跳过安全门。
- API/Worker 崩溃后，恢复器依据 Turn 状态和最后 sequence 决定是否用新 `TurnAttempt` 重试或收敛为 `Interrupted`；旧 Worker 必须通过 fencing token，不能晚提交。
- Provider、工具调用和权限决定如需暴露，使用独立事件类型和权限检查；模型请求工具不等于已获授权。

## 7. 可观测性与测试门禁

TTFT 定义为：Turn POST 被服务端接受，到第一个**通过安全门且已持久化**的用户可见 `delta` 提交的时间。必须分别记录输入检查、Provider 首 token、片段缓冲、安全检查、数据库提交和网络发送耗时。

进入 G1 前必须有契约和故障测试：幂等重复提交、事件 sequence 唯一、断线/刷新/Last-Event-ID 重放、游标过期、取消 CAS、首片段前重试、首片段后 Interrupted、旧 Worker fencing、Provider 降级、分类服务不可用、删除/撤权后重连、原始 Provider chunk 不出现在客户端/日志，以及高完整性产物不渐进展示。测试 ID 至少包括 `TC-CONTRACT-STREAM-001`、`TC-RES-STREAM-001`、`TC-SEC-STREAM-001` 和 `TC-E2E-STREAM-001`。

## 8. 兼容与变更

新增字段必须向后兼容；删除或改变事件语义必须提升 `payloadVersion`、更新 OpenAPI/JSON Schema，在 PR 中说明迁移与验证，并保留上一版本客户端的兼容窗口。需要持续协调时按[统一变更编号规则](../../CONTRIBUTING.md#change-numbering)关联 ITER。替换 AI SDK、Provider 或传输实现不得改变 Turn/TurnStreamEvent 状态和幂等语义。

## 客户端会话与录音生命周期

桌面桥接必须把所选 `sessionId` 从客户端传入主进程并用于 Turn 请求；仅在字段缺省时使用配置默认会话，显式非法值必须拒绝。会话创建、重命名、删除遇到 HTTP 错误时，客户端记录错误并拒绝操作 Promise，保持原会话列表与活跃会话；不能伪造成功记录。删除已提交而后续创建替代会话失败时，保留删除结果和错误状态。

录音停止会使尚未完成的麦克风权限申请失效；迟到的授权立即释放音轨。用户主动停止保留最后已提交片段的转写；所属 Vue scope 释放时丢弃未提交片段、取消在途转写，不再写回识别文本。
