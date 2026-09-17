---
id: AVX-EXPL-010
type: explanation
scope: guide
planning_role: evidence
owner: platform
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.3.0
updated_at: 2026-09-18
reviewed_at: 2026-09-18
review_interval_days: 30
review_triggers:
  - packages/repositories/**
  - packages/agent-loop/**
  - packages/host-agent/**
  - apps/worker/**
  - apps/api/src/modules/companion/conversation/**
  - apps/api/src/modules/ecosystem/plugins/**
  - packages/ui/src/components/plugin/PluginPageDialog.vue
  - turbo.json
sources:
  - docs/reference/ARCHITECTURE.md
  - docs/reference/DATABASE.md
  - docs/reference/agent-harness-loop.md
  - docs/reference/STREAMING_PROTOCOL.md
  - docs/reference/adr/ADR-004-outbox-idempotent-jobs.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
  - docs/reference/plugin-config-and-pages.md
  - docs/explanation/companion-hardware-directions.md
  - docs/explanation/architecture-implementation-review.md
---

# 底层优化评估：可靠性、扩展边界与运行成本

- 提出人：3yearszhuang · 2026-09-18
- 修改人：Codex · 2026-09-18

关联：[架构事实源](../reference/ARCHITECTURE.md)、[数据库契约](../reference/DATABASE.md)、[Agent Harness Loop](../reference/agent-harness-loop.md)、[流式协议](../reference/STREAMING_PROTOCOL.md)、[插件开发规范](../reference/plugin-config-and-pages.md)、[架构实现深入评估](architecture-implementation-review.md)、[硬件能力评估](companion-hardware-directions.md)、[变更流程](../how-to/cr-workflow.md)

## 1. 结论与证据范围

当前仍有优化空间，最先值得投入的是异步任务的正确投递、插件升级的失败恢复和插件 Page 的权限边界。现有本地 SQLite、模块化单体和内部 Port 已提供合适基础；此次检查没有发现需要替换数据库、引入微服务或外部消息队列的证据。

本评估基于 2026-09-18 工作区、Git 基线 `6b20e7e` 的源代码阅读。工作区存在其它未提交变动，本次只交付评估文档。本文件第一轮 FND 结论除第 3.1、3.7 节的两项纯内存最小复现外，属于静态审阅；未运行性能基准、压力测试、真实设备试验或生产恢复演练。文中的验收数值是建议建立的目标，均不是已测结果。工作量按一位熟悉仓库的开发者估计，仅供排序，包含相应回归验证，不构成交付承诺。

第二轮深入评估见[当前架构实现与演进评估](architecture-implementation-review.md)（AVX-EXPL-012）：新增进程/数据拓扑、14 个 ARC 专题、临时 SQLite 与 Fake Provider 故障实验、架构选项和测量计划。FND 编号继续保留；跨两轮的当前实施顺序统一见根目录 [plan.md](../../plan.md)。深入评估保留实现与演进论证，并收录接单孤儿、删除虚假完成、消息原子性、模型制品和冷 CI 等新增证据。两份文档都不表示代码修复完成。

代码链接指向事实来源，行号表示本次快照中的定位辅助；后续移动代码时以所列符号为准。本文件解释问题、权衡和建议，不重新定义 API、数据库或插件契约，也不表示建议已经获批实施。

## 2. 已存在的基础与优先级

本次检查确认下列机制已经存在，后续工作应补齐其边界：

- SQLite 已启用 WAL、外键、忙等待及部分写操作退避；流事件、安全片段和工具结果已有事务、租约与 fencing 保护，安全片段已有批量落库方法。
- Worker 已按任务设置独立频率、错峰启动、避免单任务重叠并隔离任务异常；不是所有任务共享一个高频扫描周期。
- SSE 已先订阅进程内总线再重放持久事件、按序号去重、终态排空及断开注销，不再依赖高频数据库空轮询。
- Agent 已有工具超时取消、租约续期、流内检查点、恢复和上下文组合 Port；历史读取已有 20 轮、32,000 字符上限及删除过滤。
- 插件已有 Manifest 校验、路径检查、Config Schema、Secret Port、受限 iframe、CSP 和部分 Bridge 权限检查。
- 共享静态资产的跨包复制任务已经关闭 Turbo 缓存；测试已有受控并发、数据库模板克隆与增量选择。

| 编号 | 优先级 | 性质 | 建议 | 粗估 |
|---|---|---|---|---|
| FND-01 | P1 | 已复现缺陷 + 静态缺口 | 修正 Outbox 消费归属、失败重入和幂等完成 | 3～5 人日 |
| FND-02 | P1 | 静态故障路径 | 插件升级采用 staging 与可恢复激活 | 4～7 人日 |
| FND-03 | P1 | 静态权限缺口 | Page Bridge 绑定窗口身份、权限及禁用状态 | 2～4 人日 |
| FND-04 | P2 | 静态资源风险 | 插件归档限制展开资源并移出事件循环 | 2～4 人日 |
| FND-05 | P2 | 静态生命周期缺口 | 宿主轮询故障收敛与有界停机 | 2～4 人日 |
| FND-06 | P2 | 静态运行边界 | SSE 有界重放、慢客户端背压及跨进程恢复提示 | 3～5 人日 |
| FND-07 | P2 | 库级已复现缺陷 + 可选优化 | 修复会话锁回收，再测量 SQLite 写竞争 | 1～2 + 2～4 人日 |
| FND-08 | P2 | 可选优化；启用时有质量风险 | 使用完整上下文预算与保真压缩 | 3～6 人日 |
| FND-09 | P2 | 静态观测缺口 | 让已有指标可读取，区分执行与审计失败 | 2～3 人日 |
| FND-10 | P3 | 可选构建优化 | 把静态资产产物归属移到消费包 | 2～4 人日 |

P1 表示优先安排修复评审，尤其应在扩大插件安装范围前完成；P2 表示下一轮可靠性工作或对应能力推广前补齐；P3 应由测量收益决定是否投入。此处优先级不等价于已发生生产事故。

## 3. 分项评估

### 3.1 FND-01：Outbox 消费归属与失败恢复

**证据。** [通用消费者](../../apps/worker/src/outbox-worker.ts) `runOutboxCycle` 第 20～37 行读取全部 `pending` 事件，写审计后直接标记 `published`；[压缩消费者](../../apps/worker/src/compaction-marker.ts) `runCompactionMarkerCycle` 第 34～79 行同样读取 `pending`，再筛选 `memory.compaction.requested`。两者在 [Worker 组合根](../../apps/worker/src/index.ts) 独立注册，默认频率分别为 3 秒、60 秒。[Outbox 仓储](../../packages/repositories/src/repositories/sqlite/outbox-repository.ts) `markFailed` 写入 `failed`，而 `fetchPendingEvents` 只读取 `pending`；本次未找到将失败事件重新调度或转入死信的运行路径。

**触发与影响。** 通用循环先读到压缩事件时会提前完成它，后续压缩循环读不到事件，标记与对应业务审计不会生成。进程在审计成功、发布标记前退出时也可能重复写审计；瞬时失败进入 `failed` 后不会自动重试。

**已有保护。** 生产事件有唯一幂等键、队列查询有索引和批量上限，压缩标记使用幂等 upsert，Worker 的同一任务不会自重叠。这些保护不能解决两个不同消费者争用同一完成状态。

**建议与权衡。** 明确每个事件的业务处理者，将按类型分发与最终确认收敛到一个调度入口；业务完成前不得由通用审计消费者标记完成。处理成功、幂等记录与完成标记应尽量同事务提交；涉及外部副作用时使用持久意图和独立幂等键。按可重试错误、下一次执行时间和最大次数建立重入/死信机制。若同一事件需要多个独立订阅者，才评估每订阅者游标或投递记录，避免提前引入复杂发布订阅系统。

**验证。** 本次通过 `mise exec -- node --input-type=module` 导入两个 Worker 源文件，以纯内存仓储先执行通用循环、再执行压缩循环，结果为 `status=published`、`auditCount=1`、`markers=0`、`result=0`。修复验收应覆盖相反执行顺序、重复投递、两消费者并发、审计后崩溃和瞬时失败；预期每事件恰有一次业务结果，未完成事件可追踪且最终进入成功或明确死信。新增重试表字段按扩展迁移处理，修改既有投递契约先走 CR。

### 3.2 FND-02：插件升级与失败恢复

**证据。** [分发引擎](../../apps/api/src/modules/ecosystem/plugins/package-bundle.ts) `installPluginFromBundle` 第 410～412 行在覆盖时先卸载旧插件；第 477～531 行先建立主记录，随后注册配置、Page 和资源，后几步异常只记 warning 并继续返回成功。[配置服务](../../apps/api/src/modules/ecosystem/plugins/config-service.ts) `cleanupPlugin` 第 391～399 行会清除配置、Secret 和 Page 数据。

**触发与影响。** 升级过程中磁盘写满、Schema 无效或 Page 注册失败，可能同时失去旧版本配置并留下部分新版本；返回成功也不证明插件完整可用。对未来硬件插件，这会表现为设备集成升级后凭据或控制页面失效。

**已有保护。** 安装前已经进行结构预检、重复安装拦截、校验和计算与路径约束，卸载有资源清理。它们尚未构成跨数据库和文件系统的原子升级。

配置写入也有并发边界：[配置仓储](../../packages/repositories/src/repositories/sqlite/plugin-config-repository.ts) `saveConfig` 先读取 revision，再仅按 ID 更新，未用 revision 条件保护 UPDATE；并发旧版本请求可能都通过检查而互相覆盖。[配置服务](../../apps/api/src/modules/ecosystem/plugins/config-service.ts)还先写 Secret、后检查普通配置版本，发生 409 不保证 Secret 未变。现有串行过期版本测试不能证明原子 CAS。该判断来自源代码审阅，本轮未执行并发配置复现。

**建议与权衡。** 在独立 staging 目录验证全部声明、配置和资源，生成安装计划后再激活新版本；用持久安装状态记录、短数据库事务及目录切换构成可恢复流程。旧版本、配置修订与 Secret 引用保留到激活成功，配置迁移需明确而不能复用卸载清理。数据库事务内禁止进行解压和文件复制。代价是额外磁盘空间及崩溃恢复逻辑；升级/卸载语义改变需在相应 CR 中明确。

**验收。** 对预检、文件写入、注册、激活的每个失败点注入异常或进程退出；重启后只能处于完整旧版本或完整新版本，旧配置与 Secret 不因失败升级丢失。返回成功必须表示所有声明入口可读取；同一包重试安装不生成重复能力。

配置保存应使用带预期 revision 的条件更新，核对影响行数，并使同库 Secret 变更与配置在短事务内一致提交；未来外部 SecretStore 需另定义补偿策略。增加两个窗口同时提交同一 revision 的验证，预期恰有一个成功，其余返回冲突且不留下 Secret 部分写入。

### 3.3 FND-03：Page Bridge 的身份、权限与撤权

**证据。** [Page 宿主](../../packages/ui/src/components/plugin/PluginPageDialog.vue) `onMessage` 第 97～104 行校验 nonce，但未校验 `event.source` 与当前 iframe 的绑定；`handleBridgeCall` 第 60～89 行对配置读写检查 capability，`notify` 与 `close` 未做同等检查。nonce 由时间与 `Math.random()` 生成。[配置服务](../../apps/api/src/modules/ecosystem/plugins/config-service.ts) `readPageEntry` 第 370～378 行直接读取 Page，未检查插件启用状态；一般资源读取已调用 `requirePlugin` 检查存在性与启用状态，因此缺口集中在入口路径。

**触发与影响。** 同窗口存在其它 frame、Page 发生导航或插件被禁用时，Bridge 身份和生命周期可能脱节；已知 nonce 的其它消息源缺少第二道窗口身份校验。禁用后入口仍可读取，不能把“界面已隐藏”等同于执行已撤权。本次未进行利用链或端到端攻击验证。

**已有保护。** iframe sandbox、禁止直连网络的 CSP、nonce、配置读写 capability 及服务端配置校验已存在。受 sandbox 影响，消息 origin 可能为 `null`，因此不能机械要求 origin 等于普通站点 URL。

正常授权访问也需要补齐：[API 认证](../../apps/api/src/shared/auth.ts)在 Token 模式检查 Bearer 请求头，而当前 iframe URL 与页面脚本资源请求不注入该头，Page 资源会被拒绝。应设计受限的页面资源授权通道并验证 Token 模式，不能把关闭生产认证或将长期 Token 放入 URL 作为修复。

**建议与权衡。** 首先绑定 `event.source === iframe.contentWindow`，为普通源与 opaque origin 分别定义可验证策略；每次加载/切换生成加密随机 nonce，异步响应绑定发起时的 Page 会话。以显式方法表统一全部 Bridge 权限，禁用/撤权时销毁会话并让入口、资产和命令走一致门控。能力名称、兼容策略及新信任边界由插件契约/CR 冻结，不在 UI 层临时发明权限。

**验收。** 覆盖错误窗口、错误 nonce、导航后的旧响应、无权限通知、禁用后直接访问入口、禁用期间未完成调用；被拒绝调用不能产生配置写入或 UI 副作用，拒绝原因可审计。

### 3.4 FND-04：归档预检的资源配额

**证据。** [分发引擎](../../apps/api/src/modules/ecosystem/plugins/package-bundle.ts) `inspectPluginBundle` 第 76～108 行先 `unzipSync` 完整展开，再检查路径；`installPluginFromBundle` 第 415 行再次展开。[插件路由](../../apps/api/src/modules/ecosystem/plugins/routes.ts) 已设置 20 MiB HTTP body 上限，但这不是展开体积或文件数量上限。

**触发与影响。** 高压缩比或大量小文件归档即使满足上传限制，仍可能占用大量内存并同步阻塞 API 事件循环；同进程对话、心跳和设备请求会一起受影响。此项未通过压测量化。

**已有保护。** 上传体积限制、ZIP 格式检查和不安全路径拒绝已经存在。路径校验不会约束展开成本，校验和也不提供发布者签名认证。

**建议与权衡。** 在解压前读取归档目录，并在实际展开期间持续限制总字节、单文件字节、文件数、路径深度和处理时限；不能只信任归档声明大小。复用一次验证后的 staging 内容，把解压移入受控 Worker Thread/子进程或采用有界流式处理。签名信任根属于另一个准入决策，应单独冻结，不能把 SHA-256 摘要标为已验签。代价是预检流程更复杂、并发安装需限流。

**验收。** 使用高压缩比、多文件、声明大小不符、超时和正常最大包夹具；超额包在配额内终止，安装失败不改变旧插件，API 心跳仍可响应。具体配额经正常插件样本统计后确定。

### 3.5 FND-05：宿主轮询故障与停机

**证据。** [Agent Host](../../packages/host-agent/src/agent-host.ts) `tick/start/stop` 第 186～235 行使用 `setInterval(() => void tick())`，候选查询没有轮询在途锁和异常收敛；`stop` 持续等待运行数归零，没有总截止时间。[WorkerHost](../../apps/worker/src/worker-host.ts) `stop` 第 162～172 行只清定时器，不等待已开始的 Job；[Worker 入口](../../apps/worker/src/index.ts) 启动后没有相应信号停机与连接关闭流程。当前 `createAgentHost` 的直接调用主要在测试，不能据此宣称默认 API 已经由此宿主驱动。

**触发与影响。** Agent Host 被接入时，慢候选查询可能重叠，后续查询拒绝可能成为未处理 Promise 拒绝；不响应取消的 Provider 可能使停机长期等待。当前 Worker 被终止时，在途 Job 是否完成依赖操作系统终止时点。

**已有保护。** Agent 有并发槽、fencing、健康状态与 drain；Worker 已隔离 Job 异常并禁止同一 Job 重叠。原生 Loop 已有流内取消检查和工具 AbortSignal，真实模型适配也有请求超时配置；需要补的是宿主总生命周期，不能重新实现一套工具取消。

**建议与权衡。** Agent 轮询用单次在途标记或完成后再调度，捕获 source 异常并计数退避；为两个宿主统一停止接单、等待在途、截止后取消、收敛状态和关闭连接的顺序。明确 Provider 不再产出 chunk 时如何被宿主取消，停机超时不得把未知副作用自动重放。较短停机预算改善退出速度，但会增加可恢复中断。

**验收。** 模拟 source 查询超过两个周期、连续拒绝、Provider 永不结束和 SIGTERM 到达写入中途；最多一个候选查询在途，无未处理拒绝，停机在配置截止时间内结束，重启后由原有恢复/幂等机制接续。无需为此拆成新服务。

### 3.6 FND-06：SSE 的有界缓冲与持久恢复

**证据。** [SSE 路由](../../apps/api/src/modules/companion/conversation/routes.ts) 第 343～362 行忽略 `raw.write()` 的布尔返回值；第 371～438 行重放期间使用无容量上限的数组；[流事件仓储](../../packages/repositories/src/repositories/sqlite/conversation/stream-event-store.ts) `getStreamEvents` 第 92～107 行一次读取游标后的全部事件。路由第 470～481 行心跳不读取数据库；[恢复 Worker](../../apps/worker/src/attempt-recovery.ts) 在另一进程更新 Attempt，不会经过 API 的 [广播桥](../../apps/api/src/modules/companion/conversation/broadcasting-store.ts)。

**触发与影响。** 慢客户端或很长的事件重放会扩大应用/Socket 缓冲；后续独立执行宿主写入、或 Worker 恢复终态时，当前连接不能仅靠进程内广播获知状态变化。持久化数据仍可用于重连，不应把这一风险描述为所有 SSE 数据丢失。

**已有保护。** 先订阅再重放、序号去重、稳定游标查询、15 秒心跳、10 分钟连接时限及终态排空均已存在。

**建议与权衡。** 使用按序号分页的高水位重放，写入遇到背压时等待 `drain`，对单连接和全局缓冲设上限；超限慢消费者可主动断开，客户端按持久游标续传。跨进程终态优先增加受控状态通知，必要时使用低频、有界的持久水位核对；继续保留当前总线用于低延迟路径。不要恢复每连接高频空查询。跨进程通道若改变部署/信任边界需 CR。

**验收。** 覆盖限速客户端、10 万条合成事件重放、重放中断线、终态发生于另一进程和广播遗漏；连接内存受配置上限约束、重连无缺号、重复事件可去重、终态在规定窗口内可见。合成规模用于暴露边界，不代表当前用户会产生此流量。

### 3.7 FND-07：会话锁回收与 SQLite 写竞争

**证据。** [会话锁](../../packages/repositories/src/session-lock.ts) `runExclusive` 第 38～44 行把 `run.then(...)` 存进 `tails`，第 54 行却比较 `tails.get(key) === run`，两者不是同一个 Promise。本次对 100 个不同 key 依次执行空任务后，纯内存复现得到 `activeLockCount=0`、实际 `tails.size=100`。仓库搜索只发现定义和测试调用，未找到 `apps/` 生产接入，因此这是库级缺陷，不能推断它已造成当前 API 长期内存增长。

SQLite 写竞争的独立证据在 [客户端](../../packages/repositories/src/client.ts) `createDatabase` 与 [重试封装](../../packages/repositories/src/write-retry.ts) `withBusyRetry`：默认忙等待 5 秒，部分操作最多尝试 5 次；事务 BEGIN 因当前驱动状态问题明确不自动重试。进程内会话锁无论是否接入，都不能解决不同进程争用同一 SQLite 写锁。

**触发与影响。** 库调用者创建大量不同会话 key 时，表面锁计数归零而尾链 Map 保留；API、Worker 同时进行写事务时，BEGIN 忙错误仍可能暴露。实际锁竞争率、等待分位数和影响范围本次未测量。

**已有保护。** WAL、忙等待、操作级退避、短事务、fencing 和 Worker 错峰已存在；安全片段也已批量提交，不能直接把逐 token 事务当作现状。读写一致性断言继续使用写者连接，不能通过放宽测试来隐藏快照滞后。

**建议与权衡。** 先保留实际存入 Map 的尾 Promise 并以该对象进行比较回收，补充不同 key 与排队重入的资源回收验证。随后记录 BEGIN/提交耗时、忙错误次数和重试耗时，以真实竞争决定是否增加每进程写入调度、批次限额或带抖动的总等待预算。只有可证明没有提交且操作幂等时，才在重新取得安全连接/事务状态后重试整个业务操作；不得盲目重试失败 BEGIN 或带外部副作用的事务函数。全局单写者服务会改变架构，当前没有测量证据支持直接引入。

**验收。** 10,000 个不同 key 完成后真实内部尾链条目归零，同 key 顺序和异常后继续执行不变；用两个独立进程写同一临时库测量 P50/P95/P99 等待及失败率，并测试长读快照。先记录基线再设改善目标，不能承诺未经测试的吞吐倍数。

### 3.8 FND-08：完整上下文预算与保真压缩

**证据。** [历史读取](../../packages/repositories/src/repositories/sqlite/session-history.ts) 已限制 20 轮、32,000 字符，保留完整对话轮并排除删除/脱敏内容；[上下文组合根](../../apps/api/src/modules/companion/conversation/agent-executor.ts) 第 449～500 行还会加入技能、工具说明、召回和画像。[规则压缩](../../packages/agent-loop/src/context-builder.ts) `createSummaryCompaction` 第 154～168 行在超过消息数阈值后只保留首尾各两条，中间用数量说明占位，并不含中间内容摘要；该模式默认关闭，通过 `AERVOX_LOOP_COMPACTION=rule` 启用。

**触发与影响。** 较小上下文模型、大型工具 Schema 或长工具结果可能使完整 Prompt 超出模型窗口，即使历史本身已限长；启用规则压缩后，未完成目标、约束和工具对应关系可能被丢弃。消息数量和字符数都不是模型 token 预算的精确替代。

**已有保护。** 历史上限、安全过滤、按 Turn 缓存历史查询、压缩 Port 和上下文快照已经存在；无需重新建立上下文基础设施。

**建议与权衡。** 在最终组装后按 Provider 窗口预留输出预算，覆盖 system、技能、工具 Schema、召回、历史与在途工具消息；工具调用/结果成组保留，根约束与未完成事项不可随意删除。规则模式应准确标记为裁剪，或替换成有来源水位和验收的摘要；模型摘要额外增加延迟与成本，先采用可解释的整轮选择。新摘要必须继续受删除/撤权水位保护。

**验收。** 对长中文、代码、大型 Schema、工具多轮和删除后再召回建立固定回放；最终输入不超窗口，工具消息结构合法，最近目标与关键约束可追溯，压缩前后按任务完成率和上下文成本比较，而非只验证消息条数减少。

### 3.9 FND-09：让已有观测能支持决策

**证据。** [SQLite 观测门面](../../packages/host-agent/src/sqlite-observability.ts) `createSqliteObservability` 第 65～74 行将 metrics 存入最多 10,000 条的内部数组，`flush` 为空，返回接口未提供读取这些样本的路径；审计插入失败在第 90～92 行输出错误后返回。[WorkerHost](../../apps/worker/src/worker-host.ts) 只在处理数量大于零时记录完成日志，跳过重叠周期直接返回。这些是具体实现的限制，不能推断整个仓库没有任何指标或日志。

第二轮确认 [API 组合根](../../apps/api/src/app.ts)已通过独立的 Metrics Registry 提供受认证的 `/v1/metrics`，支持 JSON 与 Prometheus；本项缺口仅限定于 Host 专用观测实现和未覆盖的运行信号。建议复用 API 已有注册表与导出能力，并核对 Worker/Host 是否实际接入，不另建重复端点。

**触发与影响。** 设备长期运行时，很难区分“没有工作”“一直跳过”“写竞争”“审计落库失败”；内存中样本存在也不等于运维或性能检查能使用它们。

**已有保护。** 日志、Metrics/Audit Port、Agent 健康检查及审计持久化已经存在；日志不应包含完整 Prompt、凭据或私密画像。

**建议与权衡。** 使用有界聚合器维护计数、直方图和最近错误，并通过受限本地诊断或脱敏诊断包读取；复用现有 Port，先不部署外部监控系统。补充队列最老事件年龄、Job 跳过数、忙等待、SSE 缓冲、上下文裁剪、审计失败等指标。指标可丢样，关键授权/副作用审计的失败策略则应依既有契约分别处理，不统一吞错或统一阻断。

**验收。** 人工注入一次队列积压、数据库忙、审计失败和慢连接，诊断数据能明确指出受影响路径；清空队列后相应 gauge 恢复。诊断输出不含用户正文、Secret 或设备敏感原始数据，存储容量长期有界。

### 3.10 FND-10：静态资产与构建缓存的产物归属

**证据。** [Turbo 配置](../../turbo.json) 对 `@aervox/live2d#build`、`@aervox/public#build` 和移动端构建明确设置 `cache: false`。[Live2D 复制脚本](../../packages/live2d/scripts/copy-assets.mjs) 与 [公共资源复制脚本](../../packages/public/scripts/copy-assets.mjs) 从依赖包直接写入消费端目录，因此普通包内 `outputs` 不能完整表达其副作用。

**触发与影响。** 重复构建会重复复制资源；随着模型和多端资源增长可能增加 I/O。当前关闭缓存已保护正确性，本次没有测量这部分耗时，也未发现需要立即开启缓存的依据。

**建议与权衡。** 若冷/热构建统计显示复制占比显著，可让资源包只生成自身确定性产物，消费包在自己的构建生命周期复制到自有输出，或使用可追踪输入的打包资源导入。内容哈希避免无变化复制；迁移成本包括开发模式资源路径和打包兼容。保持受控测试并发及模板克隆，不要为追求表面 CI 速度扩大 SQLite 测试并发。

**验收。** 分别测量冷构建、热构建和更改单个资源的构建时间；删除消费端产物后，仅依赖可用缓存也能恢复完整资源；修改源资源能正确失效缓存。完成这些验证前继续保留现有 `cache: false`。

## 4. 建议实施顺序与决策边界

当前批次、依赖与认领统一维护在根目录 [plan.md](../../plan.md)。本文件 FND 优先级是评估时的风险分级，保留用于解释证据，不构成另一份活动队列。运行稳定性与性能实验的负载设计见[架构深入评估 §7](architecture-implementation-review.md#7-如何测量优化是否值得)。

硬件立项还需先做 Provider 真实性验证：[本地 GPT-SoVITS](../../apps/api/src/modules/platform/voice/gpt-sovits.ts) `GptSovitsLocalProvider.synthesize` 当前返回文本编码的占位字节却标为 `audio/wav`，路径健康检查不能证明真实合成成功；[OCR 默认解析器](../../apps/api/src/modules/knowledge/content/parser-port.ts) `MockOcrParserProvider` 返回随机置信度及固定题文，不能支撑扫描硬件的真实识别验收。应把这两条对应硬件路线的验证列为 P1：真实解码器可播放的合成产物、固定实物输入对应的 OCR 输出，以及显式区分 Mock/未配置/真实可用的健康状态。远程 TTS 适配和真实 ASR 属于其它 Provider，应按各自实现与实测评价，不能由这两项推断语音整体未实现。

建议不包含更换 SQLite、恢复多用户隔离、拆微服务或引入独立队列。涉及插件激活/权限语义、新进程信任边界、Outbox 多订阅契约或数据库模型的改动，先按 [CR 工作流](../how-to/cr-workflow.md)冻结差量。任何破坏性数据库迁移继续遵循[换库与回滚演练](../how-to/run-database-migration-drill.md)的停写、备份、显式范围选择、staging 校验、原子换库与保留回滚包流程。

每项采纳后分别登记代码落位、验证和发布门禁；本文件完成的是评估交付，不代替[追踪基线](../reference/REQUIREMENTS_TRACEABILITY.md)中的实现或发布验收。
