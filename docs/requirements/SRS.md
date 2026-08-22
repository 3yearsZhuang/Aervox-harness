# Aervox｜思隅 软件需求规格（SRS）

> 文档编号：AVX-SRS-001  
> 版本：v0.1（评审候选）  
> 更新日期：2026-08-24  
> 状态：Review Candidate  
> 产品事实源：[PRD](../../PRD.md)  
> 追踪矩阵：[REQUIREMENTS_TRACEABILITY.md](../REQUIREMENTS_TRACEABILITY.md)

本文件把 PRD 的产品能力拆成可以交给设计、工程和 QA 评审的原子需求。它不是实现代码，也不替代 OpenAPI、数据库迁移或测试用例。所有未列入本文件的 P1/P2/P3 行为，仍必须在进入开发前补充并通过 `Ready` 门禁。

## 1. 需求表达规范

- `必须`：发布范围内的强制行为；缺失即不满足需求。
- `应当`：默认行为或质量目标；偏离需要记录理由和批准人。
- `可以`：可选能力；不作为阶段退出条件，除非版本基线另行指定。
- 每条需求只有一个可观察的主结果；跨模块行为拆成多个 ID，并用依赖关联。
- 每条需求必须同时说明正常、空、错误、取消、重试、撤销、并发和删除路径中适用的部分。
- `inferred`、`candidate`、`sourceDeleted` 等状态必须在 API、UI、导出和测试中保持一致。

## 2. P0 业务需求

### FR-LRN-001 创建与管理学习目标

- **Parent CAP**：`CAP-002`
- **触发**：已登录用户提交主题、水平和可用时间。
- **必须**：系统校验字段后创建唯一活动目标，并显示主题、水平、预计时长和状态。
- **异常**：空字段、非法时长、重复提交、工作区无权限、写入超时。
- **数据**：`LearningGoal`；删除目标不删除已确认学习事实，级联删除必须二次确认。
- **验收**：
  - `AC-FR-LRN-001-01`：Given 必填字段为空，When 提交，Then 不创建目标并定位错误字段。
  - `AC-FR-LRN-001-02`：Given 字段合法，When 连续提交两次，Then 只创建一个目标并返回同一幂等结果。
  - `AC-FR-LRN-001-03`：Given 用户删除目标，When 未确认级联删除，Then 目标停止显示但历史学习事实仍可查看。
- **测试**：`TC-API-LRN-001`、`TC-E2E-LRN-001`、`TC-PRIV-LRN-001`。

### FR-LRN-002 资料生成与类型

- **Parent CAP**：`CAP-011`
- **触发**：用户从学习目标或知识点请求生成资料。
- **必须**：支持至少五种资料类型（讲解文档、思维导图、练习题、拓展阅读、代码案例）；生成内容区分“模型生成”与“外部引用”；所有引用可定位来源；生成失败提供可重试状态。
- **异常**：生成失败、类型不可用、引用来源不可验证。
- **数据**：StudyMaterial 及 MaterialSource 引用；AI 生成遵循 `AIQ-TEACH-001`。
- **验收**：
  - `AC-FR-LRN-002-01`：Given 用户请求某类型资料，When 生成，Then 输出对应类型并区分模型生成/外部引用。
  - `AC-FR-LRN-002-02`：Given 生成结果含引用，When 完成，Then 引用可定位来源，无法验证的事实标记“需要核对”。
  - `AC-FR-LRN-002-03`：Given 生成失败，When 重试，Then 幂等执行不重复生成，提供可重试状态。
- **测试**：`TC-AIEVAL-LRN-001`、`TC-API-LRN-002`。

### FR-LRN-003 资料编辑与导出

- **Parent CAP**：`CAP-011`
- **触发**：用户编辑或导出已生成资料。
- **必须**：用户可编辑资料（产生版本，不覆盖原版本）；可导出为可读 JSON/Markdown；编辑/导出不改变来源事实。
- **异常**：编辑已删除资料、导出失败、并发编辑。
- **数据**：StudyMaterial 版本；导出含引用来源状态。
- **验收**：
  - `AC-FR-LRN-003-01`：Given 用户编辑资料，When 保存，Then 生成新版本，原版本可追溯。
  - `AC-FR-LRN-003-02`：Given 用户导出，When 完成，Then 输出可读 JSON/Markdown 且含引用来源状态。
- **测试**：`TC-API-LRN-002`、`TC-E2E-LRN-002`。

### BR-LRN-001 事实核验、版权与删除传播规则

- **Parent CAP**：`CAP-011`
- **规则**：无法验证的事实必须标记“需要核对”，不得作为正式学习事实或进入掌握度/记忆；外部引用保留来源与许可证状态，版权未确认的引用不得作为可信来源传播；删除来源后引用失效并重建检索索引（衔接 `DATA-DEL-001`）。
- **验收**：
  - `AC-BR-LRN-001-01`：Given 事实无法验证，When 生成，Then 标记“需要核对”，不进入掌握度/记忆。
  - `AC-BR-LRN-001-02`：Given 版权未确认的引用，When 使用，Then 标记受限，不传播为可信来源。
  - `AC-BR-LRN-001-03`：Given 删除来源，When 清理，Then 引用失效并重建检索索引，24 小时内完成。
- **测试**：`TC-AIEVAL-LRN-001`、`TC-PRIV-DEL-001`。

### FR-CONV-001 引导式学习对话

- **Parent CAP**：`CAP-002`、`CAP-007`
- **触发**：用户在活动目标下提交问题或代码/报错。
- **必须**：默认先确认问题和已尝试内容，再给一条可执行提示；用户明确请求完整讲解或连续两次失败后才展开答案。
- **禁止**：把模型推断当作事实、在不确定时伪装确定、绕过安全分类或直接执行未经授权的代码/工具。
- **验收**：
  - `AC-FR-CONV-001-01`：Given 首次求助，When 模型回答，Then 输出最多一条下一步提示并标记响应类型。
  - `AC-FR-CONV-001-02`：Given 用户明确请求完整讲解，When 安全/事实校验通过，Then 展开讲解并区分事实、推断和不确定项。
  - `AC-FR-CONV-001-03`：Given 模型无法验证答案，When 返回结果，Then 不生成正式题目、错题或掌握度事实。
