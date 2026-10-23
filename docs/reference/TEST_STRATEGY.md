---
id: AVX-QA-001
---

# Aervox｜思隅 测试策略

关联：[SRS](SRS.md) · [需求追踪](REQUIREMENTS_TRACEABILITY.md) · [AI 质量](AI_QUALITY_SAFETY.md)

## 1. 测试原则

- 从 `CAP -> FR/BR/NFR/DATA/AIQ/SEC/PRIV/OPS -> AC -> TC -> 证据` 双向追踪。
- 高风险的数据删除、权限、安全、记忆来源和日记事实不能只靠人工体验。
- 正常 CI 使用模型 stub/固定回放；真实供应商只在受控评估/灰度运行，避免非确定性和数据泄露。
- 每个 Bug 回归用例反向关联需求；无需求来源的行为先澄清，不让测试成为隐式产品定义。

## 2. 测试金字塔与执行指令

Aervox 测试体系收敛为清晰的四层模型，各层权责明确、指令统一：

| 层级 | 工具与环境 | 核心覆盖范围 | 标准执行指令 |
|---|---|---|---|
| 1. 架构与守卫层 | Node 原生测试、AST 边界扫描 | 依赖纯度、禁用标识符、文档与治理规则、CI 作用域覆盖、插件打包规范 | `mise exec -- pnpm test:guards`<br>`mise exec -- pnpm check:guards` |
| 2. 单元与业务包集成层 | Monorepo Vitest、`@vue/test-utils`、内存/隔离 SQLite | 纯逻辑、领域契约、前端组件、状态机、数据访问层与业务聚合 | `./aervox test unit`（选定包集）<br>`./aervox test affected`（变更增量）<br>`./aervox test all`（Monorepo 全量 2 并发）<br>`./aervox test <pkg>` |
| 3. 领域专项与原生契约层 | 独立专项 Runner、Cargo / Rust 工具链 | 记忆删除可验证性、故障注入断言、Native 运行时与向量搜索基准、HLS 契约 | `mise exec -- pnpm check:memory-deletion`<br>`mise exec -- pnpm check:deletion-fault-testing`<br>`mise tasks run native-runtime-check`<br>`mise exec -- pnpm check:hls` |
| 4. 系统集成与端到端层 | Playwright、CLI 冒烟脚本 | 端到端学习与对话闭环、API SSE 流式契约、Desktop/Web 交互、CLI 客户端集成冒烟 | `mise exec -- pnpm test:e2e:api`<br>`mise exec -- pnpm test:e2e:ui`<br>`mise exec -- pnpm test:cli:integration` |

### 2.1 统一命令速查

根目录 `./aervox` 提供本地开发的统一分发入口：

- `./aervox test affected`（默认）：智能分析 git 变更范围，仅运行改动包及其全部下游依赖测试。
- `./aervox test unit`：运行核心逻辑、领域契约、前端组件与插件的选定包集；具体范围以根 `package.json` 的 `test:unit` 为准，可能包含集成测试与依赖构建。
- `./aervox test guards`：运行架构、契约与文档治理等全部脚本级守护测试。
- `./aervox test all`：等价于 `pnpm test` / `pnpm test:all`，受控 2 并发执行 Monorepo 全部测试套件。
- `./aervox test <pkg>`：支持真实包名、目录短名（如 `api`、`repositories`、`companion-ui`）与 pnpm 过滤器；无匹配包或选中包均未声明测试时失败。

`pnpm test` 保持全量语义；智能增量使用 `pnpm test:affected` 或默认的 `./aervox test`。命令耗时取决于选择范围、构建缓存与运行环境。

所有命令从仓库根经 `./aervox` 或 `mise exec --` 使用锁定工具链；直接脚本测试不自动代表依赖和产物已构建。CLI 安装闭环入口会按拓扑先构建 API/CLI；API 包测试对原生制品声明显式任务依赖。全量本地终审使用 `./aervox ci all`，远端还有独立 API/Chromium E2E 与依赖审计，均应核对同一 head 的最终结论。空检查、排队、运行中和旧 head 的成功不能当作当前门禁通过。

