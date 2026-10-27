# Aervox 当前迭代计划

本文件是唯一协调队列，按风险、依赖和当前产品价值排序；编号不随排序改变。维护规则见[贡献指南](CONTRIBUTING.md#plan-maintenance)及[唯一变更编号](CONTRIBUTING.md#change-numbering)。需求与发布状态仍以[追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)为准，已移交只代表对应切片。维护者已要求持续推进整个计划；按依赖执行已有合同下的实现与验证，待定产品路线、ADR 差量、真实环境、用户业务库迁移和发布仍须分别满足各条目的前置，不以单项绿测代替整体完成。

## 1. 当前判断与执行顺序

2026-10-26 核对：PR #326/#327/#328/#330/#331/#332/#333 已经审查合入，已核对主线 `f94ebfd6`。共享传输、Attempt、领域事务、Conversation Port、Page 登记代际、LLM/CLI、长期消息及历史分页已有交付，但**ITER-071 尚未完全实现设计**。当前 Android M0 沿该主线的分支接续固定 SQLite、唯一 Schema、原生凭据和中性仓储前置，历史 API/CLI/工作台接续修正也已随主线同步；其余未闭合事项仍按下列风险与依赖推进，不能以包边界成立视为行为已经统一。

| 顺序 | 当前目标 | 对应条目与进入下一阶段的条件 |
|---|---|---|
| 立即 | 交付 Page 配置、资源读取身份及宿主资格观察，继续验收行为缺口 | [ITER-071](#iter-071) 前两批及再审计由 PR #323/#324 合并；[PR #326](https://github.com/3yearsZhuang/Aervox-harness/pull/326) 已合入 GET/reset 身份、资源 I/O 前后复验及静默 Page 观察；剩余资源通道/实时撤权归 [ITER-006](#iter-006) |
| 接续，可按依赖并行 | 闭合删除、撤权、安全恢复及在线运行门槛 | [ITER-003](#iter-003)/[006](#iter-006)/[010](#iter-010)/[011](#iter-011)/[013](#iter-013)；插件升级只推进 [ITER-005](#iter-005) 的必要安全切片。恢复不能先于 deny 账本和水位，性能优化不能先于资源有界 |
| 核心产品交付 | 证明现有个人助手、学习和会话入口真实可用 | 先收敛本机路径的 [ITER-064](#iter-064)、[033](#iter-033)、[029](#iter-029)、[第一方界面](#iter-053)；[015](#iter-015) 必要部署与 [062](#iter-062) 连接验证可并行，Bot 独立运行/恢复在主管能力后验收；再做 [032](#iter-032)/[012](#iter-012) 长会话及索引，[026](#iter-026) 有限评审 |
| 按测量投入 | 消除真实瓶颈和维护成本 | [ITER-017](#iter-017)/[027](#iter-027)/[040](#iter-040)；先固定设备、数据和质量基线，再决定优化或停止，不承诺未测收益 |
| 条件成立后启动 | 扩端、开放生态及研究 | [ITER-009](#iter-009)/[016](#iter-016)/[018](#iter-018)/[028](#iter-028)、[019](#iter-019)/[056](#iter-056)、[021](#iter-021)→[022](#iter-022)→[043](#iter-043)；保留决策与环境前置，不挤占当前正确性和产品闭环 |

同一缺口只在对应 ITER 维护；上表用于导航。已有切片、未完成设计、外部环境验收和正式发布分别陈述；不设未经确认的日期、平台顺序或采购承诺。

**本轮接续验证：** `fix/plan-safety-contract-continuation` 的新 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及守卫、OpenAPI 兼容、HLS、删除故障、Native Search/Runtime 与 64 份文档门禁通过；API 947、仓储 742、Worker 161、Host Runtime 306、Core 501、Host Agent 121、客户端 218、Panels 157、工作台 11 项通过，1 项既有真实模型跳过保留、不计通过。相关 Chromium 3 项和依赖审计另验通过（0 未审阅、2 既有审阅路径、0 过时例外）。全量先捕获 OpenAPI 预算，再捕获工作台旧简化插件夹具造成的 8 项失败；分别通过组件复用和完整响应夹具修复，重新全量通过。随后仅补验证记录并复验文档，新提交远端结果由接续 PR 保存；负载演练的 NOT CLEAN、真实环境及全计划未闭合项仍按各条保留。

## 2. 立即整改：ITER-071

<a id="iter-071"></a>

### ITER-071 · 执行中，部分实施：共享行为所有权与重复实现整改

维护者已批准 [ADR-030](docs/reference/adr/ADR-030-behavior-ownership.md) 和六批整改方案。工作分支 `feat/decoupling-implementation`，已交付 [PR #323](https://github.com/3yearsZhuang/Aervox-harness/pull/323)，主线合并提交为 `5ecd8365`。审计基线为 `0ebccd20611aa609b2b7609241d98011109a8982`，首次自查对象为 `7abd4fbb6825e06c4e967ccd72a4ad3f185ec402`，后续修复按精确验证证据追踪。此前“消费者均已迁移、完整统一”的表述撤回，以以下剩余验收为准。

#### 2026-10-24 再审计整改

本轮获维护者授权修复完整审计中的 16 项，工作分支 `fix/decoupling-audit-remediation`，从 `5ecd8365` 隔离实施。沿用本条及 ADR-030，不新增执行队列；迁移、跨重启完整恢复、全链删除与发布仍由原责任条目验收。

- Hook 写事务代际/Attempt/fencing、`done` 前有界增强、领取前原子取消；HTTP 适配迁为应用命令/查询，执行期配置改为显式快照，委托按原始持久 owner 复验。
- 复习在事务内复用唯一派生政策，报告按真实回执投影；画像候选与恢复按 capture 精确查询，移除 Worker 对表和全局最新窗口的依赖。
- 子任务 Turn/Attempt/run 原子受理、同键意图校验和模型初始化失败终态；领取前取消、终态摘要写失败后按权威 Attempt 对账且不重跑模型，Interrupted 不再误报 Failed；旧无摘要孤儿明确拒绝，不猜测恢复。
- 共享插件配置 editor、client 实例与会话资源 generation、宿主 surface 导航及窄主题出口；保留既有布局与独立桌宠默认会话语义。
- MCP/Voice 由 Schema 派生类型并校验响应；语音新建/激活使用实际标识回执，列表空白输出为 null，修正两处历史 OpenAPI 文档误报。模型 catalog 取自宿主，目录失败可见且可重试，不丢失既有配置/草稿；分层依赖图与明确 DTO 守卫补强，移除非必要运行时环。

**本地验证：** 最终产品与脚本的 `./aervox ci all` 退出 0，构建 32、类型检查 56 个任务通过；API 815、仓储 573、Worker 153、Core 494、Host Runtime 273、Host Agent 113 项通过，Host Agent 2 项既有真实模型/参考库构建跳过保留，不计通过。前端、守卫、HLS、删除故障、Native 及 64 份文档门禁通过；额外 CLI 持久化/API 重启与审批集成 2 项通过。随后只补本条记录并复验文档，远端仍以 PR 精确提交为准，不宣称 ITER-071 或发布整体完成。

**剩余边界：** 旧复习缺回执返回 409、旧报告缺可证回执返回 await_review；全部主动写者撤权竞态、来源撤权再授权的代际绑定和跨进程自动接管仍不在本轮完成声明内。完整文件图的类型依赖 SCC 保留并明确报告，仅精确登记且验证惰性的 Schema 外键运行时环获准，不以目录图无环代替行为解耦验收。

#### PR #324 接续实施

沿用 `fix/decoupling-audit-remediation`，接续 `6701ac3c` 后中断的实施，交付见 [PR #324](https://github.com/3yearsZhuang/Aervox-harness/pull/324)。

- **共享终态与执行快照：** 接单准备、Native 和 Adapter 的取消、删除、预算及失败由 Core 终态所有者裁决，原子事件携带实际序号；丢租约及 CAS 失配不写终态。子任务收口先复读权威 Attempt，终态提交失败时保持真实 Running，不重跑模型；DSH 领取交接期间取消由原准备 owner 终结。主执行、子任务与恢复共用隔离的配置快照，DSH/stdio 环境必须由组合根显式注入；旧会话装配工厂重导出已移除。
- **单捕获批次发布：** 全部观察、claim、捕获标记和不含正文的回执在一个写者事务提交，绑定有效输入摘要、处理器版本和输出顺序。同参重试复用、异参冲突；历史无回执部分结果明确拒绝。手工完成验证真实来源关联且不能覆盖已发布批次；失败状态与安全错误码审计同事务，删除、撤权、暂停及完成后的迟到失败不回写。不清洗历史旧版错误正文，不扩大为全主动写者或 deny/lease/代际验收。
- **人格与项目契约：** 人格路由、客户端和 OpenAPI 共用 Schema；导入的受控嵌套字段在安装技能及创建人格前校验，保留历史 nullable checksum 回执。人格弹窗隔离旧加载/保存结果，并保留同模型的语音 settings；项目列表与写回先验响应再投影，旧读取不覆盖写入。防回退守卫精确覆盖已迁移的人格 alias，MCP/Voice 既有严格规则保持。
- **验证差异：** 新增子任务丢租约、终态 CAS/提交失败与 DSH 交接取消回归均先红后绿；仓储 604 项通过，浏览器全套 18 项通过。`6701ac3c` 的远端主代码、CLI、API E2E、依赖与 Docs 已成功，Chromium 虽标为取消但日志实际有 1 项旧界面名称断言失败，已对齐宿主清单并复验。新全量先后发现人格导入 nullable checksum 的 OpenAPI 登记滞后、旧客户端隔离夹具使用 `title` 而非 `name`，以及准备删除仍要求空 Assistant 身份的旧事件断言；已按真实契约修正，并加强创建成功及零产出/终态序号验证，未放宽门禁。
- **最终本地全量：** `./aervox ci all` 退出 0；API 819、仓储 604、Worker 156、Core 494、Host Runtime 287、Host Agent 120、客户端 170、Panels 90 项通过，Host Agent 2 项既有真实模型/参考库构建跳过保留，不计通过。构建、类型、守卫、HLS、删除故障验证、Native Search/Runtime 及 64 份文档门禁通过。依赖审计 0 未审阅、2 既有审阅路径、0 过时例外；浏览器 18 项、打包 CLI 持久化/API 重启与工具审批集成 2 项另验通过。提交前仅补本条记录并复验文档；精确提交远端结果由 PR 保存，不代表 ITER-071 整体完成或正式发布。

#### P1：首批已验证，新发现的接单缺口已修

- **静态 privileged 工具的管理员审批漏检已修。** 原[HTTP 路由](packages/host-runtime/src/modules/companion/conversation/routes.ts)只查动态列表，隔离真实路由探针曾复现无管理员批准并执行。现在审批与派发使用同一 ToolBinding 身份，持久安全等级、owner、generation、revision；静态、动态、插件均执行管理员门禁。插件在审批事务内再次检查代际/启用/可用状态，预检后撤权不写批准、不创建续跑 Attempt；保留参数哈希兼容，不扩大免审批。真实 Core→HTTP→Core 及三种撤权竞态已进入回归。
- **HTTP/插件作答原子命令已统一。** 原[学习路由](packages/host-runtime/src/modules/learning/learning/routes.ts)分步写入，排期失败后同键重试曾虚报 `review_scheduled` 且无复习。现在一个应用策略和写者事务提交事实、掌握度、复习、Outbox 回执，插件由真实 Turn 解析 session/source；旧独立写入口已删除。同键异参 409，重试返回原 nextStep；无知识关联或不可判定时为 `await_review`，仅实际排期才返回 `review_scheduled`。旧事实无完整事务回执时返回 `answer_receipt_unavailable`，不猜测补造；逐步故障、并发、来源/代际及删除顺序纳入隔离回归。

- **Turn 幂等请求已补意图摘要复验。** 原[HTTP 创建路由](packages/host-runtime/src/modules/companion/conversation/routes.ts)提前按键返回原 Turn，[接单事务](packages/repositories/src/repositories/sqlite/conversation/turn-store.ts)只验证 session/policy；隔离探针确认异正文会误认成重试。现在唯一域函数规范化有效意图，在 Inbox 合并前计算版本化 SHA-256，写者事务原子绑定已有 `request_hash`。同键同参复用、异参或跨 Session 409；旧 NULL 摘要/丢失或不符回执明确拒绝，不猜测回填。Worker/Bot 经 ConversationApplication 的执行入口恢复受理时的 metadata/审批模式/可信 actor，调用方不能覆盖；完整 HTTP 审批续跑随后在本轮迁入应用命令。新增 HTTP/应用及 Bot/Worker 回归已定向通过；不修改 Schema/release；子任务 `createTurnWithAttempt` 与父执行键复用在本轮另补原子受理、意图校验及初始化失败回归。现有首输入软删/redaction执行资格仍归 ITER-003，不能以摘要一致替代删除门禁。

#### PR #324 · 配置代际与诊断最小化接续

按本次接续指令继续在 `fix/decoupling-audit-remediation` 实施既有合同下的正确性修复，跨域行为归本条；剩余隐私和 Page 验收仍分别归 ITER-003/006。

- **配置写入与 Page 代际：** 保存和重置在写事务内联合复验 enabled、availability、lifecycleGeneration、Schema 内容/版本和 revision，阻断预检后停用、缺包、重新启用及并行修改。Page 捕获打开时代际，配置请求携带 `expectedLifecycleGeneration`，读取返回前也复验；同 ID 换代销毁旧 iframe、Nonce 和在途响应。普通客户端省略参数仍兼容，不新增 Token 通道或修改资源认证。
- **ContextManifest 新写最小化：** 仓储对白名单形态投影，仅持久消息/角色/工具计数和合法生成参数；正文、推理、工具参数/结果/描述/Schema、扩展字段与内容 hash 不落库，未知快照为 null。Core 保留进程内快照及工具安全诊断；ModelRun/Manifest 关联和尽力而为语义不变，不新增 Schema 或控制账本。
- **范围和反例：** 配置竞态、Page 旧代际和 Manifest 正文复制均先红后修。历史 Manifest 正文不自动清洗，来源传播与授权修订、全主动写者、全 capability 跨窗口推送和 Token 资源通道仍未闭合；真实模型/平台、业务数据迁移和发布单独验收。新提交验证结果由本条及 PR 记录，不沿用上一提交绿测。
- **本地验证：** 新 `./aervox ci all` 退出 0，构建 32、类型 56 个任务通过；API 837、仓储 633、Host Runtime 290、Worker 156、Core 494、Host Agent 120、客户端 173、Panels 94 项通过，Host Agent 2 项既有真实模型/参考库构建跳过保留，不计通过。守卫、HLS、删除故障、Native Search/Runtime 和 64 份文档门禁通过；依赖审计 0 未审阅、2 既有审阅路径、0 过时例外。浏览器全套 19 项通过，包含新增[真实 Chromium Page 回归](e2e/ui/plugin-page-lifecycle.spec.ts)：旧 iframe 在外部停用再启用后仍连接，但 Bridge 配置读写均 409 且不改变配置，宿主刷新后新代际成功读写并持久化。该测试使用临时 SQLite、真实 API/Bridge 与 Web 设置入口，不证明 Electron、Token 资源或全 capability 撤权；提交前仅补本条记录并复验文档，精确提交的远端结果仍由 PR 保存。

#### PR #324 · 首输入资格与逐帧删除接续

- **受理恢复与执行：** 固定读取 User version 1，并在同一 SQL 快照检查正文及软删/脱敏资格；缺失或不可用时不从后续版本、调用方或 Outbox 正文恢复。准备、模型请求及工具检查点复验首输入存在且未软删，复用现有生命周期和终态提交；资格检查只读取最小身份，不重复物化完整输入。
- **在线 SSE：** 窄查询在同一 SQL 快照验证 Session/Turn、策略与派发一致、首版输入存在及同 Turn 现存消息身份未软删。建流不可用统一 404；每帧重新读取当前持久事件，删除后丢弃背压页缓存，空闲轮询也关闭观察，不取消 Turn、不造终态。原历史读取接口不改变，来源恢复依当前状态判断，未引入撤权代际。
- **范围调整：** `isRedacted` 也用于隔离固定危机求助回复的记忆用途，一律当作删除会破坏 CAP-008。受理恢复仍拒绝已脱敏输入；运行中及 SSE 的完整脱敏披露和 grant 修订须与受信固定回复一起验收，本轮不建立新权限例外。全部持久写者、历史正文/Outbox/派生清理、已物理删除的非首输入来源关联仍未闭合；查询完成至网络或后续写入仍有并发窗口，不宣称原子撤权或全链删除完成。
- **反例与验证：** 已复现首输入删除后仍可执行、后续版本回落和独立 SQLite 进程删除后缓存页继续披露。回归覆盖准备、工具前、下一模型 Step、原子来源/事件读取、空闲轮询、查询中断连、读取失败以及固定求助回复；真实 HTTP 删除后批准返回 409，审批/Attempt/事件/工具/ModelRun 保持原状态。新的 `./aervox ci all` 退出 0，API 840、仓储 655、Host Runtime 306 项通过；构建 32、类型 56 个任务及守卫、HLS、删除故障验证、Native Search/Runtime、64 份文档门禁通过。Host Agent 120 项通过、2 项既有真实模型/参考库构建跳过保留，不计通过。提交前仅补本条记录并复验文档，精确提交远端结果由 PR 保存，不沿用上一提交或宣称整体完成。
- **依赖门禁差异：** `5bb1e405` 的远端依赖审计新命中 [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)，Zod 4.4.3 的集合验证可耗尽内存，37 条路径未审阅；本地复现。按公告修复范围将三处直接依赖统一升级至 4.6.7，根安装更新锁文件，研究依赖的 peer 路径同步收敛；未增豁免或降低门禁。升级后依赖审计为 0 未审阅、2 既有审阅路径、0 过时例外；新的 `./aervox ci all` 再次退出 0，构建、类型、OpenAPI 兼容、全量测试和文档均通过，API/仓储/Host Runtime 数量同上，2 项既有跳过保留。打包 CLI 持久化/API 重启与工具审批集成 2 项另验通过。随后仅补验证记录并复验文档，精确提交远端仍由 PR 保存，不将旧提交的文档/API/UI 成功等同新提交全部通过。

#### PR #324 · Page 全方法调用资格接续

- **调用时复验：** 配置读取、保存、通知与关闭均携带打开代际查询当前 Page；同一 SQL 快照读取 enabled、availability、lifecycleGeneration 及 capability，拒绝旧代际、缺失 Page 或能力移除。配置返回前再复验，文档/窗口轮换后丢弃迟到授权结果；沿用已有配置事务，不新增 Token 通道或权限例外。
- **合同与反例：** Page GET 纳入共享端点声明并校验 query/response，响应 `no-store`；保留实际已有的 nullable description/checksum，仅在历史兼容勘误中逐字段登记，不改兼容基线。新增组件回归先复现 11 项失败；修复后组件 42、仓储 12、客户端 6、API/路由覆盖 36 项定向通过。真实 Chromium Page 回归证明旧 frame 保持连接时四种调用被拒、零配置请求/通知/关闭副作用，宿主刷新后的新代际可操作。
- **剩余边界：** 调用时复验不等于实时推送、资源代际绑定或代码强制终止；SQL 至客户端动作、Page capability 移除至配置事务仍有并发窗口。全链来源传播、持久写者及恢复控制面保持原责任条目，精确提交全量和远端证据随 PR 更新，不宣称 ITER-071/006 整体完成。
- **验证差异：** 首次完整 Chromium 为 18 项通过、1 项同 URL 响应体读取失败；改为直接断言真实 HTTP 状态及 SDK 结构化拒绝后，完整 19 项通过，未重试或放宽行为期待。首次全量另捕获旧错误脱敏夹具只注入五个配置方法、却遍历新增 Page 描述符的 1 项失败；补 Page 方法故障注入及畸形 capability 成功响应拒绝，6 项 HTTP 合同通过，再运行新的全量门禁。
- **最终本地全量：** 新的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及守卫、OpenAPI 兼容、HLS、删除故障验证、Native Search/Runtime、64 份文档门禁通过。API 845、仓储 661、Host Runtime 306、Worker 156、Core 494、Host Agent 120、客户端 174、Panels 107 项通过；Host Agent 2 项既有真实模型/参考库构建跳过保留，不计通过。独立依赖审计为 0 未审阅、2 既有审阅路径、0 过时例外。提交前仅补本条验证记录并复验文档，精确提交远端证据由 PR 保存。

#### PR #324 · Page 保存事务资格接续

- **提交门禁：** Bridge 从当前会话注入 `expectedPageId` 与打开代际，插件参数不能覆盖；共享请求 Schema 要求 Page ID 有效且伴随显式代际。路由、服务及仓储贯通身份，保存事务在任何配置或 Secret 变更前验证同插件/Page 当前 `config.write`；Page 缺失、能力移除或畸形能力均拒绝。沿用现有物理 Schema 和管理认证，不新增权限通道。
- **反例与边界：** 旧实现仓储 11 项、API 12 项、组件 5 项、客户端 6 项先红；修复后仓储 31、API 39、相关组件 43、客户端 13 项通过。覆盖预检后撤权、他插件同 Page ID、只读/畸形能力和伪造 Bridge 参数，拒绝时配置、Secret、审计不变。普通 HTTP 管理调用可以省略 Page 身份；已提交保存保留真实回执，旧 Page 仍在返回前复验。GET/reset、同代际 Page 删除再建/撤权再授权的修订、SQL 至客户端动作、实时撤权与资源通道仍待原条目验收。
- **浏览器验证：** 实际 Chromium 暂停 Bridge 预检后的 PUT，再由独立 API 客户端移除 `config.write`，验证同插件代际不变、旧 iframe 仍连接时保存 409 且配置不变；完整浏览器 19 项通过，无重试。
- **依赖审计差异：** 本轮新命中高危 [GHSA-jr5w-w6x2-84p9](https://github.com/advisories/GHSA-jr5w-w6x2-84p9)，Electron `43.7.9` 在受影响范围；同主版本修复从 `43.8.1` 起。根工作区更新依赖和锁文件至 `43.8.3`，不新增豁免或放宽门禁；本轮首次审计失败证据保留。完整本地及精确提交远端门禁随本切片继续更新，不沿用上一提交绿测或宣称 ITER-071/006 整体完成。
- **最终本地全量：** 新 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及守卫、OpenAPI 兼容、HLS、删除故障验证、Native Search/Runtime、64 份文档门禁通过。API 861、仓储 674、Host Runtime 306、Worker 156、Core 494、Host Agent 120、客户端 181、Panels 108、桌面 156 项通过；Host Agent 2 项既有真实模型/参考库构建跳过保留，不计通过。依赖审计为 0 未审阅、2 既有审阅路径、0 过时例外；打包 CLI 持久化/API 重启及工具审批集成 2 项、桌面传输合同 16 项另验通过。提交前仅补验证记录并复验文档；新 Electron 实际 IPC 和精确提交远端结果由 PR 保存，仍不代表完整平台或发布验收。

#### PR #324 · Page 登记代际接续

- **身份与提交：** 每次 Page 登记（包括相同声明）、资源 checksum 更新及删除再建使用新的持久 UUID；复用现有行身份，不修改物理 Schema。响应独有 `pageGeneration`，作者声明不能指定；Bridge 捕获该身份，四种调用及配置返回前逐次核对，宿主观察到 Page 换代时更换 iframe 与 Nonce。保存由宿主注入 `expectedPageGeneration`，与 Page ID 成对并需插件代际，写事务联合比对身份与当前 `config.write`；插件同代际撤权再授权不能复活旧会话。
- **资源写者：** 原上传先读取旧声明再 upsert，可能覆盖并行撤权。现改为按捕获 Page 身份的单条 checksum CAS，只更新摘要并换代；变化或删除返回 409，不复制旧 capability 或重建已删 Page。文件先于 SQL 更新，已写资源不因 409 回滚，完整资源原子发布仍待验收。
- **反例与验证：** 仓储 14、资源摘要 CAS 8、组件 12、共享契约 17、客户端 16 项先红；修复后相关定向通过，覆盖同声明登记、撤权再授权、删除再建、并发登记、返回前换代、伪造 Bridge 身份、SQLite 重开及安装进程崩溃。首次仓储全量两项既有 30 秒超时保留，相关与超时文件重验通过，未调阈值；完整本地、实际 Chromium 和精确提交远端证据随本切片更新。
- **依赖审计差异：** 本轮独立审计新命中 undici、fast-uri 和 happy-dom 共 8 个公告、113 条未审阅路径，首次失败保留。undici 6/7 系分别修至 6.29.1/7.30.1，fast-uri 3/4 系分别修至 3.1.9/4.2.3，沿用精确受影响版本覆写；[happy-dom 公告](https://github.com/advisories/GHSA-834v-8h66-3h79)无 20 系修复，根依赖升至 21.0.4，保持其默认关闭 CSS/iframe 网络加载，不新增开关或审计豁免。根安装后重新验证，不沿用升级前全量结果。
- **最终本地全量：** 依赖升级后新的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及守卫、OpenAPI 兼容、HLS、删除故障、Native Search/Runtime 和 64 份文档门禁通过；API 873、仓储 696、Host Runtime 306、Worker 156、Core 494、Host Agent 120、客户端 196、Panels 120、桌面 156 项通过，Host Agent 2 项既有跳过保留、不计通过。独立审计为 0 未审阅、2 既有审阅路径、0 过时例外；打包 CLI 集成 2、实际 Electron IPC 7 项另验通过。真实 Chromium 保持旧 iframe 连接，恢复 capability 后四种调用仍拒绝，预检后撤权再授权的 PUT 返回 409 且配置不变；宿主刷新后新 Page 可操作。随后仅补验证记录并复验文档，完整浏览器及精确提交远端结果由 PR 保存。
- **剩余边界：** GET/reset 未扩 Page HTTP 身份，SQL 至客户端动作、跨窗口实时撤权、资源代际绑定和 Token 通道继续归 ITER-006；全链删除与恢复归原条目，不宣称 ITER-071/006 整体完成。

#### Page 配置 GET/reset 身份接续

从已合并主线 `29db872c` 在 `fix/page-config-read-reset-identity` 接续，交付见 [PR #326](https://github.com/3yearsZhuang/Aervox-harness/pull/326)；沿用 ADR-030 与本条，不新增执行队列。

- **契约与宿主：** GET/reset 共用 Page 身份 query，Page ID 与 Page 代际必须成对并显式绑定插件代际；Bridge GET 注入打开时捕获身份，插件参数不能覆盖。不新增 Bridge 方法，管理调用省略 Page 身份保持兼容。
- **读取与提交：** Page GET 同 SQL 快照核对当前插件/Page 身份、`config.read` 与配置，返回前再复验；资格失败不回落别名或默认值。reset 在删除 Secret 或改配置前，于同一写事务核对当前 Page 代际及 `config.write`；拒绝不改配置、Secret 或审计，已提交重置保留真实回执。
- **定向验证：** 仓储 16 个拒绝反例、共享 query 16 项和 Bridge 身份 4 项先红后绿；仓储 2 文件 82 项、API 3 文件 95 项、Contracts 全套 100 项、客户端配置 32 项、Page 组件 2 文件 56 项及相关类型检查通过。真实 Chromium 在预检后暂停 GET，独立客户端撤权再授权后返回 409 且无配置正文，旧身份 reset 不改配置，新 Page 可成功重置。首次浏览器运行因本机旧 Vault 的 Schema 被拒而未进入测试；显式注入独立临时 Vault、密钥与访问凭据路径后通过，不修改或迁移现有数据。独立源码复核未发现阻断项，整体验证与新提交远端证据继续记录。
- **本地全量：** 新的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及守卫、OpenAPI 兼容、HLS、删除故障、Native Search/Runtime 和 64 份文档门禁通过；API 900、仓储 714、Host Runtime 306、Worker 156、Core 494、Host Agent 121、客户端 200、Panels 121 项通过。Host Agent 1 项既有跳过保留，不计通过；参考库构建产物加载本次实际运行通过。独立依赖审计为 0 未审阅、2 既有审阅路径、0 过时例外。随后仅补本条验证记录并复验文档，精确提交远端结果由 PR 保存，不沿用 PR #324 绿测或宣称整体完成。
- **剩余边界：** SQL 返回至网络/客户端动作、跨窗口实时撤权、资源代际绑定、完整资源原子发布与 Token 通道继续归 ITER-006；全链删除与恢复归原条目。本切片不宣称 ITER-071/006 整体完成。

#### Page 资源读取资格接续

按维护者本次指令在 `fix/page-config-read-reset-identity` 与 PR #326 继续，沿用本条及 ADR-030，不新增执行队列。

- **反例与实现：** 原入口 HTML 和普通资源仅在文件 I/O 前检查插件及 Page，未检查可用性，读取后直接释放字节。现以同一 SQL 快照捕获当前插件启用、可用性、生命周期、Bundle 指针及同插件 Page 的身份/入口；文件读取后再比对，失配返回 `409 PLUGIN_PAGE_REVISION_CONFLICT` 且不释放已读内容。入口别名、嵌套资源路径与链接边界保持，不跨 I/O 持有写事务。
- **定向验证：** 新增真实文件与 HTTP 资源回归 32 项，旧实现 26 项失败；24 项读后撤权/换代原本返回 200，2 项初始缺包也放行。修复后 API 5 文件 127 项、仓储配置 25 项及 BundleStore 23 项通过；单 SQL 快照验证同插件/Page 归属，入口别名与嵌套 JS 均在实际读出 canary 后改变持久状态，确认 409 且无正文。构建 20 个任务通过，独立依赖审计为 0 未审阅、2 既有审阅路径、0 过时例外；新全量和精确提交远端结果另验。
- **本地全量：** 本轮新的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及守卫、OpenAPI 兼容、HLS、删除故障、Native Search/Runtime 和 64 份文档门禁通过；API 932、仓储 717、Host Runtime 306、Worker 156、Core 494、Host Agent 121 项通过，1 项既有真实模型跳过保留、不计通过。独立审查未发现阻断项；随后仅补本条记录并复验文档，原分支新提交及 PR 精确远端检查单独核对，不沿用配置切片绿测。
- **剩余边界：** 不改变 Token、资源 URL、物理 Schema 或上传发布机制；iframe 打开时代际与后续资源请求的绑定、完整资源原子发布、最终 SQL 至网络发送、静默 Page 的跨窗口实时撤权仍由 ITER-006 验收。旧 `fc30dc3a` 绿测不能覆盖本次修订，定向、全量及新提交远端证据随本切片更新。

#### 静默 Page 资格观察与显式重开接续

按维护者指令继续在 `fix/page-config-read-reset-identity` 与 PR #326 推进；沿用本条、ADR-030 和现有 Page 查询，不新增服务端通道、Token 或物理 Schema。

- **实现与所有权：** 挂载前及每次文档 load 复验捕获的插件/Page 身份、入口与 capability；运行期间每次观察完成后等待 2 秒再串行查询，focus/恢复可见时立即复验，单次本地等待上限 5 秒。错误、超时或失配移除 iframe，取消观察与文档等待、释放 Nonce/监听器/计时器并锁定旧选择；查询迟到、同 ID props 更新及后续恢复授权均不复活旧文档。四种 Bridge 仍逐调用复验，不消费观察缓存。
- **显式重开：** 插件管理与设置入口共用打开逻辑，每次打开/刷新先关闭旧 owner，再读取插件列表及当前代际的 Page；关闭、切换与旧请求结果均有 owner fencing。共享客户端传递 AbortSignal，取消后的迟到成功不再解析或投影；输送层忽略信号时由宿主本地截止释放等待。
- **审查反例：** 独立复核发现连续 iframe load 会重建 owner 并重置 5 秒截止，新增永久 pending 查询与反复 load 的回归先红；修复为保留选择级观察和截止，仅轮换文档会话与请求控制器，只有最新 load 可初始化。首次浏览器 3 项均在刷新重开失败，定位为程序隐藏触发 ElDialog close 并取消新查询；补先红回归并忽略已隐藏弹窗的关闭回执后复验通过，未放宽断言。
- **定向验证：** 客户端全套 209 项、Page/父级 3 文件 92 项及相关类型检查通过；真实 Chromium 3 项验证配置预检后的 GET/PUT 撤权再授权、旧身份 reset、无 Bridge 调用的插件/Page 换代、旧 iframe 移除与新身份刷新成功。64 份文档门禁通过；依赖审计 0 未审阅、2 既有审阅路径、0 过时例外。独立复核确认两处修复未引入新的具体竞态，全量及精确提交远端证据另验。
- **本地全量：** 本轮新的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及守卫、OpenAPI 兼容、HLS、删除故障、Native Search/Runtime 和 64 份文档门禁通过；API 932、仓储 717、Host Runtime 306、Worker 156、Core 494、Host Agent 121、客户端 209、Panels 157 项通过，1 项既有真实模型跳过保留、不计通过。随后仅补本条记录并复验文档；新提交远端结果由 PR 保存，不能沿用 `619d26a7` 绿测。
- **剩余边界：** 本地观察受后台节流、事件循环及网络影响，不是跨窗口实时推送或墙钟终止 SLA；资源代际绑定、原子发布、Token 通道、CPU/内存配额与代码强制终止继续归 ITER-006，ITER-071/006 均未整体完成。

#### 随后补齐设计与行为闭环

审批 revision、分支幂等和索引语义已随首批实施；第二批客户端、模型、Catalog、DTO、表约束与接单摘要已通过本地整体验证。本轮再审计补齐 Conversation Port、完成前增强及显式配置注入，统一验证结果见上方整改记录。源码确认与隔离复现的证据强度在各行区分，不能以结构整改替代入口验收。

| 缺口与证据 | 实施及验收要求 |
|---|---|
| 已实施：工具 revision 与持久审批绑定。[tool-providers](packages/host-runtime/src/modules/companion/conversation/tool-providers.ts)统一编码声明/实现及安全身份；[运行时](packages/core/src/host-tool-runtime.ts)默认含进程实例和注册代际，不再以 updatedAt 代替实现版本 | 默认替换 handler/重启需新审批；受信宿主只有显式稳定实现版本才跨重启复用，语义变更必须递增版本；插件审批仍绑定 generation。旧无元数据批准不授权新声明，pending 按版本去重；参数哈希保持兼容。替换/重新声明/重启/跨代回归已通过定向验证 |
| 已实施：分支请求键贯通[HTTP](packages/host-runtime/src/modules/companion/branch/routes.ts)、[插件](plugins/focus-mode/src/server/terms-routes.ts)和领域命令；旧 `createConversationBranch` 已删除，分支路由消费最小 Port | 同键同参复用、异参 409，子会话/分支/Outbox 同事务；软删重试不复活，硬删结果但回执留存时 409。保留 opaque fork 标记与父策略继承，既有子会话不覆盖；无键仍可创建独立重复边。并发及 Outbox 故障回归已通过定向验证 |
| 已实施：工作台与桌宠直接订阅 Controller 的待答问题/审批，不再在旧回答返回后清空本地副本；工作台标准模式和经典卡片、主动陪伴、桌宠复用完整 UserQuestionComposer | 真实组件回归覆盖新问题先于旧回答返回、多问题/多选/自由文本、显式提交、审批与取消；桌宠失败持续可见、未知受理保留输入。各 surface 保留布局，Controller reset 只解除本地观察 |
| 已实施：Controller 保存 Turn 和最后已消费事件游标，三个 surface 均有恢复观察入口；结构化终态判定先于完成回调 | 未知受理重试复用业务键；已受理只 observe，追加到原回复；真正中断失败保留正文且不观察重试，等待审批与取消分别表达。reset/dispose/成功取消释放静默回答或审批的等待；取消请求独立跟踪，本地等待上限 30 秒，超时保留观察并允许重试，reset/dispose 释放静默取消，旧响应不影响新 owner；主动陪伴同会话重选保留正文，切会话解除旧观察 |
| 已实施：[模型配置入口](packages/host-runtime/src/modules/ecosystem/llm/provider-config.ts)统一普通/路由 Loop 和领域生成的协议、可用性、contextWindow、输出预算与原始 SSE 空闲超时；真实插件 callable 已委托同一单次消费器 | 模型源 57 项、API 5 文件 26 项、Worker 2 文件 9 项定向通过，覆盖 EOF/异常终态/空输出/静默取消/UTF-8 及上下文预算、90 秒心跳；保留路由本机证明、更严格的单次本地准入与 Anthropic 日记模板，不据夹具宣称真实模型已验收 |
| 已实施：实例级 [ToolCatalog](packages/host-runtime/src/modules/companion/conversation/plugin-tool-catalog.ts)整批拥有定义、handler、guidance 和投影；[可变 API 注册表](packages/host-runtime/src/plugin-api-registry.ts)迁入宿主，Contracts 只保留 Port；旧单条投影登记已删除 | 批量预检失败内容与 revision 不变；Turn lease 绑定各自服务，结束释放执行资源，代际撤销同时释放四项与全部 lease；安全投影按代际保留供回放。Host Runtime 2 文件 52 项、API 3 文件 16 项通过，含真实 focus factory 并行 Turn、多 Host、突变、旧 disposer、挂起声明关闭及异步门禁期间取消 |
| 已实施：HTTP Turn 创建、取消、作答、审批与观察仅消费命令/查询 Port，应用独占执行跟踪和取消；[会话子路径出口](packages/host-runtime/src/modules/companion/conversation/index.ts)已移除旧装配重导出。受理身份与审批模式从回执恢复，委托核对原始 Outbox owner；准备、Native/Adapter 共用终态裁决和显式配置快照 | 无 SQLite 的 Fastify + 最小 fake Port、完整审批续跑、重复审批只派发一次、委托身份及 Native/Adapter 控制合同已补；本次另覆盖准备删除、DSH 交接取消、丢租约/CAS/终态写失败后禁止虚假终态摘要。历史 `error` 后双事件 `done` 的迁移仍按[流式协议](docs/reference/STREAMING_PROTOCOL.md#44-error)保留，跨进程恢复、全部主动写者及生产验收归原条目，未知副作用不自动重放 |
| 已实施：独立 canonical SQLite + PRAGMA 与保守 DDL token 比对，覆盖表选项、列属性/顺序/hidden、复合 FK、CHECK、collation、逐约束冲突策略、AUTOINCREMENT、FK 延期及完整索引语义 | 7 文件 87 项定向通过；CHECK/STRICT/WITHOUT ROWID 在无版本及已登记库均拒绝，检查仅 SELECT/PRAGMA 且源 bytes/rows/version 不变；两个历史 release fingerprint 保持。保守比较不推断表达式代数等价，完整版本迁移与生产编排归 ITER-011 |
| 已实施：[术语契约](plugins/focus-mode/src/contracts/terms.ts)由浏览器与服务端共享 Schema 派生，删除 UI/抽取器重复 DTO；旧 `useAervoxTurn` 及其无消费者的流/审批/通用请求包装已删除 | 响应和事件都从同一 Schema 解析，CI typecheck 显式编译双向类型兼容证明；focus 插件 7 文件 44 项及 typecheck 通过。重复扫描仍只作线索；历史路由例外归 ITER-064，不扩大豁免 |
| 已实施：[共享传输合同](apps/desktop/test/turn-protocol.test.ts)同时跑 Fetch 和完整 preload/main IPC，补审批 POST→continuation→observe、受理未知→同业务键重试与真正中断 | 16 项共同合同通过，覆盖认证、独立 IPC requestId、游标、ACK 背压、断线去重、提前 EOF及终态失败；JSON 主进程转发提为同一可测入口并拒绝重定向。真实 Electron 及后续全量结果单独记录，不以 mock 替代实机 |

#### 本轮接续：会话长期消息真源

原先普通 assistant 只在安全片段和在线事件中，无法承接 24 小时后的历史。现新接单、终态与恢复共用[消息持久化命令](packages/repositories/src/repositories/sqlite/conversation/message-history.ts)；不引入 Schema 或用户库迁移。对 NUL 身份的终态/恢复使用 SQL 比较或 JSON 转义，避免原生文本截断导致同步失败或误用前缀身份。新写链同步修复自动日记、消息 FTS 和模型上下文的现有消费者；不完整/已删正文不能经新持久版本进入自动派生。物理删除首版、审批删流后续接、取消/恢复、人工编辑、故障回滚和身份碰撞有定向反例；整体验证另记。该切片不关闭完整授权传播或生产恢复的原有边界；[PR #331](https://github.com/3yearsZhuang/Aervox-harness/pull/331) 的 `30b11948` 已通过 8 项远端检查。用户历史读取入口由下一切片接续。

本批最终新的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及守卫、兼容、HLS、删除故障、Native、64 份文档门禁通过；仓储 801、API 960、Host Agent 123、Host Runtime 306、Worker 161、Core 501、客户端 230、CLI 131 项通过，1 项既有真实模型跳过保留。最后代码另跑真实 API E2E 45、打包 CLI/真实 API/文件 SQLite/API 重启与清理在线事件后的历史 2 项通过，审计 0 未审阅、2 既有审阅、0 过时例外。首轮 7 个重复创建身份夹具、次轮 1 个将未完成 Turn 当日记素材的旧夹具失败均保留；改为断言真实身份/明确完成素材，不放宽删除或唯一约束。NUL 恢复和取消/Hook 水位回退反例先红后绿。随后仅补本条并复验文档，精确提交远端结果另记；不将这些切片升级为整个计划完成。

#### 交付次序、已完成范围与证据

首批 P1、审批 revision、作答/分支命令已通过后续精确提交的远端门禁；第二批工具目录、模型、客户端、DTO、表约束与接单摘要已通过本地全量。本轮继续实施 Conversation Port、服务端完成阶段/配置注入、旧装配出口收口及防回退门禁，当前实现与统一验证状态见上方整改记录。沿用原六批交付关系，第三批依赖第二批，第四/第五批可并行，第六批只在消费者迁完后收尾。跨域协调归本条，长期迁移、恢复、运行和历史 API 分别归 ITER-011/010/013/064，不另建队列。

- **已落地但不能外推为整体完成：** 无 Vue TurnClient 及 Electron 主进程复用；Native/Adapter 领取、心跳、取消、删除、fencing 与原子终态主体；插件代际和事务提交前复验；插件作答及分支组合写；API/Worker 日记解析与原子发布；主路径配置快照。安全逻辑导出排除 FTS/shadow、staging 校验及源库保护已实现；同步网络/进程协调移出仓储，Worker 使用受限投影与删除命令，学习政策提纯；学习 store 按需加载及错误状态、主要 DTO、资产消费端输出、记忆纯函数、审批序列化和依赖图/循环守卫已收敛。
- **精确验证基线：** `7abd4fbb` 的 `./aervox ci all` 退出 0，API 757、仓储 493、Worker 142 项；CLI 打包/认证/文件 SQLite/API 重启及审批集成 2 项通过。真实 Electron IPC 7 项通过，入口 `mise exec -- node apps/desktop/scripts/turn-ipc-smoke.mjs`。依赖审计 0 未审阅、2 既有审阅路径、0 过时例外；额外只读自查 7 文件 69 项通过，但未覆盖上述反例。
- **远端证据：** 同一提交的[主 CI](https://github.com/3yearsZhuang/Aervox-harness/actions/runs/39923253547)、[三平台 Native](https://github.com/3yearsZhuang/Aervox-harness/actions/runs/39923253363)、[Docs](https://github.com/3yearsZhuang/Aervox-harness/actions/runs/39923253858)共 8 项检查成功；API E2E 45、Chromium UI E2E 18 项，Native 各平台布局 2/Rust 5/TS 42 项。类型、构建入口、Worker 旧消费者、动态工具刷新、分支兼容、OpenAPI 测试及删除研究旧调用者的历次失败与补修保留在 PR/CI；合盖休眠中断的运行不计通过。
- **本轮首批验证：** 21 个相关包构建通过；授权/运行时 4 文件 60 项、学习 API 7 文件 85 项、仓储数据/迁移/分支 12 文件 87 项定向通过，分支/术语真实入口及 OpenAPI 4 文件 29 项通过，64 份文档门禁通过。首次整体验证捕获插件适配器跨模块私有导入，已改为学习模块公开命令入口，未加豁免；Workflow 版本声明的字段类型及两处旧异参成功断言也已修正。`c397a395` 全量另捕获 3 处旧审批夹具；后续 `ab17564c` 改为批准真实 pending 并新增 handler/声明修订 HTTP 反例，3 文件 25 项通过。该提交的[主 CI](https://github.com/3yearsZhuang/Aervox-harness/actions/runs/39936455133)、[三平台 Native](https://github.com/3yearsZhuang/Aervox-harness/actions/runs/39936455147)、[Docs](https://github.com/3yearsZhuang/Aervox-harness/actions/runs/39936455152)均成功，含持久 CLI 集成；不能据此覆盖第二批源码。
- **第二批定向验证：** 19 个依赖构建任务通过；客户端 151、共享 UI 143、工作台 10、主动陪伴 29、桌宠 21 项通过，完整 IPC 16 项另已复验；Schema、Catalog、模型及类型证明见上表。接单摘要新增应用 4 项、HTTP 接单 12 项及 Bot 消费者 4 文件 43 项（合计 5 文件 55 项）、Worker 2 文件 16 项、仓储 4 文件 48 项及 Contracts 2 项通过。共享终态原因补真实调用链回归，Core 全套 494 项通过。`b069930d` 的打包 CLI 持久化/审批集成 2 项、真实 Electron IPC 7 项通过；依赖审计 0 未审阅、2 既有审阅路径、0 过时例外。模型消费者首次把 `settings` 写成 `settingsJson` 的测试已修，跨模块私有导入改走公开入口。三次全量分别捕获新 Schema/自带测试未登记可移除清单、类型测试配置未归类，以及运行时集市清单未同步导致的 3 项分发失败；已补精确条目，API 分发 20 项及导出 4 项回归通过，不放宽规则。Catalog 关闭/取消及 Controller 静默交互/终态缺口已补。
- **第二批本地全量：** `690cc9d5` 的 `./aervox ci all` 退出 0；API 805、仓储 572、Worker 148、Host Runtime 250 项通过，构建、类型、守卫、HLS、删除故障验证、Native Search/Rust/TS 和 64 份文档门禁均通过。Host Agent 的真实模型与参考库构建产物加载共 2 项既有跳过保留，不计通过。随后仅补本条验证记录并复验文档，远端以 PR 的精确提交检查为准，仍不能宣称 ITER-071 整体完成。
- **第二批远端差异：** `fa709a84` 的 [API/UI/依赖检查](https://github.com/3yearsZhuang/Aervox-harness/actions/runs/39959318731)、[三平台 Native](https://github.com/3yearsZhuang/Aervox-harness/actions/runs/39959318836) 和 [Docs](https://github.com/3yearsZhuang/Aervox-harness/actions/runs/39959318784)共 7 项检查成功，主代码门禁因 Adapter 取消合同 1 项失败，CLI 集成随后跳过，不计通过。隔离探针与固定时钟红测确认：SQLite 已允许 `CancelRequested` 持有者续租，Core 内存实现却仅允许 `Running`，10ms 心跳早于 50ms 取消轮询时误判丢租约。已对齐内存实现，Native/Adapter 固定顺序合同 18 项、SQLite 租约合同 12 项及 Core 全套 494 项通过，同时检查失配 lease/fencing 及终态后续租仍拒绝。修复提交 `d40df6ad` 的 `./aervox ci all` 退出 0，Host Agent 101 项通过、2 项既有跳过；随后仅补本条验证记录并复验文档，远端仍须对新提交核对，不以先前结果覆盖。
- **合并前审查补修：** 取消等待与审批参数两项反例均先红后绿。Controller 的静默取消可在 reset/dispose 释放，30 秒超时保留观察及未知结果；HTTP 初次接单与审批续跑共用受理回执恢复和活动执行去重，审批前缺失/失配回执返回 409 且无新 Attempt。客户端 45 项、HTTP/应用/SSE 32 项定向通过，原隔离探针复验通过。首次全量捕获 SSE 最小仓储被完整应用构造绑定的 10 项失败，已改为派发时使用公共执行入口，未扩张夹具或豁免。随后 `./aervox ci all` 退出 0，Host Runtime 254、API 805、仓储 572、Worker 148、客户端 154 项通过，2 项既有 Host Agent 跳过保留；打包 CLI 持久化/审批集成 2 项通过。远端仍按 PR 精确提交核对，ITER-071 整体继续保留未完成范围。
- **关闭条件：** 上述缺口逐项有真实入口或等价隔离故障回归，删除旧消费者后完成定向验证与新的 `./aervox ci all`，再核对精确提交远端检查。已有绿测不覆盖后续修订。未操作用户业务数据库；代码验收不代表生产迁移、真实模型/账号/多设备、移动真机、签名或发布完成。

## 3. 信任、数据安全与运行门槛

<a id="iter-003"></a>

### ITER-003 · 切片已交付，全链删除与隐私仍待闭合

Memory 清理、独立验证、迟到写拒绝、召回资格及用途闸门已由 [PR #268](https://github.com/3yearsZhuang/Aervox-harness/pull/268)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258)、[PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)交付；ARC-06/08、CAP-005/013/027/033。将未完成责任从历史切片恢复到活动计划，不将有限 Memory 研究推为全链证明。

- **已补切片：** PR #324 接续将 ContextManifest 新写入投影为白名单请求元数据，Core 仅在进程内保留完整输入；另补首输入恢复资格、执行检查点及 SSE 当前来源读取，具体记录与范围见 ITER-071。不自动改写历史行或清洗 Outbox/派生副本。
- **本轮接续：** 在 `fix/plan-safety-contract-continuation` 修复删除请求只按幂等键重放、忽略 scope/owner/targets 的反例；同意图按完整去重目标集合返回原回执，异意图 409 且不改原请求、目标或进度。与 ITER-010 共用 21 项控制意图回归，旧实现 18 项失败；修复后仓储相关 33、真实 API 13 项及类型检查通过，整体验证另验。不扩 Worker 的 Memory owner 范围或宣称全链删除已完成。
- **身份完整性补修：** 独立复核发现 HTTP 的 NUL 分隔元组可碰撞，原生驱动又截断文本的 NUL 后缀，未知删除身份可能被当成受支持前缀。现去重归仓储单一命令所有，JSON 转义覆盖删除请求/目标的全部读取和 RETURNING，以及账本回执；不截短、清洗或收窄合法字符串。新增仓储 2、真实 API 4、Worker 5 项反例先红；修复后控制意图 23、真实 API 4 文件 25、Worker 删除 20 项通过，后续完整集成另验。
- **下一步：** 先固化 `scope→targets`、来源→派生传播及 grant 修订绑定；显式覆盖消息/工具结果、事件、摘要、Memory、日记、附件、缓存和错误副本。历史 ContextManifest 正文清理及来源删除传播仍须闭合，不能以新写入最小化或诊断 UI 不显示正文代替全链验证。
- **依赖与验收：** 联动 ITER-071 写者门禁、ITER-013 逐帧撤权及 ITER-010 deny 账本；数据库级唯一 sequence 约束经 ITER-011 演练。撤权/删除立即阻断用途，迟到写、重试、备份恢复均不复活；独立验证无召回、无越权动作，失败/未知 owner 不返回完成。权威边界见[隐私合同](docs/reference/DATA_PRIVACY.md#privacy-deletion-sla)及[当前限制](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-证据与适用限制)。

<a id="iter-006"></a>

### ITER-006 · 配置与 Page 登记代际切片已补，资源与完整撤权待验收

Page/客户端认证；FND-03、ARC-13，CAP-018/020。Window/source、密码学 nonce、文档会话、全部 Bridge capability、观察到禁用后销毁及 Page 文件启用/symlink 边界已有 [PR #281](https://github.com/3yearsZhuang/Aervox-harness/pull/281)、[PR #283](https://github.com/3yearsZhuang/Aervox-harness/pull/283)；附件 Bearer、ITER-069 合法预检已有交付。

- **接续切片：** PR #324 在配置事务联合检查 enabled/availability/lifecycleGeneration 与 revision/Schema；Page 打开绑定代际，四种 Bridge 调用都查询当前代际和 Page capability，配置返回前再复验。Page 保存另由宿主注入 Page ID，在同一写事务检查当前 `config.write`，预检后能力移除不提交配置或 Secret。每次 Page 登记/资源摘要更新绑定独立持久代际，保存同事务核对；同插件代际撤权再授权/删除再建拒绝旧会话，资源摘要 CAS 不覆盖当前声明。同 ID 换代拒绝旧请求和迟到响应；配置事务竞态及实际旧 Page 调用反例见 ITER-071。
- **下一步：** GET/reset Page 身份已由 ITER-071 补齐，资源文件 I/O 前后资格复验由同条接续；补全实时撤权与资源通道、SQL 至客户端动作、完整资源原子发布和实际平台集成，调用时拒绝与当前能力检查不能证明运行中代码终止或全资源原子撤权。
- **决策前置：** Token 模式下 HTML/嵌套 JS/CSS/图片/Bridge SDK 资源通道，须先决定凭据签发、绑定、期限、轮换、撤销和 Origin 信任；沿用 ITER-063。长期 Bearer 不暴露给插件，不放 URL/日志，不降低认证或 CSP；Page capability 与 scoped sensor grant 分开。
- **验收：** 声明支持的 Web/桌面实际加载及配置操作，覆盖重载、过期/轮换、跨窗口停用、跨插件/来源拒绝、旧会话不能恢复。JSON/SSE/Page/附件均可在合法 Token 模式使用，实际资源和撤权集成证据不能由消息模拟代替。

<a id="iter-010"></a>

### ITER-010 · 待实施：控制账本、安全恢复与跨进程续跑

依赖 ITER-002/003/007 的必要切片，ARC-04/06、CAP-007/027/033。Resume 请求/账本覆盖及高水位已有切片，运行中审批续跑不代表跨进程自动恢复；不直接启用旧 Resume Host。

- **先做控制面：** 按[隐私合同](docs/reference/DATA_PRIVACY.md#privacy-deletion-sla)控制操作先取得独立 RecoveryControlLedger 的 durable ack，业务失败由 reconciler 按连续 sequence 幂等补齐；账本不含正文。缺失、验签失败、sequence 缺口、最老备份覆盖不足或水位未追平时，对受影响来源/用途保持 deny。
- **本轮接续：** 账本同键回执原先只比 eventId/eventType，可把另一 target 的请求误报为已完成。现比对完整控制引用、显式时间及规范化 JSON 证明，并发同意图只返回同一 sequence、异意图冲突拒绝；反例和定向证据见 ITER-003。仓储修复不等于账本先行、水位对账或恢复接线，ADR-013 的独立凭据/故障域与当前本地单用户部署仍需明确适配，不能重引租户隔离。
- **再做恢复：** 旧备份先阻断流量，重放删除/撤权事实和授权期限，验证零召回/零越权后开放；与 ITER-011 的主库/Vault/账本回滚集合联动。续跑、一次性授权/有效期、跨库恢复和保留策略的差量先 ADR。
- **验收：** 缺账本、多工具、跨进程答案/审批、重复接管、旧备份不吞答案或重复副作用；未知结果不盲重放。取消提交后进程退出，过期 CancelRequested 以 fencing 收敛终态并结束重连流。
- **接单切片的保留限制：** ITER-002 的 `subagent_runs` 自身中断恢复及跨进程同幂等键 HTTP 语义尚未验收，纳入接管/恢复故障矩阵；不因 Turn 原子受理已交付而推定这些场景完成。

<a id="iter-011"></a>

### ITER-011 · 基础 staging 已实现，完整版本迁移与演练待完成

ARC-09、CAP-027。ITER-071 已撤旧快照原地恢复、由 Schema 编译目标结构并校验指纹，提供单库 staging/备份/源字节复验/换库/回滚保护；尚未证明所有支持旧版本和整体升级恢复。

- **下一步：** 唯一有序、不可变迁移入口，接线版本 journal/校验和/库外阶段状态；旧原地 helper 已撤下。列、默认、NULL、PK、复合 FK、完整索引及表级 CHECK/STRICT/WITHOUT ROWID 已由 ITER-071 补齐检查，历史版本升级路径仍须逐一演练。明确主库、Vault、控制账本、密钥和状态的备份/回滚集合，证明 API/Worker/后台及未知消费者已停写；维护锁或 `--stopped` 声明不是停写证明。
- **演练顺序：** 停写→验证备份→显式选择数据范围→同文件系统新 staging→完整结构、integrity、FK、行数、索引、FTS 校验→关闭句柄并原子换库→首次写前只读验证→保留回滚包。中断只继续已证明安全阶段或恢复原库，staging 失败源库不变；回滚包按[数据库契约](docs/reference/DATABASE.md#9-cr-030-破坏性迁移)至少保留 30 天或 10 次成功启动。
- **边界与验收：** 每个支持旧版本、失败点、恢复及实际回滚均隔离演练；NULL/重复主键、冲突、坏 JSON、孤儿 FK、行数不符、未知消费者阻断并输出清单，不删除/合并、修改幂等键、选择胜者或补造身份。迁移协调方案先评审，破坏性转换先 ADR；用户业务数据库操作单独验收，不因本计划自动执行。

<a id="iter-013"></a>

### ITER-013 · 进行中：有界运行、逐帧撤权与完整排空

ARC-05/12、FND-05/06/09，CAP-007/018。依赖 ITER-002/008 必要切片，与 ITER-071 生命周期和配置收口协同；先观测后定参数，跨进程通知/新隔离边界先 ADR。

- **已交付：** [PR #316](https://github.com/3yearsZhuang/Aervox-harness/pull/316) 单读取/写入执行者、Hub 唤醒合并、终态/高水位同快照及分页重放；页最多 256 行/256 KiB data 前缀，保留至少一条超预算事件，单事件/元数据/JSON 内存仍可超预算。write=false 等 drain 最多 30 秒，连接总限 10 分钟从重放起计；断连不取消 Turn、不造终态，旧 Attempt 不截断续跑。[PR #317](https://github.com/3yearsZhuang/Aervox-harness/pull/317) 从首信号共享默认 20 秒 Worker 关闭预算，前序释放成功才显式关库；超时/异常非零，数据库关闭可能部分成功。
- **逐帧删除切片：** PR #324 在建流和逐帧发送前查询当前来源状态与持久事件，删除后不继续发送缓存页，空闲轮询也关闭观察；真实 API/独立 SQLite 进程及背压反例见 ITER-071。只覆盖首输入缺失和现存同 Turn 身份软删，完整授权/脱敏、非首输入物理删除传播及网络原子撤权不在完成声明内。
- **下一步：** 优先完整逐帧授权/同意版本及来源传播、全局并发流限额，再覆盖所有 Provider 队列/取消、Host/Worker 全部写者 drain、跨进程终态及累计预算策略。ITER-007 的费用/跨重启计量和一次性授权剩余分别联动 ITER-033/010；不将异步计时器视为同步阻塞或原生强杀时限的保证。
- **验收与证据：** 慢源/慢客户端/日志洪泛资源有界、停机有截止、已提交窗口可读、失败可定位，复用现有 metrics。真实慢 TCP/临时 SQLite、独立 Worker 子进程回归与精确 PR 门禁已通过；error/done、取消幂等及事件保留遵守[流式协议](docs/reference/STREAMING_PROTOCOL.md)。历史失败与样本值保留在[原计划](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/plan.md#iter-013)，不能外推生产峰值。

<a id="iter-005"></a>

### ITER-005 · 原子激活切片已交付，升级恢复仍待完成

FND-02/04、CAP-020，依赖 ITER-004/063，遵循 [ADR-028](docs/reference/adr/ADR-028-plugin-atomic-activation.md)。缺包保护、预检/解压配额、独立资源准备、短事务激活、失败保留旧版及原始归档导出由 [PR #283](https://github.com/3yearsZhuang/Aervox-harness/pull/283)交付。

- **当前必要范围：** 各分发入口预检/写入/注册/切换失败与崩溃恢复，旧 Config/Secret/授权不丢失，全部声明入口可用、配额有界、重试幂等；同源码导出字节/校验和可重现。与 ITER-071 Catalog 原子登记协同，不把 SQLite 事务当文件系统跨介质原子保证。
- **后续按需求推进：** 运行失败自动回退、复杂配置迁移、旧资源自动回收；升级/卸载及迁移语义先 ADR，既有安全升级合同仍须通过。不将该切片升级为整个插件生态发布完成。

## 4. 现有产品闭环与交付

这一阶段围绕“发送→流式结果→补问/审批→重启后接续→删除/导出”验证现有个人助手，学习能力保留事实真源。先做真实模型和当前入口，再扩大长会话、部署及额外命令；真实外部账号/设备和发布分别取证。

<a id="iter-053"></a>
<a id="iter-059"></a>
<a id="iter-061"></a>

### ITER-053/059/061 · 第一方界面切片已交付，产品场景待验收

- **ITER-053：** 前端体验与跨端连续对话已有 [PR #260](https://github.com/3yearsZhuang/Aervox-harness/pull/260)、[PR #275](https://github.com/3yearsZhuang/Aervox-harness/pull/275)；本轮历史抽屉接上 ITER-064 持久分页；实时对话面板自动回填、主动陪伴的历史入口、真实模型和跨端用户操作闭环继续验收。移动真机按 ITER-009 的平台/运行位置决定后取证。
- **ITER-059：** 陪伴界面、最近会话和固定入口由 [PR #276](https://github.com/3yearsZhuang/Aervox-harness/pull/276)交付，桌面经典布局/移动陪伴由 [PR #306](https://github.com/3yearsZhuang/Aervox-harness/pull/306)对齐；仍须验证学习记录推荐来源、真实模型及设备行为。
- **ITER-061：** companionName/userAddress 与旧字段迁移由 [PR #279](https://github.com/3yearsZhuang/Aervox-harness/pull/279)交付，按维护者决定移除素简文档界面；命名与身份分层保留，服务端统一身份、真实模型/实机仍未验收。以上原编号分别承接剩余，ITER-071 先修 Controller/问答/观察缺口，各 surface 保留布局。

<a id="iter-064"></a>

### ITER-064 · 进行中：历史 API 契约按用户路径收敛

CAP 与合同遵循 [API 约定](docs/reference/API_CONVENTIONS.md)，依赖 ITER-063 的共享声明、认证与兼容门禁。2026-10-15 基线 147 条，现剩 **117 条**；唯一明细是[实际路由例外](apps/api/test/fixtures/openapi-route-baseline.json)，不刷新基线隐藏遗漏。

- **顺序：** 先隐私/配置/插件及技能写入口，再补当前会话详情/历史、作答/分支入口和 CLI 所需接口，随后内容/学习/主动模块剩余分组。ITER-071 的鉴权与原子性修复不等待全部历史路由清零。
- **验收：** 精确方法/路径、稳定 operationId、请求与成功/错误 Schema、认证、真实请求和旧客户端行为；新增遗漏/扩大豁免被拒绝，每补一个删除其精确例外。JSON 共享端点不改变 SSE/文件/二进制协议，破坏性变化单列迁移决定。
- **历史真源前置：** 本轮接续普通在线 user 的真实 Message 身份和 assistant 空版绑定，终态/取消/恢复事务发布已提交安全前缀、当前指针及 sequence 水位；审批续接保留已存前缀，人工编辑不被迟到写覆盖。来源/删除资格与日记、FTS 派生同步收口，旧 unlinked/import 不迁移、不从事件猜造正文。模型上下文对新消息改读长期当前版本，清理在线事件后仍能读取；保留 20 轮/32000 字符预算及旧路径边界。用户历史分页 API、CLI 与工作台抽屉由下列切片接续，当前集成与 PR 证据另记。
- **本轮持久历史读取：** 新增共享 `GET /v1/sessions/{sessionId}/history` 与 headless Client，CLI `sessions history` 和工作台“对话回看”读取同一当前版本投影。单页默认 20/最多 50 个候选，按插入顺序显式向前翻页；隐藏候选不额外扫描填充，空页仍可返回游标。单轮 100 消息/256 KiB、整页 512 KiB，超限含游标转义膨胀返回明确 422，不截断成功正文。未完成状态保留、脱敏正文为 null，旧 unlinked 只读，不从事件补造缺失历史；无首 User 的导入轮仍受保守来源门槛阻断。工作台单页替换，关闭/切会话/改页数清正文并释放旧 GET，不改变实时 Controller；完整授权传播、真实模型与移动独立运行仍分别验收。
- **本轮验证：** 最后代码的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务，API 967、仓储 820、Host Agent 123、Host Runtime 306、Core 501、Worker 161、客户端 234、CLI 148、UI 155 项通过，1 项既有真实模型跳过保留；守卫、OpenAPI 兼容、HLS、删除故障、Native 与 64 份文档门禁通过。打包安装 CLI/真实 Token API/文件 SQLite/重启/清理在线行/分页及隐藏 2 项通过，Chromium 全套 23 项通过，其中 390/1280px 真实浏览器新回看 2 项；依赖审计 0 未审阅、2 既有审阅路径、0 过时例外。独立复核发现合法中文 ID 被旧 CLI 限制，以及 NUL 转义使游标超限，新增反例修复；首次全量因 CLI 直接依赖 Contracts 被架构守卫拒绝，改由 headless Client 暴露共享校验，未放宽依赖规则。随后只补验证记录并复验文档，[PR #332](https://github.com/3yearsZhuang/Aervox-harness/pull/332) 的 `30e75c57` 已通过 5 项远端检查，仍待审查合入。
- **剩余产品责任：** Neo 生命周期；分支来源、完整删除、布局恢复、大图性能；反馈读取预算、回答版本关联和复核队列。图读取行数预算不证明 SQL 排序时间或单布局字节有界。

| 已合并切片 | 保留行为与数量 | 证据 |
|---|---|---|
| 隐私/偏好 8 接口 | 宿主身份审计、默认偏好/版本、删除去重与 202；147→139 | [PR #298](https://github.com/3yearsZhuang/Aervox-harness/pull/298) |
| 插件配置 5 接口 | Schema 深度、revision CAS、Secret 脱敏、generation 不变；原已有声明，不减少例外 | [PR #311](https://github.com/3yearsZhuang/Aervox-harness/pull/311) |
| 基础技能 7 接口 | 整数旗标/信封、204、所有权/只读、归档写前冲突、取消提交门禁；139→134 | [PR #314](https://github.com/3yearsZhuang/Aervox-harness/pull/314) |
| 会话分支 8 接口 | 201/软删 200、必需 JSON/null 布局；图迭代去重/断连，1000 会话/10000 唯一分支超限 422 不部分返回；134→126 | [PR #315](https://github.com/3yearsZhuang/Aervox-harness/pull/315) |
| 质量反馈 2 接口 | actor 取认证上下文、剥离旧 body.actorId；重复查询/类型写前拒绝，扩展字符串/nullable note/201、200/旧 void 行为；126→124 | [PR #318](https://github.com/3yearsZhuang/Aervox-harness/pull/318) |

本轮在 `fix/plan-safety-contract-continuation` 接续插件列表、启停/卸载、授权/有效感知列表/撤权及权限查询 7 个端点，精确例外 124→117；保留完整插件行、整数旗标、nullable/扩展元数据、撤权 200 行与卸载 204。撤权 SQL 同时绑定 grant ID 与 URL 的插件 ID，错误插件路径返回 404 且原行不变；仓储/HTTP 反例先红后绿。定向仓储 5、API 30、Contracts 100、客户端 218 项、相关类型及 OpenAPI 兼容通过，全量与新 PR 另验。首次全量拒绝生成 OpenAPI 超出受跟踪文件预算，现复用命名插件响应与既有 ModelRuntimeState，生成物降至 938288 B，兼容及卫生门禁通过；不扩大预算或删除契约。

本轮接续 LLM 配置读取/保存、连接探测和四个 Preset 端点，共 7 个共享声明；保留已有 operationId、默认配置、可空密钥、首个 Preset 自动激活、删除 200 回执及探测失败 200/ok=false。它们原已列入 OpenAPI，精确例外仍为 117；只补三处历史必需请求体的精确文档纠正，不刷新基线。连接错误使用固定消息，不回传凭据 URL、Provider 错误正文或内部异常；新增泄漏反例；连接探测的既有截止原先只覆盖响应头，现贯通正文与能力读取，真实 200 半截流/慢主响应与 500 不结束正文均验证释放。CLI 编码脱敏及最终集成验证与新 PR 证据另记。

本轮 LLM/CLI 最终新的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及守卫、OpenAPI 兼容、HLS、删除故障、Native 和 64 份文档门禁通过；API 960、仓储 742、Worker 161、Host Runtime 306、Core 501、Host Agent 121、客户端 230、CLI 131 项通过，1 项既有真实模型跳过保留。独立复核捕获编码密钥路径/标签、响应正文无截止和异常能力元数据三处缺口并补回归修复，真实 API 13、CLI 模型 41 项通过；打包安装的 CLI 连接真实 API/临时文件 SQLite，模型配置及 Preset 跨 API 重启保持，2 项集成通过。依赖审计为 0 未审阅、2 既有审阅路径、0 过时例外；随后仅补本条记录并复验文档，精确提交远端结果由新 PR 保存。

首次旗标构建及客户端 undefined 回归失败与后续修复保留在各 PR/CI 和[原计划](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/plan.md#iter-064)。

<a id="iter-033"></a>

### ITER-033 · 确定性切片已交付，真实 Provider 与代际接续待评审

CAP-002/007、本地模型基础设施。Core Provider 与本地 Driver 的统一目录、配置/能力接线、Faux 取消/故障、stop reason/usage 落库及通用 ModelRuntime DTO 由 [PR #282](https://github.com/3yearsZhuang/Aervox-harness/pull/282)交付；原 `Llama*` 别名/driver 元数据与完整可移除性仍需复核，不能据夹具宣称真实 llama 可用。

- **下一步：** 先与 ITER-071 统一协议、配置、单次生成的最终输出和预算；固定真实 Provider 验证取消/故障/就绪及完整对话闭环，再补注册 generation 的宿主失效消费、跨 Provider 上下文交接和实现移除演练。用同一 Fake/Replay 轨迹对照终止语义与 usage 分账，新增兼容端点只注册声明，不改执行器/路由。
- **边界：** 依赖 ITER-008 制品/进程安全；Driver 缺省 unavailable，受限本地任务不得静默转远程。新增远程 Provider、制品信任或两栈持久语义改变先 ADR，不建第二注册真源；标准测试桩关联 ITER-040，Core 零运行时依赖保持。
- **本轮目录修复：** 外部输入、getter/list 与工厂共享可变描述符，原本可不递增 generation 就改变能力与本地声明；同 ID 不带工厂重登记还会沿用旧 handler。4 项回归先红后绿，现由注册表持有独立快照、冻结内建种子，并随新登记替换工厂；custom 缺工厂拒绝，内建协议按新声明创建。定向目录 11 项通过；不取消旧实例或在途请求，真实 Provider 与宿主失效消费仍未整体验收。

<a id="iter-029"></a>

### ITER-029 · 执行中：连接版 CLI 补齐现有会话闭环

`@aervox/cli` / `siyu` 只消费本机 API 与 `@aervox/api-client/transport`，CAP-002/007/020。单次/TTY 连续会话、事件补读/终态、诊断、配置读写、JSON/JSONL、Token/幂等、审批/补问/有界取消已由 [PR #308](https://github.com/3yearsZhuang/Aervox-harness/pull/308)、[PR #319](https://github.com/3yearsZhuang/Aervox-harness/pull/319)交付。

- **下一步：** 基于 ITER-064 的持久历史分页，完成真实模型下的跨客户端/API 重启接续与平台矩阵。学习/复习、记忆专用命令、独立运行另验，不扩大首个连接版为独立宿主；不增 Schema、中心服务或第二执行栈。
- **本轮历史入口：** `sessions history <ID> [--limit 1～50] [--cursor …]` 只请求显式一页，JSON/JSONL 保留共享 DTO；TTY 区分有效输入、未完成前缀和只读/隐藏记录并清除控制序列。采用共享 Session 参数校验，支持中文及带斜杠的已有 ID；不创建/取消 Turn、不自动重试或改变上次执行回执。安装制品连接真实 API/文件 SQLite，跨 API 重启及清理在线行后的分页/隐藏读取另验。
- **本轮模型配置入口：** 共享 headless LLM Client 供 CLI 与 Vue 使用；`models` 提供目录、配置、连接探测及 Preset 管理，配置从文件读取，密钥可经环境变量注入，输出仅白名单字段和去除凭据/查询的 URL。省略 apiKey 仍按旧合同清空，命令不存本机模型密钥；不把模拟探测当真实 Provider 验收。
- **验收与边界：** 打包产物+真实 API/文件 SQLite，非交互不自动批准，观察超时/失败不取消已受理回合，中断有界取消；共享包不反向依赖 CLI。列表 limit 有界、offset 安全整数，只翻用户指定页，offset 非快照；不当完整导出。
- **证据：** 重启后 102 个临时会话的默认/末尾/空页和接续、全量及远端检查通过；不等于真实模型/正式平台发布。首次无退出码及旧依赖失败保留在[原计划](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/plan.md#iter-029)及 PR。

<a id="iter-062"></a>

### ITER-062 · 自动化切片已移交，真实 Bot/部署验收待环境

第一方文字适配器、连接代际、持久队列与来源隔离由 [PR #284](https://github.com/3yearsZhuang/Aervox-harness/pull/284)交付，决定见 [ADR-029](docs/reference/adr/ADR-029-bot-platform-adapters.md)。保留原条目承接剩余，避免在“已移交”表中隐藏。

- **下一步与验收：** 在可用账号/环境下分别验证微信扫码/配对/连续对话、QQ/NapCat 多成员隔离与重连、独立宿主/关闭窗口后运行、Linux 重启恢复；真实模型与平台连接分别记录，依据[接入指南](docs/how-to/connect-bots.md)。缺环境保留未验，不把模拟协议替代实证。
- **边界：** 连接验证可与 ITER-015 必要部署切片并行，独立运行/重启恢复依赖其主管能力及当前授权/恢复门禁；缺 Bot 账号不阻断本机产品交付。回退先停适配器，未知结果不盲重发，不能扩大来源权限或把连接成功当回答成功。

<a id="iter-015"></a>

### ITER-015 · 主管切片已实现，安装升级与分发待评审

ARC-13、CAP-001/018/027。[PR #272](https://github.com/3yearsZhuang/Aervox-harness/pull/272)已有原生主管切片；完整 API/Worker/模型归属、数据目录、端口、Token、版本、就绪与退出仍须整体验收。

- **依赖：** ITER-006/008 与 ITER-011/013 必要门槛，新主管差量先 ADR；与移动运行位置决定协调，不因现有 Helper 自动认可部署方案。
- **验收：** 干净用户目录安装、升级、中断、端口占用、磁盘满、异常退出及卸载保留数据；签名/公证/平台实机矩阵独立记录。ITER-008 的 ETag/If-Range 持久化、磁盘/时长及就绪分级剩余先核对发布所需范围，不能以下载或 HTTP 200 证明模型可用。

<a id="iter-032"></a>

### ITER-032 · 基础投影已交付，长对话保真与真实摘要待评审

CAP-002/005/007，对话质量基础设施。[PR #281](https://github.com/3yearsZhuang/Aervox-harness/pull/281)已有保真事实输入、可注入摘要器、Base 后加载历史、字符预算、零尾部及空摘要拒绝；规则裁剪仍明确“未生成摘要”。

- **下一步：** 先评审必须保真的目标、未解决错因、偏好、承诺与来源，再接产品权威事实加载及真实摘要 Provider；涉及对话契约差量先 ADR。真实摘要默认关闭，不伪造压缩后记忆；最终窗口与 ITER-007/033 协同，测量归 ITER-017。
- **验收：** 固定长对话的事实/来源可追溯，超大工具组不破坏调用/结果配对，最终输入+预留输出不超窗口；每次模型可见投影可从权威历史重建，展示与持久历史分离，旧响应不覆盖终态。压缩不是删除，原文/摘要/索引受 ITER-003/010 全链门槛约束。参考[架构历史来源](docs/reference/ARCHITECTURE.md#upstream-20260929)及[压缩边界](docs/reference/ARCHITECTURE.md#1342-pi收敛核心职责让阻塞失败可见)。

<a id="iter-012"></a>

### ITER-012 · 待实施：索引生命周期与可切换投影

ARC-08、CAP-005/026。依赖 ITER-003 删除/召回资格，错误 SQL 可独立修；不恢复旧隔离列。

- **下一步与验收：** dirty/reindex、来源修订、模型/维度版本和可选旧列回填；投影切换/模型版本先评审。故障可追平、A→B→A 切换、资格零越界；固定中文语料单列 Recall@K、空间及重建成本，性能收益归 ITER-017 测量。

<a id="iter-026"></a>

### ITER-026 · 已有实现待评审：第一方学习插件边界

S1～S7 及评审修正由 [PR #250](https://github.com/3yearsZhuang/Aervox-harness/pull/250)实施，决定见 [ADR-016](docs/reference/adr/ADR-016-base-boundaries.md#cr-060)，CAP-002/007/016；本条做有限验收，不启动新一轮全宿主改写。学习闭环保留主仓事实真源，`plugins/focus-mode` 不转自选模块或 submodule，不改 CAP-003/004/006 端点。

- **复核：** 宿主纯净性零违规/零豁免，删除插件实现后三相移除演练与 Web/桌面组合根 typecheck 通过；组合根注入补独立渲染证据。插件禁用无专属请求/工具，旧配置一次迁入 pluginState 不丢失；安装记录/配置/数据管理保留，插件 id 唯一、历史别名全删。
- **兼容与产物：** 通用状态/metadata/流事件/槽位/设置/Composer/工具/路由接缝保留，Core 不含产品提示词/刷题工具；分发只含 manifest/config Schema/SKILL 且 SHA-256 可重现，协议或公开类型破坏性差量按 ADR-016 维护。ITER-071 的端口/DTO/事务剩余由其修复，本条不重复登记。
- **本轮隔离演练：** 精确提交 `4e0e7f39` 在独立临时克隆完成 seed/absent/restored 三相物理移除，0 缓存冷构建分别 21/18/21、Web/桌面类型依赖图 28/22/28 个任务通过；53 个源码/锁文件逐字节恢复、克隆工作区干净。宿主纯净性 470 文件零命中/零豁免、3 个可移除试点通过；数据夹具仅证明 Memory 保留/查询/导出/软删、通用工具、模型文件与 Unavailable 驱动，不涵盖 focus 旧配置迁移、禁用零专属请求、独立 UI 运行或真实模型，不能据此关闭整个 ITER-026/033。

## 5. 有证据再投入的性能与维护工作

<a id="iter-017"></a>

### ITER-017 · 待评审：统一测量与收益决策

FND-07/08/10、ARC-05/08/12。依赖 ITER-013 的正确性和指标；依据 [ADR-024](docs/reference/adr/ADR-024-native-runtime-boundaries.md)测量代码搜索、向量端到端、三平台活动 Helper 与计算隔离。[PR #272](https://github.com/3yearsZhuang/Aervox-harness/pull/272)已有有界搜索、向量对照、活动 Helper、音频/插件 Worker 及 Cargo/IPC 收敛；ITER-071 另补语义差分与资产归属，不据此宣布生产收益。

- **下一步与验收：** 同设备同数据报告 P50/P95/P99、失败率、内存、质量，分别决定 Prompt/压缩、SQLite 竞争、topK、隔离及资产缓存投入；未达收益门槛就停止，不为表面速度扩大 SQLite 测试并发。生产索引迁移、签名、真实权限/设备单独取证。
- **本轮受控基线：** 在独立克隆 `4e0e7f39`、同一 Core 构建摘要下复跑 large/small-chunks 各 5 样本，均退出 0。macOS arm64 开发机首段 P50/P95 分别 31.575/32.546 ms 与 50.974/52.067 ms，取消 P95 53.662/52.353 ms，最大提交批次 3840/80 B；写入点采样堆峰约 7.54～9.00/7.82～8.91 MB。仅 Fake Provider/内存存储、小样本且非独占机器，不作为真实模型、生产收益或完整内存峰值证明，不新增性能阈值。

<a id="iter-027"></a>

### ITER-027 · 待评审：SQLite 写竞争与后台退避

ARC-05/FND-07，依赖 ITER-002 Outbox 归属、ITER-013/017 指标。IPC 唤醒、写压退避和连接自愈已实现，真实单用户仅部分达成；双写极限仍受 SQLite 单写者吞吐限制。

- **验收：** 固定密集会话/后台任务样本，验证退避至 3s+、避免空写轮询，报告 SQLITE_BUSY、锁冲突、P99 及长周期表现。原零冲突目标仅在明确支持负载下验收，不能承诺任意负载；保留 WAL 快照与短事务，不盲重试 BEGIN，不把外部副作用放入事务。本地 socket/命名管道替代轮询按测量决定。
- **本轮演练差异：** 首次真实演练因脚本仍从仓储旧出口读取 `sendWorkerIpcMessage` 失败，现仅改为进程协调公开出口。保留原失败，在同一隔离克隆、2 写者、15 秒写入+15 秒 drain 下复跑 0/40 ms 节奏，两组写入均成功、逃逸错误均 0，但仍分别剩余 15146/270 个 Outbox，整轮退出 1、NOT CLEAN；未放宽 drain 或成功判据。压力期最小观察间隔 3067/3056 ms，写延迟 P99 4.872/6.988 ms，连接自愈 5473/353 次，零逃逸不等于零竞争。只证明退避与保留积压，排空、长期和支持负载仍未完成。
- **有限负载补测：** 仅将生产节奏改为 500 ms，其他参数和截止相同，双写者共 60 Turn/消息、120 次写入、60 事件全部消费，0 pending/failed/dead-letter/孤儿，整轮 CLEAN、退出 0；写延迟 P50/P95/P99 3.151/7.022/11.045 ms，压力期间隔最小 3346 ms。该设备一次约 4 Turn/s 的有限点通过不覆盖 0/40 ms 失败，不建立生产吞吐区间、零竞争或长周期 SLA。

<a id="iter-040"></a>

### ITER-040 · 建议：标准测试 Provider 与可选重试

依赖 ITER-039，服务 ITER-033 parity。先统一 replay/scripted/adapter-sim/mock 能力声明与标准轨迹，无法合并的桩写明用途；不为统一名字扩大维护面。

- **条件与验收：** 真实需求成立后才做默认关闭、可注入的单请求重试：有界次数、指数退避/jitter、429/5xx/overloaded 与配额/计费错误分类；与宿主跨 Provider 降级只留一处政策，不新增 Provider、不破坏 Core 零运行时依赖。默认关闭时行为不变，重试不能重放未知副作用。

## 6. 条件性扩展与研究

以下保留原提案或条件授权；进入实施前满足各自前置。设备/移动定位可做轻量决策准备，当前不分配硬件开发、第三方平台或 HLS 真实环境工期。

<a id="iter-019"></a>

### ITER-019 · 建议：第三方可执行插件开放决定

先证明声明式/第一方扩展不足，再决定开放范围、信任根、能力代理、SDK/宿主兼容、配额和生命周期；沿用 [ADR-009](docs/reference/adr/ADR-009-electron-plugin-sandbox.md)进程外隔离、默认无权限和撤权基线，改变须修订 ADR。未选定不建通用平台，第三方 UI 由 ITER-056 承接，安装恢复依赖 ITER-005。

- **实施条件与验收：** 范围/威胁/成本评审后，才拆独立 Host、签名/依赖、授权代理、CPU/内存/时限、强杀/崩溃恢复和撤权清理；覆盖越权/逃逸/篡改/耗尽/兼容，撤权后无新副作用，插件缺席仍可核心使用、导出/删除。现有 Hook 协作取消、iframe 和声明包激活不等于第三方执行完成，平台实机与发布单验。

<a id="iter-056"></a>

### ITER-056 · Proposed：第三方根界面开放

2026-10-13 立项提案，[ADR-026](docs/reference/adr/ADR-026-ui-surface-open-ecosystem.md)未批准实施。信任分级、能力白名单、隔离降级、独立安装/升级/回滚先评审；第一方薄 UI 与 ITER-071 共享 Controller 不构成开放第三方的授权。原生移动范围留 ITER-009 和 [ADR-022](docs/reference/adr/ADR-022-mobile-runtime-access.md)。

<a id="iter-009"></a>

### ITER-009 · 进行中：Android 独立端前置与硬件定位

比较九个硬件方向、电脑依赖、目标 OS、真实 Provider、成本和数据边界；CAP-001/012/018/025/030/033。只做候选/样本和继续或暂缓结论，选一至两个方向，不默认采购/SKU/固件/顺序/工期。维护者已选择手机独立运行、电脑关闭后仍可使用，并确认 Android 先行；移动 M0 在 Android 路线上接续验证本地执行/存储适配，按已接受的 M0 凭据/普通会话范围实施，再由实际证据裁定平台版本范围，之后细化 M1～M6。本轮接入 Android 原生工程，iOS 工程尚未创建；前次仅见 Command Line Tools 的环境结论已过时，本轮实时可见 Android SDK API 36 和 adb；兼容 JDK 接线、原生构建与设备验收继续另验，不能由工具存在推定通过。具体待决定事项见下一节，关联 ITER-016。

本轮 Android 工程前置提供显式 Web 构建、Android 同步/doctor、只读环境预检和 debug 构建命令，Java 21 固定于 mise，Gradle 分发带校验值。官方模板源码与许可纳入版本控制，资源复制、SDK 路径、签名密钥与构建产物不跟踪；自动备份和明文网络默认关闭。初始 Capacitor 8.5.0 的依赖审计命中严重公告，统一升至 8.5.1 后为 0 未审阅、2 既有审阅、0 过时例外，不新增豁免。工程、Web 构建与原生 APK/设备验收分别记录；本机 SQLite/凭据/模型桥、独立运行及跨设备数据仍未交付。

Android 集成分支新的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务、12 项移动脚本/环境合同及既有包测试、守卫、OpenAPI 兼容、HLS、删除故障、Native 和 64 份文档通过；冻结安装与移动说明排版另验通过。真实 `android:build`、sync、doctor 退出 0，生成约 8.3 MiB debug APK，包名 `com.aervox.mobile`、最低 API 24/目标 API 36，v2 调试签名有效，合并 Manifest 两项禁用均保留。曾因 SDK 路径未传入子进程和缺 Build Tools 35.0.0 失败，修脚本并显式补唯一组件后通过；不将 Web 构建或环境预检计作 APK 成功。临时 AVD 两次启动均遇 HVF/mprotect 权限错误，ADB 未就绪，自有进程已退出；App 身份测试 APK 已编译，未执行设备测试。设备交互、独立运行和发布仍未验收，精确提交远端结果由新 PR 保存。

维护者已审阅并接受 [ADR-022 的 M0 技术差量](docs/reference/adr/ADR-022-mobile-runtime-access.md#已接受的-m0android-独立隔离原型)：固定官方 SQLite 候选、手机本安装唯一真源、复用仓储原子规则、原生持钥及受限模型请求，先新建隔离会话的前台/重启/取消/问答/删除闭环。真实特性、ABI/16 KiB 页面、设备、真实 Provider 与发布分别验收；不自动操作桌面库或扩入同步/后台常驻/第三方代码插件。

本轮先交付 `@aervox/core/browser` 中性入口，整包打包不包含 Node/CLI，VM 无 process/require/Buffer 仍能执行 Turn，声明闭包以 DOM、types=[] 编译；现有入口保持。独立复核捕获旧 `./core` 独有的 abortable 导出丢失，新增以旧轻量符号表为基线的回归先红后绿，补回两项后定向 3 文件 13 项和类型检查通过。该前置不等于本机持久 Store、原生 SQLite/密钥/模型桥或手机闭环，后续依次补齐，不把 Node API/Worker 原包直接装入 WebView。

本轮接续将既有执行适配方法提炼为 `@aervox/host-agent/browser` 的中性 `ConversationExecutionStore` 和明确仓储 Port；原 `SqliteExecutionStore` 保持三参构造及同一委托方法，事务、fencing、来源/删除和幂等仍由原仓储负责。生产包装仅以真实 FencingMismatchError 身份转换租约错误，同名伪造或未知异常原样抛出；中性入口不导入 Node、SQLite/Drizzle 驱动或 Vue。独立整包无 Node VM、实际构建声明的 DOM/types=[] 闭包、真实 SQLite 与 Object.create/Proxy 子任务路径定向 5 文件 37 项通过；仍不包含手机数据库实现或独立运行完成声明。 中性适配最后代码的新 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及全部守卫、兼容、HLS、删除故障、Native 与 64 份文档通过；Host Agent 增至 129 项通过、1 项既有真实模型跳过保留，API 967、仓储 820、Worker 161 等既有包测试通过。随后只补本记录并复验文档，PR #333 的审查修正与精确提交远端门禁通过后已合入主线。

本轮固定 SQLite 3.54.1 官方 Android 制品，显式 HTTPS 恢复按固定长度/SHA3 验证，缺失/篡改阻断构建，不跟踪 AAR 或隐式下载；合并 Manifest 显式保持备份/明文网络关闭，AOSP/LLVM 许可随 APK 分发。新增原生隔离临时库探针及设备测试，覆盖 RETURNING、JSON/NUL、FTS5、FK、失败事务回滚与重开；没有注册 JS SQL 桥或接入 UI。唯一 Schema 制品保留现版本/指纹，main/ledger 分离，根生成器只产 main 资产；Android 编译期打入主库 DTO，设备测试在临时空库执行 DDL、回滚/结构与版本回执检查，不代替生产初始化或迁移。真实 Android SQL/16 KiB 设备运行仍未执行，现 UI 仍连 API。 本批先在旧基线全量通过，再合入已审查主线 `f94ebfd6`，最后重新 `./aervox ci all` 退出 0：构建 32、类型 56 个任务，API 983、仓储 829、Host Agent 129、Worker 161、客户端 234、CLI 149、UI 156 项通过，1 项既有真实模型跳过保留；守卫、兼容、HLS、删除故障、Native 及 64 文档通过。另有 33 移动脚本、8 生成器测试通过；实际 `android:build` 和 App 测试 APK 编译成功，最终调试 APK SHA256 `004ea67e2b211e18a02a879c32a6897d7c8964da0320dcc0faf1d877cdd06c98`，v2 签名、ZIP 16 KiB 对齐与 Manifest 两禁用核验通过。静态 ELF 仅两个 64 位 ABI 满足 16 KiB LOAD 对齐，不外推全部设备；缺失/篡改 AAR 的 Gradle 反例在隔离工程失败后恢复通过。依赖审计 0 未审阅、2 既有审阅、0 过时例外；随后仅补记录并复验文档，精确提交远端门禁由新 PR 保存。

原生凭据前置只提供固定模型槽位的本机 API：Keystore AES-GCM 包装密钥、私有 no-backup 密文、AAD 身份/版本、进程及文件锁和原子替换；旧密文认证前不覆盖，丢密钥及 backup/stage 不补建新密钥，中断保留证据并明确拒绝。显式清除覆盖三类文件、保留包装密钥，不接受外部路径/alias；未接 UI、JS Bridge 或模型网络。隔离设备测试覆盖密钥不可导出、随机 nonce、篡改/丢 key/中断/回滚与定长错误，编译和设备执行分别记录；设备、断电持久性、原生配置入口及真正模型桥仍待验收。 最后代码的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务、API 983、仓储 829、Host Agent 129、Worker 161 及既有客户端/界面测试、所有守卫/兼容/Native/64 文档通过，1 项真实模型跳过保留；App 与包含 11 项凭据用例的设备测试 APK 编译成功。独立复核无新增实质问题，补了 API 24 staging 文件清除的跨版本处理；设备 Keystore 用例未执行，不计为测试通过。随后只补记录并复验文档，新 PR 保存精确提交远端状态。

仓储接续提供 `/database` 的注入式装配，不创建连接、不初始化库，仍复用锁定 Drizzle 的 LibSQLSession 事务与关系；Node 默认准备/重连不变。实际文件 SQLite 代理验证接单/关系查询、CAS 整轮回滚、commit 前后失败都不重跑 callback，完整入口无 Node/远程连接创建器；现行声明消费者无 ambient Node，但上游 Drizzle 严格 DOM 声明闭包未通过，保留失败证据。该步骤不提供原生 Client；历史 Buffer 依赖由下列编码切片移除；crypto、Node 唤醒及问答宿主边界仍需接续，不能直接把整仓装入手机。 最后代码的新 `./aervox ci all` 退出 0，构建 32、类型 56 个任务、API 983、仓储 836、Host Agent 129、Worker 161 等既有包测试与守卫、兼容、HLS、删除故障、Native 和 64 份文档通过，1 项真实模型跳过保留；新 factory 与既有接单/队列/自愈定向 5 文件 47 项通过。严格上游声明失败如实保留，现行 skipLibCheck 消费者检查不是严格声明通过；随后仅补记录并复验文档，新 PR 保存精确提交远端结果。

历史读取接续将 UTF-8 字节预算和规范 base64url 游标提为纯 Web 编码工具，移除 Buffer；保留 BOM、NUL、未配对 UTF-16 替换、非法 UTF-8 拒绝、规范尾位及既有 16 KiB/页面预算语义。确定性全量短字节及长字节/字符串对照旧 Buffer 实现，真实 history 21 项与 codec 5 项通过；整读取入口在无 Buffer/process/require 的 VM 实际校验中文 NUL 游标后到达注入数据库。该变化不改变读取资格、游标或内容合同，也不提供手机持久 Client。 最后代码 `./aervox ci all` 退出 0，构建 32、类型 56 任务、仓储 841、API 983 及既有包测试、守卫/兼容/HLS/删除故障/Native/64 文档通过，1 项真实模型跳过保留；两文件 26 项定向及 codec 的严格 DOM/types=[] 检查通过。其严格声明只覆盖编码工具，不扩大为上游 Drizzle 或全部仓储声明已通过；随后仅补记录并复验文档，PR #337 的 `b10eaaeb` 已通过 5 项精确提交远端检查，仍待审查合入。

会话仓储进一步提炼 `/conversation` 的共享 SQL 命令，旧 Node 三个类及意图出口保留默认包装；显式 HostPort 提供同步哈希/UUID和提交后唤醒，没有默认散列或内存存储。原 canonical 意图/分支摘要、Error 身份及现有事务/删除/水位不变；格式错误或异步误接的原语拒绝且零部分接单，通知同步/异步失败不抹去已提交 Outbox。新整包入口不含 Node、Buffer、进程协调或 LibSQL 创建器，在无 Node VM 通过注入文件 SQLite 完成真实接单和历史读取；实际手机 Client/同步散列/问答宿主/内部 Transport 仍待装配。最后代码的 `./aervox ci all` 退出 0，构建 32、类型 56 任务、仓储 857、API 983、Host Agent 129、Worker 161 及既有包测试、守卫/兼容/HLS/删除故障/Native/64 文档通过，1 项真实模型跳过保留；4 文件 62 项定向、实际 dist 整包 VM 和无 ambient Node 的现行声明消费者通过。独立复核新增异步哈希误接的未处理拒绝反例，先红后绿，命令仍明确拒绝且零部分接单；严格上游 Drizzle 声明限制未隐藏。随后只补记录并复验文档，PR #338 的 `e87c6537` 已通过 5 项精确提交远端检查，仍待审查合入，不把宿主 Port 提炼当独立端完成。

原生候选值协议新增 `/native-sqlite-values`：区分 REAL、int64、文本、空值与二进制，以规范字符串保留大整数/字节；负零在 JSON 往返后保持，SQLite 溢出结果的正负 Infinity 与有限输入绑定分开。结果复用锁定 libsql 的位置/命名列描述和 rowid 缺失语义，畸形值与不安全整数明确拒绝。真实文件 SQLite → JSON → 注入 Drizzle 的类型/二进制/NUL 转义读取及负零、极值、重复/保留列对照通过；整个公开 dist 入口无 Node，编码入口的实际声明以严格 DOM/types=[]、无 ambient Node 编译通过，不扩大为 Drizzle 严格声明已通过。最后实现的 `./aervox ci all` 退出 0，构建 32、类型 56 任务、仓储 868、API 983、Host Agent 129、Worker 161 及既有包/守卫/兼容/HLS/删除故障/Native/64 文档通过，1 项真实模型跳过保留；定向两文件 18 项通过，补充规范尾换行拒绝夹具后 11 项协议测试再通过，审计 0 未审阅、2 既有审阅、0 过时例外。随后只补验证记录并复验文档，PR #339 的 `74374f1f` 已通过 5 项精确提交远端检查，仍待审查合入。该步骤尚未提供手机连接、SQL 桥、资源配额或设备结果，不替代原生 Client。

原生侧接续同一值编码和未注册的 `NativeMessageChannel`：固定 origin/主帧/WebView 身份、功能不支持即关闭、请求/响应字节及在途/深度限制；严格流式 JSON 检查先于对象递归解析，关闭后不向旧页回包。它只管理一个 WebView 生命周期，不能证明文档或 APK 资产来源；固定资产宿主及销毁重建接线仍须实现。共享 `/native-sqlite-client` 同时提供受限事务适配，根请求排在事务终态之后，未知回执保留写者并隔离准入，close 与已确认 drain 分开；明确拒绝的关闭竞态、同步清理失败重试和 batch 回滚失败有反例。真实文件 SQLite 代理验证原子接单/幂等、CAS/整批回滚、NUL 历史及 commit 回执丢失不重跑。最后实现的 `./aervox ci all` 退出 0：构建 32、类型 56 任务、仓储 893、API 983、Host Agent 129、Worker 161 及既有包/全部守卫/兼容/HLS/删除故障/Native/64 文档通过，1 项真实模型跳过保留；4 文件 59 项定向及实际公开 dist 的无 Node VM、编码/Client 严格 DOM 声明闭包通过，不能外推上游 Drizzle。Gradle App/设备测试 APK 编译成功，9 项 JVM 策略实际通过；新 17 项 Android 用例已编译。维护者接入 Android 17/API 37、arm64、4 KiB 真机，前置已通过且未发现已有同包应用，首次设备执行正在等待手机安装确认；未得到结果前不计设备测试通过。独立复核的 close 终态拒绝两时序反例先红后绿，修复再审无新增问题；依赖审计 0 未审阅、2 既有审阅、0 过时例外。随后只补本记录并复验文档，新 PR 保存精确提交远端结果。该步骤未接手机业务库、实际 SQL/模型命令或 UI，不代表原生独立闭环。

<a id="iter-016"></a>

### ITER-016 · 建议：所选单设备 PoC

依赖 ITER-009 价值决定，先设备 ADR/单一协议；音频/OCR 必须证明真实产物，独立算力盒另依赖 ITER-015。模拟器+一块开发板验证身份、ACK、幂等、截止、撤权、热插拔；设备缺席核心流程不受损，取得五至十人记录与价值证据，不以接口响应替代实物成功。

<a id="iter-018"></a>

### ITER-018 · 建议：第二终端与样机决策

仅在 ITER-016 价值成立后检验共享生命周期，再决定 PCB/结构/电源/小批；无线、电池、采集、运动另评审，PoC 不自动授权量产。两端不复制宿主，更新/回滚/删除可测；24→72 小时稳定、功耗温升、密钥/追溯/维修取证，发布另验。

<a id="iter-028"></a>

### ITER-028 · 待评审：纯本地加密同步探索

CAP-018/027，遵守[数据库契约](docs/reference/DATABASE.md)和 ADR-022，不引入中心化多租户库。承诺-揭示配对、Ed25519 设备身份、SAS transcript、分向密钥和 Changeset 原型已有，ITER-071 已隔离 sync-runtime/Changeset Port；真实 mDNS/生产接线/多设备未完成。

- **进入条件与验收：** 显式配对、端到端加密、`local_only`/混合来源范围、删除撤权传播先成立；UDP 多播发现+静态对端兜底，验证重放/乱序/篡改拒绝。以行时间水位+显式墓碑代替 Session Extension，接收白名单/漂移隔离/墓碑四向裁决，不复活已删数据；真实 Capacitor/Electron 同网直连学习进度/错题成功，不能据原型宣布多设备可用。

<a id="iter-021"></a>

### ITER-021 · 建议：HLS 可行性真实验证

依赖 ITER-020，[ADR-023](docs/reference/adr/ADR-023-hls-research-execution.md)已接受研究范围，CAP-007/020/027（探索）；研究执行器已合流 Core，真实模型/Vitis 镜像未配置，H1～H4 未启动。按[HLS 阶段条件](docs/how-to/run-hls-agent.md#hls-plugin-delivery) H1→H2→H4，H3 题集/协议可并行，只修实际复用路径。

- **验收：** 固定模型/镜像/环境，真实裸跑与 Agent 双入口、正反样例、隔离/杀停可复现；开发/留出按家族隔离，四组同配置/固定分母/独立样本/增益区间/成本完整。官方未公开判定保留缺口，按专项 §6.3 做继续、限定补证或暂缓决定，证据登记后才移交。

<a id="iter-022"></a>

### ITER-022 · 建议：HLS 扩大验证与冻结提交

仅在 ITER-021 支持继续、正式范围/必要 ADR 已评审且已取得最新细则和窗口后进入 S1～S3；AVX-EXPL-013 P3。正式评分 ABI/反馈、分级判定及独立 pass@1/pass@5 可追溯，最终 32 GB 目标环境满足预算，另一队员在干净断网环境复现双入口/哈希；包、依赖/模型/技能声明、失败/成本报告完整。实际赛事提交依窗口及用户授权，不自动包含产品化、微调或采购。

<a id="iter-043"></a>

### ITER-043 · 条件规划：HLS 可选插件产品化

仅当 ITER-022 竞赛证据完整、有真实学习/调试需求且产品范围/独立 ADR 接受后，进入 M1～M6；新增 CAP 待需求立项，目前未建独立仓/接产品或承诺工期，本条仅获规划授权。

- **范围与验收：** 非核心实现独立子仓经 `modules/*` workspace 消费，主仓单一接口/受信装配，默认不激活、不复制研究内核；公开题导入→生成/验证→诊断→取消/复盘/导出闭环，工具有真实 handler，权限/撤权阻断副作用。仅复用 ITER-004/005/006/007/008/013 必要合同，先补生命周期缺口；安装/升级失败、禁用/缺包/卸载/重装/回滚、实现缺席仍可导出/删除及竞赛双入口回归均需验证。

## 7. 设备与移动端的待决策项

ITER-009 先形成可审阅结论，以下建议不替用户选定产品或批准采购：

| 决策 | 建议起点 | 需要的证据 |
|---|---|---|
| 是否要求电脑关机后独立使用 | 先分别比较依赖现有电脑的配件与独立算力盒 | 典型使用时段、成本/能耗、维护能力与本地模型规格 |
| 首个硬件形态 | USB 桌宠、专注旋钮、电子纸卡可优先做低成本概念比较；语音/扫描由真实能力验证决定 | 用户价值、现有外设替代、Provider 真实性、无设备时流程完整性 |
| 移动端定位与平台 | 已选择独立端、Android 先行：电脑关闭仍可使用；接续验证手机本地运行时，再决定 Android 版本范围；iOS 后续另验 | 后台/权限限制、目标用户设备、本地 SQLite/密钥/迁移、打包与真实平台验收 |
| 同网连接与认证 | 明确发现、证书、设备凭据和撤销；不把同一 Wi-Fi 当作授权 | 当前 Token 与隐私契约中身份要求的差量及威胁评审 |
| 跨设备数据范围 | 普通资料与 local_only/混合来源严格分开 | 导出/同步授权、删除传播、离线期限与来源验证 |
| 第一版交互范围 | 从通知、图片、分享、只读复习中选择最小闭环 | 实际任务完成率与成本，不按接口数量决定范围 |

[ADR-022](docs/reference/adr/ADR-022-mobile-runtime-access.md#cr-055) 已接受独立运行、Android 先行及 M0 隔离原型：固定内置 SQLite、复用现有规则、原生持钥模型桥。候选仅准入隔离测试库，正式平台版本范围和工期未裁定，具体取舍在本节维护。

## 8. 已移交切片与历史证据

只保留已交付结果、证据与未关闭边界。ITER-003/053/059/061/062 的活动剩余已移到前文；其它切片的真实模型/设备/签名/发布限制继续有效，不因本次排序提高 CAP 状态。详细实施与失败日志见[计划快照](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/plan.md)及各 PR/CI。

<a id="iter-070"></a>

### ITER-070 · 已移交：PR 终审与文档现状归档

原授权 #307～#320 已依赖顺序合入并清理分支，保留工作树/归档标签/忽略资源/业务数据。[PR #313](https://github.com/3yearsZhuang/Aervox-harness/pull/313)补 Bundle 祖先 symlink 清理/回滚，[PR #314](https://github.com/3yearsZhuang/Aervox-harness/pull/314)补 ZIP 文件/目录/大小写冲突，[PR #316](https://github.com/3yearsZhuang/Aervox-harness/pull/316)补终态/水位一致快照；集成树 `263cdc99` 全量退出 0，精确提交远端检查分别保留。

[PR #321](https://github.com/3yearsZhuang/Aervox-harness/pull/321)修 Fastify `GHSA-389g-gv7q-r4x8` 至 5.12.6、删除已撤回 sprintf-js 豁免；最终全量通过，0 未审阅/2 既有审阅路径/0 过时例外，首次失败保留。[PR #322](https://github.com/3yearsZhuang/Aervox-harness/pull/322)交付 32 份现行 Markdown 与 63 文档门禁；归档仓 #2/#3/#4 先合入并清理，再由主仓移除历史材料。原字节哈希、稳定编号、失败及剩余验收见[归档包](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation)，无活动入站的 [CR-030 旧目标 ERD](https://github.com/3yearsZhuang/Aervox-docs-archive/blob/397d4b4bc924d1315205577ed4fb88a4df2c0619/archive/database-sqlite-erd-cr030-target.md)亦按原字节归档。ContextManifest 最小化、Page、恢复及真实环境限制已回到对应活动条目，未提高发布状态。

| 编号 | 结果 | 证据 |
|---|---|---|
| <a id="iter-001"></a>ITER-001 | 冷 CI、插件产物恢复与可重现验证；ARC-14/FND-10；CAP-020。 | [PR #221](https://github.com/3yearsZhuang/Aervox-harness/pull/221) |
| <a id="iter-002"></a>ITER-002 | 可靠接单剩余差量：Inbox 确认、Turn/Outbox 与 Attempt 的原子接单或可重放恢复；ARC-01；CAP-007。本轮意图摘要切片及子任务/完整审批续跑剩余边界见 ITER-071。 | [PR #265](https://github.com/3yearsZhuang/Aervox-harness/pull/265)、[PR #228](https://github.com/3yearsZhuang/Aervox-harness/pull/228)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-004"></a>ITER-004 | 三个独立修复：消息版本短事务/CAS，Config 与同库 Secret 一致提交，会话锁尾链回收；ARC-07、FND-02/07；CAP-013/020 | [PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-007"></a>ITER-007 | 三个切片：父子任务/Driver 继承取消、截止、删除/授权修订与 local-only；执行时逐项核对 requiredPermissions/grants 的 scope/revision，由受信宿主映射 guarded/full_access 安全等级；动态工具 Schema 快照进入模型请求并在执行时重验；ARC-02/03、插件规范 §8.1；CAP-007/020/033 | [PR #267](https://github.com/3yearsZhuang/Aervox-harness/pull/267)、[PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-008"></a>ITER-008 | 模型制品与进程：路径/symlink、响应与续传验证；启动 epoch、有界探针/日志/指标请求；ARC-11/12；本地模型基础设施 | [PR #266](https://github.com/3yearsZhuang/Aervox-harness/pull/266) |
| <a id="iter-014"></a>ITER-014 | 公开 Port、MemoryStore 试点与实现退出演练；ARC-10；CAP-005/007/020。 | [PR #230](https://github.com/3yearsZhuang/Aervox-harness/pull/230) |
| <a id="iter-020"></a>ITER-020 | HLS 竞赛验证规划；CAP-007/020/027。 | [PR #229](https://github.com/3yearsZhuang/Aervox-harness/pull/229) |
| <a id="iter-023"></a>ITER-023 | Build to Delete 与类 pi 架构规划；CR-056 历史材料见归档导航。 | [原交付登记](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) |
| <a id="iter-030"></a>ITER-030 | DSH、pi、AstrBot 固定版本更新与差异复评；CAP-007/020/027/033。 | [原交付登记](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) |
| <a id="iter-031"></a>ITER-031 | 标准工作台连续对话与雾蓝视觉重构；CAP-001/002/018。 | [PR #233](https://github.com/3yearsZhuang/Aervox-harness/pull/233) |
| <a id="iter-034"></a>ITER-034 | ControlContext、abortable 与 ApprovalPolicyPort 内核构件及 executor 接线；ITER-007/013。 | [PR #241](https://github.com/3yearsZhuang/Aervox-harness/pull/241) |
| <a id="iter-035"></a>ITER-035 | 建立独立 @aervox/core、内存 HostToolRuntime、轻量出口与分层许可证；ADR-021。 | [PR #244](https://github.com/3yearsZhuang/Aervox-harness/pull/244) |
| <a id="iter-036"></a>ITER-036 | 伴学 Prompt、工具契约与宿主 guidance 迁出内核，收窄内核导出面；ADR-021。 | [PR #245](https://github.com/3yearsZhuang/Aervox-harness/pull/245) |
| <a id="iter-037"></a>ITER-037 | 移除 agent-loop/cli-approval 过渡壳，下游直连 core，内核类型自持与边界守卫；ADR-021。 | [PR #248](https://github.com/3yearsZhuang/Aervox-harness/pull/248) |
| <a id="iter-038"></a>ITER-038 | Provider stopReason 归一与输入/输出 usage 分账；ITER-033 拆分切片。 | [PR #247](https://github.com/3yearsZhuang/Aervox-harness/pull/247) |
| <a id="iter-039"></a>ITER-039 | 内核对标增强（PI-01 pi-ai 对比结论，2026-10-03 内核自查）：①截断 fail-closed——消费 `ModelStopReason=length` 并整批拒绝截断工具调用（含参数不完整），补 Provider 边界坏响应夹具；②usage 缓存/成本分账——`ModelUsage` 扩展 cacheRead/cacheWrite（透传 OpenAI `cached_tokens`），支撑 ModelRun 埋点与成本治理（T-10） | [PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-041"></a>ITER-041 | 拆分 executor 流式收集、工具管线与终态收口，统一审批裁决。 | [PR #249](https://github.com/3yearsZhuang/Aervox-harness/pull/249) |
| <a id="iter-042"></a>ITER-042 | ExecuteResult interrupted 与 AttemptStatus 对齐，保留 reason；持久化枚举不变。 | [PR #251](https://github.com/3yearsZhuang/Aervox-harness/pull/251) |
| <a id="iter-044"></a>ITER-044 | 2026-10-08 Core 审核整改第 1/5 迭代：执行正确性收口。修复审批等待后的取消/租约竞态、模型截断工具执行、父子控制传播和 next-step Inbox 丢失；结构化工具超时原因；原队列相关范围：ITER-007/ITER-039 | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-045"></a>ITER-045 | 2026-10-08 Core 审核整改第 2/5 迭代：工具运行时与合同收敛。API 复用 core HostToolRuntime，保留 SQLite 注册表和业务授权；跨内存/API 适配验证门控、撤权与取消；原队列相关范围：ITER-007/ITER-040 | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-046"></a>ITER-046 | 2026-10-08 Core 审核整改第 3/5 迭代：上下文与有界流式。动态工具受权快照、最终请求容量检查、工具组完整压缩、有界安全正文窗口与静默源取消；原队列相关范围：ITER-032/ITER-013 | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-047"></a>ITER-047 | 2026-10-08 Core 审核整改第 4/5 迭代：恢复与 Provider 合同。修复 Resume 完整账本/最新意图/事件高水位并验证宿主接线；统一模型能力、终止与用量合同；原队列相关范围：ITER-010/ITER-033 | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-048"></a>ITER-048 | 2026-10-08 Core 审核整改第 5/5 迭代：性能基线与发行边界。建立首段可见/取消/缓冲内存与 SQLite 写竞争可复跑基线；整理 core 稳定公共出口及兼容说明；原队列相关范围：ITER-017/ITER-027 | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-049"></a>ITER-049 | 项目代码质量、仓库卫生与文档多源偏移审计；收敛入口规则、当前实现和历史证据，压缩重复叙述。 | [PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-050"></a>ITER-050 | PR #258 审计发现落地：删除效果验证、原子接单/组合写入、动态工具取消、取消恢复、锁回收与资产单源；关联 ITER-002/003/004/007/010/017。 | [PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-051"></a>ITER-051 | 参考审计首批正确性修复：消息/配置原子写入、锁尾链回收、Memory 清理验证与召回资格、模型异常终止与逐调用快照、插件包预检；对应 ITER-003/004/005/007/039。 | [PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258)、[PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-052"></a>ITER-052 | 框架解耦审计整改：事件传输与平台能力注入、插件实例生命周期、API 窄依赖、日记素材访问、内核提示词策略与边界守卫；CAP-002/007/018/020。 | [PR #262](https://github.com/3yearsZhuang/Aervox-harness/pull/262) |

| <a id="iter-054"></a>ITER-054 | 薄 UI 宿主、工作台/桌宠插件及平台组合根；ADR-025。 | [PR #275](https://github.com/3yearsZhuang/Aervox-harness/pull/275) |
| <a id="iter-055"></a>ITER-055 | UISurfaceManifest、加载重试/降级、设置插件与设计令牌；第三方开放另见 ITER-056。 | [PR #275](https://github.com/3yearsZhuang/Aervox-harness/pull/275) |
| <a id="iter-057"></a>ITER-057 | 终态一致、密集正文窗口与准备取消；基准使用假 Provider/内存存储。 | [PR #274](https://github.com/3yearsZhuang/Aervox-harness/pull/274) |
| <a id="iter-058"></a>ITER-058 | 文档体系精简、事实源与稳定编号收敛；详细旧记录见归档快照。 | [历史记录](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/plan.md#iter-058) |
| <a id="iter-060"></a>ITER-060 | HYG-01～14 卫生整改及插件生命周期前置；全量门禁和远端检查已通过。Worker 其余预算留 ITER-013，依赖例外继续审阅。 | [PR #277](https://github.com/3yearsZhuang/Aervox-harness/pull/277)、[原审计](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/docs/explanation/repository-hygiene-audit-2026-10-13.md) |
| <a id="iter-063"></a>ITER-063 | 本地认证、Problem Details、共享端点、路由棘轮与插件生命周期；余下历史路由、Page Token、第三方代码/UI开放分别留 ITER-064/006/019/056。 | [PR #281](https://github.com/3yearsZhuang/Aervox-harness/pull/281)、[PR #283](https://github.com/3yearsZhuang/Aervox-harness/pull/283) |
| <a id="iter-065"></a>ITER-065 | 记忆删除质量研究与两轮实验已归档；按批准方案接续双语论文重构、单因素规模与守卫成本研究消融，原始证据保持封存。有界实验不构成完整生产删除或外部独立复现。 | [研究归档](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/main/memory-deletion-study) |
| <a id="iter-066"></a>ITER-066 | 异步删除故障测试生成器、输入校验与研究门禁；两次失败尝试和一次清理预算工程修订均保留，方法收益结论仍为 NOT ESTABLISHED。 | [PR #288](https://github.com/3yearsZhuang/Aervox-harness/pull/288)、[归档 PR #2](https://github.com/3yearsZhuang/Aervox-docs-archive/pull/2) |
| <a id="iter-067"></a>ITER-067 | workspace/清理/数据目录/资源/研究依赖/宿主出口/许可及跟踪卫生整改；Vitest 新公告由 #320 精确升至 4.1.12，未加豁免。 | [PR #289](https://github.com/3yearsZhuang/Aervox-harness/pull/289)、[PR #320](https://github.com/3yearsZhuang/Aervox-harness/pull/320) |
| <a id="iter-068"></a>ITER-068 | 工具参数合同、开发启动器/URI/终端体验，以及并行 README/经典桌面布局已交付；#307/#308 合并后对应分支清理，#306 既有并行工作树保留。 | [PR #295](https://github.com/3yearsZhuang/Aervox-harness/pull/295)～[PR #308](https://github.com/3yearsZhuang/Aervox-harness/pull/308) |
| <a id="iter-069"></a>ITER-069 | open Host/Origin 与 Token 预检、DSH 文件/命令取消、Electron IPC/导航及 Page 文件/清理边界；合成浏览器、Electron、临时存储回归与全量门禁通过，主动同 OS 祖先交换及外部副作用撤回不在隔离保证内。 | [PR #309](https://github.com/3yearsZhuang/Aervox-harness/pull/309)、[PR #310](https://github.com/3yearsZhuang/Aervox-harness/pull/310)、[PR #312](https://github.com/3yearsZhuang/Aervox-harness/pull/312)、[PR #313](https://github.com/3yearsZhuang/Aervox-harness/pull/313) |