- **测试**：`TC-AIEVAL-LRN-001`、`TC-API-CONV-001`、`TC-SEC-CONV-001`。

### FR-CONV-002 代码与报错输入处理

- **Parent CAP**：`CAP-007`
- **触发**：用户在对话中提交代码片段或报错信息。
- **必须**：识别并支持代码/报错输入，尽力识别语言与框架；代码以代码块形式呈现并保留可复制；解析失败不阻断对话，回退为普通文本。
- **异常**：输入超过长度上限、格式无法识别、空代码。
- **数据**：CodeSnippet/ErrorBlock 结构化字段；仅展示与讲解，不执行。
- **验收**：
  - `AC-FR-CONV-002-01`：Given 用户粘贴代码或报错，When 提交，Then 正确呈现并尽力识别语言/框架，解析失败回退普通文本不阻断。
  - `AC-FR-CONV-002-02`：Given 输入超过长度上限，When 提交，Then 提示分段或拒绝并说明原因。
  - `AC-FR-CONV-002-03`：Given 代码/报错不含可执行意图，When 展示，Then 保持不可执行（仅文本呈现），不触发任何工具。
- **测试**：`TC-API-CONV-002`、`TC-E2E-CONV-002`、`TC-SEC-CONV-001`。

### FR-CONV-003 语言支持与引用

- **Parent CAP**：`CAP-007`
- **触发**：用户以特定语言/框架提问。
- **必须**：常见编程语言使用对应上下文回答；回答中的事实/断言尽量带来源或标“需要核对”；无来源的不确定内容不得写成事实或生成学习事实。
- **异常**：语言识别失败、引用来源不可验证。
- **数据**：引用/来源结构化字段；不确定标记与 `AC-FR-CONV-001-03` 一致。
- **验收**：
  - `AC-FR-CONV-003-01`：Given 问题涉及特定语言，When 回答，Then 使用对应语言上下文，且关键断言可追溯或标“需要核对”。
  - `AC-FR-CONV-003-02`：Given 模型无法验证某项断言，When 回答，Then 标记不确定，不生成正式学习事实。
- **测试**：`TC-AIEVAL-LRN-001`、`TC-CONTRACT-CONV-001`。

### BR-CONV-001 代码执行边界

- **Parent CAP**：`CAP-007`
- **规则**：MVP 默认不自动执行用户代码；任何执行必须明确授权、受限沙箱、超时、资源配额与审计；模型只能请求工具，执行与否由服务端权限代理决定。
- **验收**：
  - `AC-BR-CONV-001-01`：Given 用户提供代码且未获执行授权，When 请求处理，Then 只提供讲解/建议，不执行、不调用未授权工具。
  - `AC-BR-CONV-001-02`：Given 获授权执行环境，When 执行，Then 在受限沙箱内，超时/配额/审计完备，失败不产生部分结果泄漏。
- **测试**：`TC-SEC-CONV-001`、`TC-RES-CONV-001`。

### BR-CONV-002 讲解反馈与质量队列

- **Parent CAP**：`CAP-002`、`CAP-007`
- **规则**：用户可对每个回答标记“有帮助/没帮助/讲错了”；反馈携带回答类型与版本进入质量队列，供 AI 质量负责人复盘；反馈不修改历史版本；“讲错了”触发关联内容复核，不自动改写已展示内容。
- **验收**：
  - `AC-BR-CONV-002-01`：Given 用户标记反馈，When 提交，Then 反馈连同回答类型/版本进入质量队列，不修改历史。
  - `AC-BR-CONV-002-02`：Given 反馈为“讲错了”，When 处理，Then 触发关联内容复核并记录，不自动改写已展示内容。
- **测试**：`TC-AIEVAL-LRN-001`。

> 说明：引导式对话与“完整讲解触发”由 `FR-CONV-001` 原子化承载（Parent CAP-002/007），本组仅补 CAP-007 专属缺口；讲解触发验收复用 `AC-FR-CONV-001-01/02/03`，不重复定义。

### FR-CONV-004 消息编辑与版本控制

- **Parent CAP**：`CAP-013`
- **触发**：用户编辑一条已发送消息。
- **必须**：编辑生成新版本，不覆盖原版本；编辑后的消息保持可见的版本/编辑标记；编辑仅影响后续使用，不重写已持久化的历史正文。
- **异常**：编辑已删除消息、并发编辑、编辑超时。
- **数据**：MessageVersion 链；引用基于版本快照。
- **验收**：
  - `AC-FR-CONV-004-01`：Given 用户编辑已发送消息，When 保存，Then 生成新版本并显示编辑标记，原版本仍可追溯。
  - `AC-FR-CONV-004-02`：Given 消息已被删除或撤权，When 尝试编辑，Then 拒绝并提示，不暴露已删正文。
  - `AC-FR-CONV-004-03`：Given 两个客户端并发编辑同一消息，When 保存，Then 以版本 CAS 决定唯一胜者，另一编辑被拒绝或合并为下一版本。
- **测试**：`TC-API-CONV-004`、`TC-INTEG-CONV-004`。

### FR-CONV-005 删除影响预览与确认

- **Parent CAP**：`CAP-013`
- **触发**：用户删除单条消息。
- **必须**：删除前展示对摘要、错题、复习项、日记和记忆的级联影响预览；用户确认后删除；删除后立即停止召回并异步重建派生数据（衔接 `FR-DATA-001`）。
- **异常**：预览计算失败、部分派生不可枚举。
- **数据**：DeletionRequest/影响清单；遵循 `DATA-DEL-001` 传播链。
- **验收**：
  - `AC-FR-CONV-005-01`：Given 消息被摘要/错题/日记/记忆引用，When 删除，Then 删除前展示受影响派生清单。
  - `AC-FR-CONV-005-02`：Given 用户确认删除，When 执行，Then 立即停止召回，24 小时内重建/清除派生数据。
  - `AC-FR-CONV-005-03`：Given 预览计算失败，When 删除，Then 不静默删除，提示影响未知并要求重试或保守处理。
