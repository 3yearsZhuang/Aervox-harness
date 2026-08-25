# Aervox｜思隅 测试策略

> 文档编号：AVX-QA-001  
> 版本：v0.2（评审候选）  
> 更新日期：2026-08-24  
> 状态：Review Candidate  
> QA Owner：待指定  
> 关联：[SRS](SRS.md) · [需求追踪](REQUIREMENTS_TRACEABILITY.md) · [AI 质量](AI_QUALITY_SAFETY.md)

## 1. 测试原则

- 从 `CAP -> FR/BR/NFR/DATA/AIQ/SEC/PRIV/OPS -> AC -> TC -> 证据` 双向追踪。
- 高风险的数据删除、权限、安全、记忆来源和日记事实不能只靠人工体验。
- 正常 CI 使用模型 stub/固定回放；真实供应商只在受控评估/灰度运行，避免非确定性和数据泄露。
- 每个 Bug 回归用例反向关联需求；无需求来源的行为先澄清，不让测试成为隐式产品定义。

## 2. 测试金字塔

| 层 | 工具/环境 | 覆盖 |
|---|---|---|
| Unit/property | Vitest、fast-check | 状态机、调度、时区/DST、连续窗口、压缩 schema、投影覆盖、幂等、fencing/CAS、删除依赖图 |
| Integration | In-Memory/Isolated SQLite、Redis/S3 | Outbox、队列重放、TenantContext/复合外键、索引、DiaryCycle/cursor、恢复账本、删除传播 |
| Contract | OpenAPI/事件 schema diff、Provider/plugin fixtures | API 兼容、SSE framing/重放、模型适配、插件权限、外部同步 |
| E2E | Playwright | 学习闭环、复习、日记、多日恢复、消息编辑/删除、流式重连/取消、导出、弱网恢复、无障碍 |
| AI Eval | 版本化 EvalSet + 人工双标 | 教学事实、提示泄露、安全、记忆压缩、日记来源、Prompt injection |
| Performance/resilience | k6/自选负载工具、故障注入 | 100 并发流式、2 倍峰值、供应商/Redis/DB/S3 故障 |
| Security/privacy | ASVS 检查、SAST/DAST/SBOM/Secret scan | 越权、RLS、CSRF/CSP、插件、附件、删除后零召回 |

## 3. P0 必测路径

1. 创建目标→问题→提示→用户尝试→反馈→错题/复习。
2. 普通疲惫与高风险表达的分流，安全响应不被人格覆盖。
3. 临时→短期→长期候选→树投影，关键约束/代表性例子/来源/推断标签正确；短期首次整理不过度压缩，长期逐步省略，重建树后仍叠加用户锁定、改名和父节点调整的 `MemoryProjectionOverride`。
4. 日记同 `localDate` 标签重复任务、22:00→00:30 及 00:30→22:00 计划变更、停用/重新启用、跨午夜、DST、15m 首版、`bufferClosedAt` 前后迟到来源、来源删除；验证滚动窗口无重叠/空洞且不把标签去重键当作 00:00～24:00 素材窗口。
5. 日记任务重复投递、两个 Worker 并发领取、lease 过期和旧 Worker 晚返回；验证 fencing token 与 `scheduleVersion` CAS 拒绝旧写入，失败/取消不推进 cursor，只有 `Published` 或有证据的 `Skipped` 与 cursor 原子提交。
6. 首次窗口左闭、常规窗口左开右闭；验证 `occurredAt` 决定周期归属、`ingestedAt` 只决定迟到资格，历史迟到来源不进入当前/下一周期，多日宕机按截止点顺序恢复且不自动合并，空日记与显式跳过状态不同，quiet hours 不改变生成或 cursor。
7. POST 幂等创建 Turn→GET SSE；覆盖 `Last-Event-ID` 重连、重放与实时订阅交界、重复事件去重、sequence 空洞、游标过期、慢消费者、显式取消、断线、API/Worker 崩溃和过期 Attempt。断言原始供应商 token 不直达客户端，只有通过安全门且已持久化的分段可见，已显示前缀在中断后以 `Partial/Interrupted` 保留且不产生下游记忆/评分/日记来源。
8. 消息编辑版本、单条/账户删除、导出、备份恢复后删除不复活；PITR 在全局 deny/维护状态下按 `RecoveryControlLedger.sequence` 校验水位、幂等重放，再完成索引重建和零召回/零越权验证后开放流量。
9. 模型超时、Redis 丢失、队列重复投递、索引失败、埋点失败、恢复账本不可用/序列缺口的 fail-closed 降级。