### 2.2 专项质量与可靠性要求

- **AI 质量与评估**：版本化 EvalSet 与人工双标，覆盖教学事实、提示保护、安全合规、记忆压缩、日记来源；
- **本地性能与单机韧性**：针对 SQLite 写入竞争、连续流式长会话与跨周期运行，执行本地压测与故障注入；
- **安全与隐私**：Loopback 监听绑定校验、文件 ACL、CSRF/CSP、插件沙箱隔离与删除后零召回。

## 3. P0 必测路径

1. 创建目标→问题→提示→用户尝试→反馈→错题/复习。
2. 普通疲惫与高风险表达的分流，安全响应不被人格覆盖。
3. 临时→短期→长期候选→树投影，关键约束/代表性例子/来源/推断标签正确；短期首次整理不过度压缩，长期逐步省略，重建树后仍叠加用户锁定、改名和父节点调整的 `MemoryProjectionOverride`。
4. 日记同 `localDate` 标签重复任务、22:00→00:30 及 00:30→22:00 计划变更、停用/重新启用、跨午夜、DST、15m 首版、`bufferClosedAt` 前后迟到来源、来源删除；验证滚动窗口无重叠/空洞且不把标签去重键当作 00:00～24:00 素材窗口。
5. 日记任务重复投递、两个 Worker 并发领取、lease 过期和旧 Worker 晚返回；验证 fencing token 与 `scheduleVersion` CAS 拒绝旧写入，失败/取消不推进 cursor，只有 `Published` 或有证据的 `Skipped` 与 cursor 原子提交。
6. 首次窗口左闭、常规窗口左开右闭；验证 `occurredAt` 决定周期归属、`ingestedAt` 只决定迟到资格，历史迟到来源不进入当前/下一周期，多日宕机按截止点顺序恢复且不自动合并，空日记与显式跳过状态不同，quiet hours 不改变生成或 cursor。
7. POST 幂等创建 Turn→GET SSE；覆盖 `Last-Event-ID` 重连、重放与实时订阅交界、重复事件去重、sequence 空洞、游标过期、慢消费者、显式取消、断线、API/Worker 崩溃和过期 Attempt。断言原始供应商 token 不直达客户端，只有通过安全门且已持久化的分段可见，已显示前缀在中断后以 `Partial/Interrupted` 保留且不产生下游记忆/评分/日记来源。
8. 消息编辑版本、单条/全部本地数据删除、导出、备份恢复后删除不复活；恢复在全局 deny/维护状态下按 `RecoveryControlLedger.sequence` 校验水位、幂等重放，再完成索引重建和零召回/零越权验证后开放本地流量。
9. 模型超时、数据库锁定/不可用、队列重复投递、索引失败、埋点失败、恢复账本不可用/序列缺口的 fail-closed 降级。

### 3.1 并发与状态机断言

- 使用数据库级并发测试证明同一 Turn 只有当前 Attempt、同一 DiaryCycle 只有当前 fencing token 能追加事件或提交终态；不能只通过 mock 验证。
- 对 Turn、DiaryCycle、DeletionRequest 和恢复账本建立状态迁移表测试，随机生成重复、乱序、超时和崩溃序列，断言非法迁移、重复业务结果和 cursor 越级均被拒绝。
- 对 `scheduleVersion/cursorVersion`、Turn revision 和 Cancel/Finalize 竞态执行真实 SQLite CAS 测试，并保存失败事务与最终唯一状态证据。

### 3.2 本地边界、迁移、来源与恢复断言