- **测试**：`TC-PRIV-DEL-001`、`TC-INTEG-DEL-001`。

### BR-CONV-003 引用失效与重生成规则

- **Parent CAP**：`CAP-013`
- **规则**：消息被编辑/删除后，引用该消息的摘要、错题、日记段落和记忆候选标记“引用失效/来源已改”；不自动改写已展示内容；重生成只产生新版本、不覆盖旧内容，且需用户明确请求。
- **验收**：
  - `AC-BR-CONV-003-01`：Given 消息被编辑或删除，When 派生内容引用它，Then 引用标记失效/来源已改，不自动改写已展示内容。
  - `AC-BR-CONV-003-02`：Given 用户请求重生成，When 执行，Then 创建新版本，旧版本保留可追溯，不覆盖历史。
- **测试**：`TC-INTEG-MEM-001`、`TC-AIEVAL-MEM-001`。

### BR-CONV-004 编辑/删除并发冲突

- **Parent CAP**：`CAP-013`
- **规则**：编辑与删除、引用与删除并发时以版本/幂等键 CAS 收敛；已删除消息不得再编辑或生成引用；冲突不产生重复业务结果，冲突方收到明确结果。
- **验收**：
  - `AC-BR-CONV-004-01`：Given 编辑与删除并发，When 提交，Then CAS 决定唯一结果（已删则编辑失败），不产生半更新状态。
  - `AC-BR-CONV-004-02`：Given 引用生成与来源删除并发，When 提交，Then 以删除为准，引用标记失效，不生成对已删正文的新引用。
- **测试**：`TC-INTEG-CONV-004`、`TC-PRIV-DEL-001`。

> 说明：删除传播与导出主干由 `FR-DATA-001`、`DATA-DEL-001` 承载，本组仅补 CAP-013 的编辑/引用/预览/并发缺口；引用失效沿用 `redacted/revoked` 可见性规则（见 [ADR-012](../architecture/adr/ADR-012-streaming-safety-persistence.md)）。

<a id="srs-fr-stream"></a>

### FR-STREAM-001 Turn 流式响应与恢复

- **Parent CAP**：`CAP-002`、`CAP-007`、`CAP-008`
- **接口**：客户端使用 `POST /v1/sessions/{sessionId}/turns` 幂等创建 Turn，再使用 `GET /v1/turns/{turnId}/events`（SSE/Fetch）读取持久化事件；取消使用 `POST /v1/turns/{turnId}/cancel`。完整 envelope、状态、错误和兼容规则以 [流式协议契约](../contracts/STREAMING_PROTOCOL.md) 为准。
- **必须**：服务端先持久化 User Message、Turn 和 Outbox；Provider 原始 chunk 只能进入有界缓冲，只有通过 purpose 安全/结构检查并提交事务的 `message`/`delta` 才能发送。`eventId` 不可复用，Turn 内 `sequence` 单调递增；SSE `id` 等于 `eventId`。
- **幂等与恢复**：相同幂等作用域、键和请求摘要返回同一 Turn；不同摘要返回 `409 IDEMPOTENCY_KEY_REUSED`。重连必须校验 `Last-Event-ID` 属于当前 Turn，支持高水位重放和重复去重；游标过期返回 `410 STREAM_CURSOR_EXPIRED`，不得隐式重跑模型。
- **取消/失败**：取消使用 CAS；已提交安全前缀保留并标记不完整，后续片段不得提交。首个可见片段前且无工具副作用时可用新的内部 `TurnAttempt` 重试；首片段后基础设施中断必须收敛为 `Interrupted`，用户显式发起新 Turn。只有 `Completed` 才能触发普通记忆、掌握度或日记来源。
- **撤权**：连接存续期间每个事件发送前重新检查 workspace、purpose、同意和删除状态；撤权/删除必须主动断流或发送不含正文的 `redacted`。
- **验收**：
  - `AC-FR-STREAM-001-01`：Given 相同幂等键并发提交，When 请求体摘要相同，Then 只创建一个 Turn、User Message 和 Outbox，并返回同一资源。
  - `AC-FR-STREAM-001-02`：Given 网络在第 N 个事件后断开，When 客户端以 `Last-Event-ID` 重连，Then 服务端无 sequence 空洞地重放未确认事件，重复事件可去重且不重复生成模型调用。
  - `AC-FR-STREAM-001-03`：Given 游标早于保留窗口或属于其他 Turn，When 建立 SSE，Then 返回 `410 STREAM_CURSOR_EXPIRED` 或统一无权错误，不泄露正文/资源存在性且不自动重跑。
  - `AC-FR-STREAM-001-04`：Given 用户在 Running/Finalizing 取消，When 取消与片段提交并发，Then 由 CAS 决定唯一胜者，已提交前缀保留，失去 fencing 的 Worker 不得晚提交。
  - `AC-FR-STREAM-001-05`：Given 输出分类服务不可用或来源在流期间撤权，When 继续生成，Then 不发送未经检查的新片段，并主动断流或发送 `redacted`；不得进入普通记忆/日记。
- **测试**：`TC-CONTRACT-STREAM-001`、`TC-RES-STREAM-001`、`TC-SEC-STREAM-001`、`TC-E2E-STREAM-001`。

### FR-PRC-001 练习、判定与错题