### 3.1 并发与状态机断言

- 使用数据库级并发测试证明同一 Turn 只有当前 Attempt、同一 DiaryCycle 只有当前 fencing token 能追加事件或提交终态；不能只通过 mock 验证。
- 对 Turn、DiaryCycle、DeletionRequest 和恢复账本建立状态迁移表测试，随机生成重复、乱序、超时和崩溃序列，断言非法迁移、重复业务结果和 cursor 越级均被拒绝。
- 对 `scheduleVersion/cursorVersion`、Turn revision 和 Cancel/Finalize 竞态执行真实 SQLite CAS 测试，并保存失败事务与最终唯一状态证据。

### 3.2 多租户、来源与恢复断言

- 每个业务事实、派生数据、Job 和通知验证 `(workspaceId, subjectUserId)` 复合边界；`actorId` 不能替代数据主体。覆盖跨工作区 ID 猜测、队列载荷篡改、管理员/监护人越权和 RLS 绕过。
- `SourceArtifact/SourceRevision` 的编辑、撤权、删除和版本切换必须传播到 ContextManifest、EmbeddingIndex、记忆证据、日记段落与缓存；禁止残余 `sourceType + sourceId` 弱关联路径。
- 恢复账本测试覆盖“账本成功/业务失败”“账本失败”“重复 eventId”“sequence 缺口”“业务 PITR 回退到旧水位”和账本防篡改校验；任何未追平状态均不得确认删除完成或恢复业务流量。

### 3.3 流式协议断言

- 对每个公开 SSE 事件验证 UTF-8 framing、稳定 `eventId`、Turn 内连续 `sequence`、payload schema、终态关闭、heartbeat 无业务 ID，以及建流前 Problem Details/建流后持久化终态错误。
- 客户端按 `eventId` 去重、按 sequence 检测空洞；授权撤销或来源删除后追加 `redacted/revoked` 事件并关闭相关订阅，不能原地改写既有事件 payload。
- TTFT 从 Turn 持久化接受计至首个通过安全门且已持久化的可见分段；同时分解输入检查、Provider 首 token、分段缓冲、安全检查、数据库提交和客户端渲染耗时。

1. Turn 流式契约：重复 POST 幂等、首个安全持久化 `delta` 的 TTFT、SSE 高水位重放、Last-Event-ID 映射/过期、取消 CAS、首片段前 TurnAttempt 重试、首片段后 `Interrupted`、旧 Worker fencing、撤权主动断流，以及原始 Provider chunk 不出客户端。
2. `RecoveryControlLedger` 独立故障域：账本先写获得 durable ack、业务提交失败后的 reconciler 重放、重复/乱序/序列缺口、账本不可用时 fail closed，以及 PITR 前后水位校验。
3. 代组织管理员/教师/插件 `actorId` 操作另一数据主体 `subjectUserId` 的越权、导出、删除、日记唯一性和审计场景。

## 4. AI 评估

每次模型/Prompt/算法变更记录 EvalSet 版本、样本量、语言/领域、标注协议、结果、95% 置信区间和失败样本。门槛采用 [AI 质量规范](AI_QUALITY_SAFETY.md#43-mvp-门槛)。危机召回、来源覆盖和删除后零召回未达 100% 时阻断发布。

## 5. 发布覆盖门槛

- 目标版本内需求 100% 有 AC 和 TC；所有 P0 AC 有自动化或批准的人工证据。
- 单元/集成/契约/E2E 全部通过；不以总代码覆盖率替代关键分支覆盖。
- 数据删除、恢复账本、权限、多租户、迁移、备份恢复、弱网/SSE 重连、DST、无障碍和安全对抗用例通过。
- 失败/隔离测试证明分析、通知、模型、插件和派生索引故障不破坏业务事实。
- 残余风险有 Owner、期限和批准；测试证据记录构建、commit、环境、时间和执行者。

## 6. 当前阻断

当前 AC/TC 仍是文档中的稳定占位 ID，尚未关联代码、CI 或人工证据，全部能力状态不得超过 `Specified`。进入 G1 前由 QA 建立可执行用例仓库/任务并回填追踪矩阵。