- 默认配置验证 API 只监听 loopback；`open` 认证与非 loopback 地址必须启动失败。验证本地数据目录对其他操作系统用户默认不可读，插件 `actorId` 和 Grant 不能扩大文件、工具或网络权限。
- 本地数据迁移覆盖零/单/多数据范围、显式范围选择、备份哈希、staging 新库、逐表行数/外键/FTS 校验、原子换库和 rollback。对每个状态转换点执行崩溃注入；重复业务键、孤儿外键和损坏 JSON 必须 fail closed，不得静默删除或改写业务键。
- `SourceArtifact/SourceRevision` 的编辑、撤权、删除和版本切换必须传播到 ContextManifest、EmbeddingIndex、记忆证据、日记段落与缓存；禁止残余 `sourceType + sourceId` 弱关联路径。
- 恢复账本测试覆盖“账本成功/业务失败”“账本失败”“重复 eventId”“sequence 缺口”“业务 PITR 回退到旧水位”和账本防篡改校验；任何未追平状态均不得确认删除完成或恢复业务流量。

### 3.3 流式协议断言

- 对每个公开 SSE 事件验证 UTF-8 framing、稳定 `eventId`、Turn 内连续 `sequence`、payload schema、终态关闭、heartbeat 无业务 ID，以及建流前 Problem Details/建流后持久化终态错误。
- 客户端按 `eventId` 去重、按 sequence 检测空洞；授权撤销或来源删除后追加 `redacted/revoked` 事件并关闭相关订阅，不能原地改写既有事件 payload。
- TTFT 从 Turn 持久化接受计至首个通过安全门且已持久化的可见分段；同时分解输入检查、Provider 首 token、分段缓冲、安全检查、数据库提交和客户端渲染耗时。

### 3.4 CAP-033 主动智能模式断言

- 授权向导只在 `full_access`、用户确认 `full_profile_v1`、受信 Host、OS grant、local-ready 和 activation lease 同时满足时进入 active；取消、重复提交、缺少权限和 token 错误均不产生部分生效授权。
- 覆盖 Aervox activity/operation、剪贴板及平台适配器的来源 provenance；未接入或被撤销的应用、浏览器、屏幕、文件、通信、音视频、位置和传感器来源不得采集，状态必须显示 limited/缺口。
- 原始捕获 `retentionUntil=observedAt+7d`；七天前不清理，七天后仅在 `distilled` 时清理，pending/failed 进入重试/blocked；用户主动删除可提前触发零召回。
- `FullProfileActionGrant` 覆盖 `action.local`、`action.external`、`action.privileged` 和 `action.irreversible` 时，校验 revision、target、lease、OS/身份、deny watermark 和幂等键；未授权动作不产生副作用。
- 本地 Vault 加密、owner-only `proactive-access.token`（`0600`）、字面 loopback、禁止 redirect/代理、导出字段过滤和后台 heartbeat 必须有自动化测试；token 不得出现在日志、备份或导出。
- 启用开机自启、应用退出后常驻、休眠恢复和重启恢复时，验证用户通知、恢复前授权复核、暂停/撤权优先和崩溃后不重复动作。

1. Turn 流式契约：重复 POST 幂等、首个安全持久化 `delta` 的 TTFT、SSE 高水位重放、Last-Event-ID 映射/过期、取消 CAS、首片段前 TurnAttempt 重试、首片段后 `Interrupted`、旧 Worker fencing、撤权主动断流，以及原始 Provider chunk 不出客户端。
2. `RecoveryControlLedger` 独立故障域：账本先写获得 durable ack、业务提交失败后的 reconciler 重放、重复/乱序/序列缺口、账本不可用时 fail closed，以及 PITR 前后水位校验。
3. 未认证非 loopback 客户端、未获 Grant 的插件或外部连接器读取、导出、删除本地数据的拒绝与审计场景。

### 3.5 已有运行时边界回归