- **Parent CAP**：`CAP-003`、`CAP-004`
- **必须**：默认题组 3～5 题；每题提交后返回正确/部分正确/待确认和下一步；选择题按标准答案判定，短文本题不可验证时进入待确认。
- **数据**：`Question`、`QuestionAttempt`、`KnowledgeItem`、`ReviewItem`；原始作答不可变，掌握度为派生状态。
- **验收**：
  - `AC-FR-PRC-001-01`：Given 用户重复提交同一答案，When 请求重试，Then 只产生一个作答事实和一个调度结果。
  - `AC-FR-PRC-001-02`：Given 判定为部分正确/待确认，When 会话结束，Then 不直接计入掌握度。
  - `AC-FR-PRC-001-03`：Given 生成题目答案无法验证，When 保存结果，Then 题目可见但不进入正式错题/复习。
- **测试**：`TC-UNIT-PRC-001`、`TC-INTEG-PRC-001`、`TC-E2E-PRC-001`。

### FR-REV-001 间隔复习

- **Parent CAP**：`CAP-006`
- **规则**：MVP 使用次日、1/3/7/14 天递增；答错回到次日；每条记录带 `schedulerVersion`。
- **验收**：
  - `AC-FR-REV-001-01`：Given 到期项存在，When 打开首页，Then 显示数量、预计耗时和今日列表。
  - `AC-FR-REV-001-02`：Given 用户完成复习，When 保存结果，Then 只更新一次下次日期并显示规则版本。
  - `AC-FR-REV-001-03`：Given 用户跨时区或遇到 DST，When 计算日界线，Then 使用用户 IANA 时区且不重复生成活动项。
- **测试**：`TC-UNIT-REV-001`、`TC-PERF-REV-001`、`TC-MIG-REV-001`。

### FR-SAFE-001 轻量陪伴与安全响应

- **Parent CAP**：`CAP-008`
- **必须**：普通疲惫先回应感受并提供可选行动；高风险表达停止学习推进，使用固定、地区化的安全响应和求助入口。
- **禁止**：诊断、治疗/用药建议、情感排他、内疚施压、承诺真人救援或让人格模板覆盖安全规则。
- **验收**：
  - `AC-FR-SAFE-001-01`：Given 普通疲惫表达，When 响应，Then 不升级为危机且提供休息/继续/结束选项。
  - `AC-FR-SAFE-001-02`：Given 高风险样本，When 分类服务可用或失败，Then 均触发保守安全响应，不继续学习引导。
  - `AC-FR-SAFE-001-03`：Given 安全事件发生，When 写入审计，Then 不写入关系分数、普通记忆或日记。
- **测试**：`TC-AIEVAL-SAFE-001`、`TC-SEC-SAFE-001`、`TC-E2E-SAFE-001`。

### FR-DIA-001 AI 每日日记

- **Parent CAP**：`CAP-009`
- **设置**：用户选择启用、生成时间、IANA 时区、视角、语气、篇幅和 `contentScopes`；每次修改产生不可变 `DiaryScheduleRevision`。首次 `initialWindowStart` 为启用与授权持久化时点；关闭后停止新任务和通知，重新启用开始新 `scheduleEpochId` 且默认不回填停用期间。
- **窗口**：每个不可变 `DiaryCycle` 定义一个滚动窗口：常规为 `(previousCutoffAt, cutoffAt]`，首次为 `[initialWindowStart, cutoffAt]`；`localDate` 是 `cutoffAt` 在 `timezoneSnapshot` 下的日期标签，不表示从本地零点取材。来源必须同时保存 `occurredAt` 和 `ingestedAt`；周期归属只使用 `occurredAt`，只有 `occurredAt > cutoffAt` 的事件进入下一周期。默认 `bufferClosedAt = cutoffAt + 30m`；首版不等待宽限期，须在设定时间后 15 分钟内发布。
- **一致性**：`Diary` 对 `(workspaceId,subjectUserId,localDate,autoGenerated=true)` 唯一；`DiaryMaterialBuffer` 只能关联 `cycleId`。`DiaryRunAttempt` 用 schedule revision、lease 和 fencing token 拒绝旧 Worker；只有 `Published` 或有审计原因的 `Skipped` 才能与 `lastCutoffAt/cursorVersion` 在同一事务提交，`Failed/Cancelled` 不推进 cursor。计划修订遇到已有自动日记的同日标签时顺延到下一未占用标签。
- **故障与通知**：失败跨过后续截止点或多日宕机时，按 `cutoffAt` 从旧到新建立并处理独立周期，不自动合并/静默跳过；超过已批准补写上限则进入用户可见待决定队列。发布空日记属于 `Published`，明确不生成属于 `Skipped`；quiet hours 只延迟/合并通知，不延迟生成或 cursor。
- **来源**：每段至少一个可定位来源或“素材不足”标记；日记文本不自动晋升记忆。
- **验收**：
  - `AC-FR-DIA-001-01`：Given 同一 `localDate` 标签任务重复投递或计划版本变更，When Worker 执行，Then 只保留一个自动日记身份，运行记录可追踪。
  - `AC-FR-DIA-001-02`：Given 来源延迟写入，When 宽限期内处理，Then 仅当 `previousCutoffAt < occurredAt <= cutoffAt`（首次为 `initialWindowStart <= occurredAt <= cutoffAt`）时形成本次补写候选；若 `occurredAt <= previousCutoffAt` 则标记为历史迟到来源，不得静默归入下一周期；若 `occurredAt > cutoffAt` 则由下一滚动周期处理。
  - `AC-FR-DIA-001-03`：Given 用户把每日生成时间从 22:00 改为 00:30，When 后续两次任务运行，Then 两个素材窗口首尾相接、不重叠且不漏掉跨午夜事件。
  - `AC-FR-DIA-001-04`：Given 来源被删除，When 用户打开日记，Then 显示来源失效并阻断相关记忆晋升，可重建或删除。
  - `AC-FR-DIA-001-05`：Given 本周期无足够素材，When 自动生成，Then 输出空日记/邀请补充/跳过之一，不虚构事件。
  - `AC-FR-DIA-001-06`：Given 用户停用日记后再次启用，When 新周期首次运行，Then 以重新启用时点作为 `initialWindowStart`，不自动回填停用期间素材，且不创建与旧周期重叠的窗口。
  - `AC-FR-DIA-001-07`：Given 来源在 `bufferClosedAt` 之后才写入但事件时间属于本次窗口，When Worker 处理，Then 不自动改写或生成补写候选，用户主动请求重写时才可纳入并保留新的来源快照。
  - `AC-FR-DIA-001-08`：Given 两个 Worker 领取同一周期且旧租约过期，When 两者尝试提交，Then 只有持有最新 fencing token 的 Worker 能发布并推进 cursor。
  - `AC-FR-DIA-001-09`：Given 生成/校验失败跨过下一个 `cutoffAt`，When Scheduler 对账，Then 失败周期不推进 cursor，后续周期按截止点顺序等待处理或明确跳过。
  - `AC-FR-DIA-001-10`：Given 系统多日宕机，When 恢复调度，Then 每个遗漏截止点保留独立周期和日期标签，不自动合并或静默丢弃。
  - `AC-FR-DIA-001-11`：Given 处于 quiet hours，When 周期到期，Then 日记照常生成/提交，通知延迟或合并且不发生重复通知。
  - `AC-FR-DIA-001-12`：Given 当日 00:30 已发布自动日记且 01:00 将计划改为 22:00，When 计算下一周期，Then 跳过已占用的同日标签并从上一 cursor 连续到下一未占用截止点。
- **测试**：`TC-INTEG-DIA-001`、`TC-PRIV-DIA-001`、`TC-AIEVAL-DIA-001`、`TC-RES-DIA-001`。

### FR-DATA-001 编辑、导出与删除

- **Parent CAP**：`CAP-005`、`CAP-013`
- **必须**：消息编辑生成版本；删除前展示派生影响；删除后立即禁止召回，24 小时内清理 Aervox 在线存储、索引、缓存和对象；导出可用 JSON/CSV/Markdown 读取。
- **验收**：
  - `AC-FR-DATA-001-01`：Given 删除消息，When 确认，Then ContextManifest、搜索、记忆、树、日记来源和插件查询立即排除该来源。
  - `AC-FR-DATA-001-02`：Given 删除传播任务部分失败，When 状态为 `PartiallyCompleted`，Then 告警、重试、用户可见进度且不恢复召回。
  - `AC-FR-DATA-001-03`：Given 用户请求导出，When 导出完成，Then 包含版本、来源状态、记忆事件、日记版本和附件 manifest。
- **测试**：`TC-PRIV-DEL-001`、`TC-INTEG-DEL-001`、`TC-E2E-DATA-001`、`TC-RES-DEL-001`。

### FR-UX-001 首页工作台入口呈现

- **Parent CAP**：`CAP-001`
- **触发**：已登录用户进入首页。
- **必须**：首页展示五个入口（桌宠主体、继续学习、今日复习、学习记录、每日日记）；桌宠主体显示当前状态与一条简短提示；未到 MVP+ 的入口按既定策略占位或隐藏，不报错。
- **异常**：数据加载失败、接口超时、权限失效。
- **数据**：HomeState/CurrentTask 等轻量展示数据，不含完整会话正文。
- **验收**：
  - `AC-FR-UX-001-01`：Given 已登录用户打开首页，When 加载成功，Then 显示五个入口且桌宠主体可见、带状态与提示文案。
  - `AC-FR-UX-001-02`：Given 某入口数据不可用（如无复习到期），When 渲染，Then 显示对应空态，不显示错误页。
  - `AC-FR-UX-001-03`：Given 首页接口超时或失败，When 用户操作，Then 显示可重试故障态，不阻塞其他已加载入口。
- **测试**：`TC-E2E-HOME-001`、`TC-A11Y-HOME-001`、`TC-RES-HOME-001`。

### FR-UX-002 点击桌宠进入或恢复会话

- **Parent CAP**：`CAP-001`
- **触发**：用户点击桌宠主体。
- **必须**：存在未完成任务/会话时恢复上次任务并定位到会话当前状态；无未完成会话时新建对话；恢复不重复创建会话或重新生成已存在内容。
- **异常**：会话被删除、权限失效、恢复目标不存在。
- **数据**：Session/CurrentTask 引用；恢复遵循 `FR-STREAM-001` 的持久化与重连语义。
- **验收**：
  - `AC-FR-UX-002-01`：Given 存在未完成会话，When 点击桌宠，Then 进入该会话并恢复到上次位置，不产生新会话。
  - `AC-FR-UX-002-02`：Given 无未完成会话，When 点击桌宠，Then 新建一个会话。
  - `AC-FR-UX-002-03`：Given 会话已被删除或无权限，When 点击恢复，Then 提示并新建会话，不暴露已删内容。
- **测试**：`TC-API-UX-001`、`TC-E2E-UX-001`。

### FR-UX-003 视觉小说式对话形态

- **Parent CAP**：`CAP-001`
- **触发**：用户处于对话视图。
- **必须**：桌宠 + 底部对话栏，展示角色名与当前语境；模型回答逐字显示（表现层），支持跳过动画与复制文本；支持快捷选项与自由输入，键盘用户全程可达；每个回答标记类型（提示/讲解/练习反馈/陪伴回应）。
- **异常**：流中断、逐字渲染失败、输入校验失败。
- **数据**：复用 `FR-STREAM-001` 的 MessageVersion/TurnStreamEvent；回答类型写入结构化字段。
- **验收**：
  - `AC-FR-UX-003-01`：Given 模型回答到达，When 渲染，Then 逐字显示且可跳过、可复制，动画不影响内容完整性。
  - `AC-FR-UX-003-02`：Given 键盘用户，When 需要输入，Then 可通过键盘完成快捷选项选择与自由输入，不被隐藏输入阻断。
  - `AC-FR-UX-003-03`：Given 每个回答，When 完成渲染，Then 带提示/讲解/练习反馈/陪伴回应类型标记。
  - `AC-FR-UX-003-04`：Given 流式中断，When 渲染恢复，Then 已交付前缀以不完整状态保留，提供重试或新 Turn 入口。