| 边界 | 可执行入口 | 证据限制 |
|---|---|---|
| 工具 Schema 与派发 | [有界 Schema](../../packages/core/test/tool-schema-completion.test.ts)、[宿主工具](../../packages/host-runtime/test/tool-provider-contract.test.ts) | 未支持断言、非 JSON、复杂度上限及 handler 前拒绝；不是完整 JSON Schema 方言 |
| DSH 文件和命令 | [DSH 回归](../../packages/host-runtime/test/ecosystem/mcp/dsh-bridge.test.ts) | symlink/inode、预取消、运行中取消、超时与输出限制；不能推定 OS 沙箱或脱离进程组的命令已回收 |
| Page 写入及删除 | [BundleStore](../../packages/host-runtime/test/ecosystem/plugins/bundle-store.test.ts) | 祖先链接、ownership marker、缺失目录和拒绝后数据保留；不是同 OS 用户并发目录交换的隔离证明 |
| ZIP 与断连 | [归档 Worker](../../apps/api/test/archive-worker.test.ts)、[断连](../../apps/api/test/archive-disconnect.test.ts) | 规范化/大小写冲突、文件父目录冲突在展开及替换前拒绝，取消和输出预算；不是任意归档写入整体回滚 |
| SSE 一致快照与背压 | [HTTP 路由](../../packages/host-runtime/test/sse-routes.test.ts)、[慢 TCP](../../apps/api/test/conversation-stream-bounded.test.ts)、[分页](../../packages/repositories/test/stream-event-pagination.test.ts) | 运行续接不被旧终态截断、断线可补读、背压停取页；逐帧撤权和全局并发预算仍独立验收 |
| Worker 完整关闭 | [真实子进程](../../apps/worker/test/shutdown-process.test.ts) | 累计截止、重复信号、挂起/异常和两库关闭顺序；不证明同步阻塞可打断或全部后台写者已排空 |
| CLI 列表分页 | [CLI](../../apps/cli/test/cli.test.ts)、[安装闭环](../../scripts/cli-smoke.test.mjs) | 默认页、合法后页、非法参数及持久服务集成；不是快照分页或全量导出 |

## 4. AI 评估

每次模型/Prompt/算法变更记录 EvalSet 版本、样本量、语言/领域、标注协议、结果、95% 置信区间和失败样本。CAP-033 另评估跨来源画像证据、七天提炼清理、动作目标授权和本地 Provider 证明；原始画像不得上传评估供应商。门槛采用 [AI 质量规范](AI_QUALITY_SAFETY.md#43-mvp-门槛)。危机召回、来源覆盖和删除后零召回未达 100% 时阻断发布。

## 5. 发布覆盖门槛

- 目标版本内需求 100% 有 AC 和 TC；所有 P0 AC 有自动化或批准的人工证据。
- 单元/集成/契约/E2E 全部通过；不以总代码覆盖率替代关键分支覆盖。
- 数据删除、恢复账本、权限、本地 API/文件边界、破坏性迁移、备份恢复、弱网/SSE 重连、DST、无障碍和安全对抗用例通过。
- 失败/隔离测试证明分析、通知、模型、插件和派生索引故障不破坏业务事实；CAP-033 的本地 Vault/Provider/Host 故障不得远程降级或产生未授权动作。
- 残余风险有期限和批准；测试证据记录构建、commit、环境、时间和执行者。

## 6. 当前阻断

- 删除传播已不再是整体占位：`apps/api/test/conversation-deletion.test.ts` 与 `apps/api/test/proactive.test.ts`（来源级 revoke/delete：撤销 consent、scrub capture、删 observation/claim、撤销动作）提供可执行证据；追踪矩阵中仍为占位 ID 的 `TC-*` 在目标版本 G1 前逐项替换为可点击用例并回填。
- CAP-033 全量平台适配（应用活动正文、通信、音视频、位置等 Provider）、生产 OS Broker 与全链本地出网证明仍未闭合；各子能力的实现状态按追踪基线分别记录，局部测试不能升格为全部平台或生产发布验收。
- 测试范围须覆盖 `packages/core` 内核矩阵（契约/回放/状态机/fencing，见 [Agent Harness Loop §16.1](agent-harness-loop.md#16-测试与验收)）与 CLI 冒烟（`scripts/cli-smoke.test.mjs`、`test:cli:integration`）。

进入 G1 前建立可执行用例仓库/任务并回填追踪矩阵。