- **测试**：`TC-E2E-CONV-001`、`TC-A11Y-CONV-001`、`TC-RES-STREAM-001`。

### FR-UX-004 会话恢复与断线（衔接流式协议）

- **Parent CAP**：`CAP-001`
- **触发**：页面刷新、断线或 Tab 恢复后回到对话。
- **必须**：基于已持久化 MessageVersion/Turn 状态恢复展示，不依赖内存/缓存；Turn 处于 Interrupted/Failed/Cancelled 时标记不完整并提供明确入口（重试/新 Turn），不自动重跑模型；重连遵循 `STREAMING_PROTOCOL` 的 Last-Event-ID 与幂等语义，不产生重复业务结果。
- **异常**：游标过期、权限撤销、来源删除。
- **数据**：Turn/TurnStreamEvent 状态；撤权后按 `redacted` 规则隐藏正文。
- **验收**：
  - `AC-FR-UX-004-01`：Given 页面刷新或断线，When 回到对话，Then 恢复已持久化消息与当前 Turn 状态，无 sequence 空洞。
  - `AC-FR-UX-004-02`：Given Turn 为 Interrupted/Failed，When 展示，Then 标记不完整且提供重试/新 Turn 入口，不自动重跑。
  - `AC-FR-UX-004-03`：Given 会话来源被删除或撤权，When 重连，Then 不显示旧正文（redacted），且不泄露资源存在性。
- **测试**：`TC-RES-STREAM-001`、`TC-E2E-STREAM-001`、`TC-PRIV-STREAM-001`。

### BR-UX-001 桌宠状态机

- **Parent CAP**：`CAP-001`
- **规则**：桌宠主体状态至少包含空闲、对话中、恢复中、错误；定义合法迁移（空闲→对话中、空闲→恢复中→对话中、任意→错误、错误→空闲/对话中重试成功）；非法迁移拒绝并记录审计，不得显示不一致状态。
- **验收**：
  - `AC-BR-UX-001-01`：Given 当前为空闲，When 触发恢复且失败，Then 进入错误态并保留恢复入口，不伪装成对话中。
  - `AC-BR-UX-001-02`：Given 非法状态迁移，When 校验，Then 拒绝并记录，状态机迁移表有对应性质测试。
- **测试**：`TC-UNIT-UX-001`。

### BR-UX-002 空态与故障态

- **Parent CAP**：`CAP-001`
- **规则**：各入口无数据时显示既定空态文案（无目标/无到期复习/无日记），不是错误；接口或流式故障时显示可重试故障态，重试遵循幂等，不重复提交/生成；故障态不得展示部分或未验证内容。
- **验收**：
  - `AC-BR-UX-002-01`：Given 无到期复习或未生成日记，When 渲染对应入口，Then 显示空态文案，不报错。
  - `AC-BR-UX-002-02`：Given 提交或流式故障，When 用户重试，Then 幂等执行，不重复创建会话/题目/日记。
- **测试**：`TC-E2E-UX-002`、`TC-RES-DEGRADE-001`。

> 说明：响应式与键盘可达复用 `NFR-A11Y-001`（WCAG 2.2 AA），性能复用 `NFR-PERF-001`，不新增 NFR。

### FR-PER-001 人格问卷与跳过

- **Parent CAP**：`CAP-010`
- **触发**：用户首次进入可配置人格偏好的界面。
- **必须**：问卷至少包含语气、主动程度、称呼和提醒节奏四项字段，每项提供可理解选项与解释；用户可随时跳过问卷并使用中性默认值；跳过不阻断核心功能。
- **异常**：中途退出、字段校验失败、重复提交。
- **数据**：PersonaPreferences 结构化字段；问卷回答可选保留；不涉及安全策略与数据权限。
- **验收**：
  - `AC-FR-PER-001-01`：Given 用户首次使用，When 进入问卷，Then 展示语气/主动程度/称呼/提醒节奏四项并可选跳过。
  - `AC-FR-PER-001-02`：Given 用户跳过问卷，When 继续使用，Then 使用中性默认值且核心功能不被阻断。
  - `AC-FR-PER-001-03`：Given 用户中途退出问卷，When 返回，Then 已填项不产生未授权生效，回到中性默认或上次保存值。
- **测试**：`TC-E2E-PER-001`、`TC-A11Y-PER-001`。

### FR-PER-002 偏好修改与重置

- **Parent CAP**：`CAP-010`
- **触发**：用户修改或重做人格偏好。
- **必须**：每项偏好可单独修改与重置；支持整份重做问卷；修改立即影响后续表达/提醒；重置需明确确认。
- **异常**：并发修改、重置确认超时。
- **数据**：偏好版本化；修改不改变历史会话内容。
- **验收**：
  - `AC-FR-PER-002-01`：Given 用户修改单项偏好，When 保存，Then 仅该项更新且后续表达/提醒生效。
  - `AC-FR-PER-002-02`：Given 用户重置或重做问卷，When 确认，Then 偏好回到中性默认或新问卷结果，历史内容不受影响。
- **测试**：`TC-API-PER-001`、`TC-E2E-PER-001`。

### FR-PER-003 偏好生效范围

- **Parent CAP**：`CAP-010`
- **必须**：偏好只影响后续表达、语气与提醒节奏；不更改历史事实、学习记录、数据权限或安全策略；偏好修改不追溯改写已生成内容。
- **验收**：
  - `AC-FR-PER-003-01`：Given 用户修改偏好，When 生效，Then 仅影响后续表达/提醒，历史会话与学习记录不变。
  - `AC-FR-PER-003-02`：Given 偏好与数据权限/删除规则冲突，When 校验，Then 以数据权限/安全策略为准。
- **测试**：`TC-E2E-PER-001`、`TC-PRIV-PER-001`。

### BR-PER-001 中性默认值规则

- **Parent CAP**：`CAP-010`
- **规则**：未完成问卷或跳过时使用中性默认语气/主动程度/称呼/提醒节奏；中性默认不得过度主动或暗示依赖；默认值变更走 `CR-*`。
- **验收**：
  - `AC-BR-PER-001-01`：Given 用户未配置偏好，When 系统表达或提醒，Then 使用中性默认且不产生过度主动行为。
- **测试**：`TC-UNIT-PER-001`。

### BR-PER-002 安全覆盖边界

- **Parent CAP**：`CAP-008`、`CAP-010`
- **规则**：人格/偏好不得覆盖安全规则、危机响应、删除/退出控制与数据权限；安全策略优先于人格表达（见 [AI 质量规范 §1](../AI_QUALITY_SAFETY.md#1-ai-责任边界)）；越权覆盖尝试被拒绝并审计。
- **验收**：
  - `AC-BR-PER-002-01`：Given 人格或偏好与安全/危机响应冲突，When 生成，Then 以安全规则为准并拒绝人格覆盖。
  - `AC-BR-PER-002-02`：Given 尝试通过偏好覆盖删除/退出/权限，When 处理，Then 拒绝并记录审计。
- **测试**：`TC-AIEVAL-SAFE-001`、`TC-SEC-PER-001`。

### FR-EXT-001 附件上传与用途声明

- **Parent CAP**：`CAP-012`
- **触发**：用户上传题目、图表或代码截图。
- **必须**：上传前展示允许格式、大小与用途；按格式/大小/解压比校验，超限拒绝并说明；上传后进入扫描与解析管线。
- **异常**：格式不支持、超大小、上传失败、重复上传。
- **数据**：Attachment 元数据与用途 scope；遵循对象存储与扫描基线（见[架构 §2](../ARCHITECTURE.md#2-技术栈基线)）。
- **验收**：
  - `AC-FR-EXT-001-01`：Given 用户上传附件，When 提交，Then 先展示允许格式/大小/用途，超限拒绝并说明原因。
  - `AC-FR-EXT-001-02`：Given 上传成功，When 处理，Then 进入扫描与解析管线，未通过扫描不得用于答疑。
- **测试**：`TC-API-EXT-001`、`TC-SEC-EXT-001`。

### FR-EXT-002 解析、预览与纠正

- **Parent CAP**：`CAP-012`
- **触发**：附件解析完成或失败。
- **必须**：展示 OCR/解析结果预览；支持裁剪、重传或转文字；解析失败不臆测题目，提供明确恢复路径。
- **异常**：OCR 低置信、解析失败、裁剪冲突。
- **数据**：OCR/解析结果与置信度；裁剪覆盖原解析结果。
- **验收**：
  - `AC-FR-EXT-002-01`：Given 解析完成，When 展示，Then 展示可预览结果并允许裁剪/重传/转文字。
  - `AC-FR-EXT-002-02`：Given 解析失败或低置信，When 处理，Then 不臆测题目，提供重传/转文字路径。
- **测试**：`TC-E2E-EXT-001`、`TC-API-EXT-001`。

### BR-EXT-001 OCR 置信度与低置信处理

- **Parent CAP**：`CAP-012`
- **规则**：OCR 结果带置信度；低置信或失败时不得将臆测内容作为题目/事实；转文字需用户确认；错误恢复幂等，不重复产生解析结果。
- **验收**：
  - `AC-BR-EXT-001-01`：Given OCR 置信度低于阈值，When 处理，Then 标记低置信，不自动入题或作为事实，提供确认/重传/转文字。
  - `AC-BR-EXT-001-02`：Given 解析失败后用户重试，When 提交，Then 幂等执行，不产生重复解析结果。
- **测试**：`TC-AIEVAL-EXT-001`、`TC-RES-EXT-001`。

### BR-EXT-002 附件保留与删除传播

- **Parent CAP**：`CAP-012`
- **规则**：附件及派生物（OCR/缩略图/向量）遵循保留期；删除原件时展示派生物影响并同步清除；24 小时内完成在线副本/索引清理（衔接 `DATA-DEL-001`）。
- **验收**：
  - `AC-BR-EXT-002-01`：Given 用户删除附件，When 确认，Then 删除原件并清除 OCR/缩略图/向量/缓存，24 小时内完成。
  - `AC-BR-EXT-002-02`：Given 附件保留期到期，When 清理任务运行，Then 按策略清除派生物并记录，不进入模型召回。
- **测试**：`TC-PRIV-DEL-001`、`TC-INTEG-EXT-001`。

<a id="srs-sec-ten"></a>

### SEC-TEN-001 工作区/数据主体隔离

- **Parent CAP**：`CAP-001`～`CAP-032`（适用于 MVP 全部数据面，P2/P3 增加组织/插件角色）
- **必须**：所有业务实体、Turn 事件、后台 Job、缓存键、对象路径、索引和导出任务都绑定 `(workspaceId, subjectUserId)`；组织管理员、教师、监护人或插件只能以单独 `actorId` 表示，不得替代数据主体。应用鉴权与 PostgreSQL RLS、复合外键和队列幂等键必须共同强制该边界。
- **验收**：
  - `AC-SEC-TEN-001-01`：Given actor 对 workspace 有管理权限但不是 subjectUserId，When 读取/导出/删除另一主体数据，Then 仅返回获授权字段并完整审计，不泄露未授权正文。
  - `AC-SEC-TEN-001-02`：Given 相同业务 ID 出现在两个 workspace，When 访问 API、SSE、索引、对象和 Job，Then 只能访问当前 workspace/subjectUserId 的记录。
  - `AC-SEC-TEN-001-03`：Given 删除或撤权一个主体，When Worker 重试/重放旧 Job，Then 旧任务因租户和权限快照校验被拒绝，不影响其他主体。
- **测试**：`TC-SEC-TENANT-001`、`TC-INTEG-RLS-001`、`TC-E2E-ORG-001`。

## 3. 记忆业务规则

### BR-MEM-001 四段记忆转换

临时→短期只能轻度压缩；短期→长期才允许抽象；长期→系统只生成树状投影。每层保留独立 Revision、来源、算法/Prompt/模型版本和生命周期字段。AI 召回期限与用户历史保留期限分离。

### BR-MEM-002 晋升分类

`user_fact` 和 `user_preference` 必须用户确认；`learning_event` 可在来源完整、无冲突、达到阈值后自动沉淀；`inference` 只能作为带标签候选。任何无来源推断不得写成用户事实。

### BR-MEM-003 记忆树投影

系统记忆是可重建投影。每个节点有 canonical parent，层级边无环；跨主题、因果和对比关系使用独立边并继承来源权限和删除状态。投影失败降级为可检索长期记忆列表，不影响事实数据。

## 4. 跨域数据与控制规则

<a id="srs-data-stream"></a>

### DATA-STREAM-001 Turn 事件保留与删除

`TurnStreamEvent` 仅用于在线传输和恢复，不是第二份长期会话真源。MVP 正文事件默认支持 24 小时在线重放；任何正文保留不得超过对应 `MessageVersion` 可见保留、有效同意和来源可用期中的最短期限。窗口结束、来源删除或撤权后只保留不含正文的最小事件元数据/tombstone，并通过新 `redacted` 事件表达可见性变化，不改写旧事件。

- `AC-DATA-STREAM-001-01`：Given 事件正文超过在线重放窗口或对应来源/同意失效，When 清理任务运行，Then 正文不可再读取，仅保留符合审计期限的最小元数据或 `redacted` 状态。
- `AC-DATA-STREAM-001-02`：Given 消息来源被删除或权限撤销，When 客户端重连或已有连接发送下一事件，Then 不发送旧正文，主动断流或发送不含正文的 `redacted`，且零召回验证通过。
- **测试**：`TC-PRIV-STREAM-001`、`TC-INTEG-STREAM-RET-001`。

<a id="srs-br-ctrl"></a>

### BR-CTRL-001 RecoveryControlLedger 一致性

删除、同意撤销、插件撤权和外部同步撤权必须先以确定性 `eventId/idempotencyKey` 写入与业务 PostgreSQL 分离凭据、分离故障域的 `RecoveryControlLedger` 并取得 durable ack，再幂等提交业务状态、DeletionRequest/Outbox 和派生清理。账本是 deny 控制事实源：账本已写而业务提交失败时由 reconciler 按连续 sequence 重放；账本不可用、签名/序列有缺口、保留不足以覆盖最老可恢复备份或应用水位未追平时，受影响范围必须 fail closed。

- `AC-BR-CTRL-001-01`：Given 账本 append 成功而业务事务失败，When reconciler 扫描新 sequence，Then 幂等补齐 deny/撤权状态且不会重复清理或恢复权限。
- `AC-BR-CTRL-001-02`：Given 账本不可用、重复/乱序或 sequence 缺口，When 执行控制请求或 PITR 开放流量，Then 系统保持 fail closed、告警并拒绝宣告完成。
- `AC-BR-CTRL-001-03`：Given 恢复点早于删除/撤权，When 完成 PITR，Then 在开放流量前校验账本水位、按序重放并通过零召回/零越权验证。
- **测试**：`TC-RES-LEDGER-001`、`TC-PRIV-DEL-001`、`TC-SEC-REVOKE-001`。

<a id="srs-nfr"></a>

## 5. 非功能原子需求

| ID | 必须满足 |
|---|---|
| `NFR-PERF-001` | 非 AI 读/写 P95 ≤ 300/500 ms；TTFT 从 Turn 持久化接受开始计至首个通过分段安全检查且已持久化的可见片段，P95 ≤ 8 s，另记端到端首段渲染延迟；流式详细协议以 [STREAMING_PROTOCOL](../contracts/STREAMING_PROTOCOL.md) 为准 |
| `NFR-REL-001` | 消息/作答先持久化；POST Turn + GET SSE 的重连/取消/重复提交不丢失已展示分段或重复形成业务结果；未通过分段安全门的内容不得展示/进入记忆 |
| `NFR-JOB-001` | 日记 95% 在设定时间后 15 分钟内完成；复习/通知 P95 延迟 ≤ 5 分钟 |
| `NFR-DR-001` | MVP 每日加密备份并每季度恢复演练；成长期 RPO ≤ 5 分钟、RTO ≤ 1 小时；恢复前重放与业务库独立故障域的 `RecoveryControlLedger` |
| `NFR-A11Y-001` | 核心 Web 流程 WCAG 2.2 AA |
| `NFR-SEC-001` | 全部生命周期能力遵循 OWASP ASVS L2、工作区/数据主体隔离、最小权限、供应链扫描、流式撤权和审计；任何越权或高危供应链/许可证问题阻断发布 |
| `NFR-PRIV-001` | 逐项同意、立即禁用召回、24 小时在线删除、标准导出 |

## 6. P1/P2/P3 规格化规则

能力地图中的 `CAP-014`～`CAP-032` 已保留全生命周期范围，但在对应 `R2`～`R5` 进入开发前，必须按以下最小结构补齐：

1. 一个 `FR-*` 主行为和至少一个 `BR-*` 业务规则；
2. 正常、空态、失败、取消、撤权、并发和删除传播场景；
3. API/事件、数据实体、权限、AI/安全、无障碍、性能和成本影响；
4. 至少一个原子 `AC-*`、一个自动化 `TC-*` 和一个人工验收证据；
5. Owner、Feature Flag、迁移、灰度、回滚、风险和许可证结论。

不满足上述条件的状态必须保持 `Mapped` 或 `Specified`，不得标记为 `Ready`、`Verified` 或 `Released`。
