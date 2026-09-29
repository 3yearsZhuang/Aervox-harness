---
id: AVX-PLAN-001
type: reference
scope: guide
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
planning_role: current
version: 0.5.2
updated_at: 2026-09-29
reviewed_at: 2026-09-29
review_interval_days: 7
review_triggers:
  - apps/**/src/**
  - packages/**/src/**
  - plugins/**
  - docs/reference/changes/**
  - docs/reference/adr/**
  - docs/explanation/**
  - .github/workflows/**
sources:
  - docs/reference/document-governance.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/reference/plugin-config-and-pages.md
  - docs/explanation/foundation-optimization-review.md
  - docs/explanation/architecture-implementation-review.md
  - docs/explanation/companion-hardware-directions.md
  - docs/explanation/hls-agent-competition-plan.md
  - docs/reference/changes/CR-056-build-to-delete-pi-style-architecture.md
  - docs/reference/adr/ADR-020-aervox-core-decoupling.md
---

# Aervox 当前迭代计划

- 提出人：3yearszhuang · 2026-09-18
- 修改人：3yearszhuang · 2026-09-29

本文件是**当前项目迭代建议、排序、依赖和待决策项的唯一权威入口**。维护字段、状态、分支协调与归档规则见[计划治理](docs/reference/document-governance.md#31-当前迭代计划的唯一入口)；产品范围见 [PRD](docs/reference/PRD.md)，决策见 [ADR/CR](docs/reference/adr/README.md)，实现与发布证据见[追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)。计划的优先级不改写这些契约，也不自动批准所有条目实施。

## 1. 本轮目标与起点

本轮建议聚焦“可信的本地执行底座 + 可验证的插件生命周期 + 配套设备方向选择”。继续采用本地单用户 SQLite 和模块化单体，先处理已确认的正确性问题，再以固定负载决定性能优化是否值得。没有测量依据时不启动数据库替换、全局单写者或整体微服务化。

输入基线为 `6b20e7e` 及 2026-09-18 的代码评估。已完成的准备工作是[插件开发规范](docs/reference/plugin-config-and-pages.md)、[开发指南](docs/how-to/develop-plugin-ui-extension.md)、[底层评估](docs/explanation/foundation-optimization-review.md)、[架构深入评估](docs/explanation/architecture-implementation-review.md)和[九个硬件方向评估](docs/explanation/companion-hardware-directions.md)。这些是规范与证据交付，下面的业务修复与设备原型均尚未开工；评估中的历史测试结果不能替代修复后的回归与发布验证。

**建议先启动 ITER-001、002、003、008 的范围复核与独立修复，认领后同时在制不超过 3 个工作包。** ITER-009 的产品访谈/方案比较可并行。CI 工作是合入验证前置，方案审阅和局部故障修复无需等它完成；涉及新契约的切片先完成 CR。每个工作包可拆多个小 PR，避免把整张表变成一次大重构。

角色均为建议责任，不代表已分配给具体个人。认领时在真源中填写责任人、分支与状态（`docs/_meta/plan-queue.json`）；没有日期承诺的项目不推算截止时间。状态解释：建议 → 待评审或就绪 → 执行中 → 已移交，暂停需写阻碍；已移交必须给出证据，不能据此宣布 Released。

2026-09-22 新增 [HLS 竞赛规划](docs/explanation/hls-agent-competition-plan.md)：ITER-020 仅交付规划，ITER-021 为可行性验证建议，ITER-022 为正向证据成立后的提交候选。三人/C++/RX 9070 XT 是范围输入；具体认领、期限、云配额和实现 CR 仍须在对应条目明确，不改变已有正确性修复的排序。

2026-09-28 新增 [CR-056 Build to Delete 与类 pi 分层架构规划](docs/reference/changes/CR-056-build-to-delete-pi-style-architecture.md)：ITER-023 仅交付详细规划，ITER-014 进入架构差量待评审。CR 的切片按主归属和协同关系接入 ITER-005/007/008/013/014/019，具体依赖见 CR §7；先以 MemoryStore 工具与单个模型 Driver 验证实现可替换、资源可释放和数据责任连续性。规划不启动重构，也不将已有正确性修复统一阻塞在架构工作上。

2026-09-29 新增架构演进与深层瓶颈优化建议（ITER-025～028）：针对 ADR-020 解耦落地的剩余差量与深层性能瓶颈，提出思隅核心懒加载毫秒级冷启动（ITER-025）、伴学业务与会话执行器深度解耦插件化（ITER-026）、多进程 SQLite 写入并发与 Worker 自适应退避（ITER-027），以及纯本地多端点对点加密同步探索（ITER-028）。

2026-09-29 新增[思隅 CLI 完整落地规划](#siyu-cli-delivery-plan)：ITER-029 交付规划，ITER-030～036 分别覆盖范围与合同、连接版基础、伴学与数据操作、连接版发布、共享应用装配、独立宿主及独立版发布。优先以连接现有本地服务的终端入口验证学习价值，再根据独立使用需求推进 Core 宿主。两种形态分别验收和发布，不调整已有正确性工作的优先级，不将本次规划登记为 CLI 已实现。

## 2. 当前建议工作

下表是唯一活动队列，**由 `docs/_meta/plan-queue.json` 渲染生成**（改条目请改真源后运行 `mise tasks run plan-render`，校验见 `plan-check`）。每行“建议”表示尚未开工；“依赖”约束实际启用/交付顺序，前置设计与测试夹具可并行。证据编号 `FND-*` 见底层评估，`ARC-*` 见架构深入评估，不创建另一份问题正文。

<!-- plan-queue:begin · 本区由 `mise tasks run plan-render` 从 docs/_meta/plan-queue.json 生成，请勿手改 -->

### 2.1 第一批：正确性、验证入口与方向决策

| 条目 / 状态 | 最小交付与依据 | 依赖及 CR 门槛 | 完成判定 | 建议责任（待认领） |
|---|---|---|---|---|
| <a id="iter-001"></a>ITER-001 · 已移交 | 冷 CI 与插件验证：各 Job 锁文件安装、插件制品生成、工作流触发与 Turbo 输入；ARC-14、FND-10；基础设施/CAP-020 | 可独立修复；不借此开启已有禁用的资产缓存 | 干净 checkout 通过（显式锁文件安装，不依赖 pnpm 隐式安装）；仅插件变动会重新验证（工作流触发、Turbo 输入与增量选择三层同源）；删除生成物后由声明任务恢复，且产物字节可重现（校验：`scripts/ci-scope.test.mjs`；`scripts/export-plugins.test.mjs`；`.github/workflows/ci.yml` 的 frozen lockfile 与 plugin bundles 步骤） | quality/release（分支 `fix/iter-001-ci-verification-entry`；2026-09-18 移交：PR #221 冷 CI 全绿（Install/build/typecheck 5m23s、E2E 1m25s、Docs 24s），三条验收均有机会证据；合并后由 §4.2 记录交付） |
| <a id="iter-002"></a>ITER-002 · 已移交 | 可靠接单与 Outbox：先修消费者抢先完成，再闭合 Turn/Attempt/Inbox/可重放输入与受控派发；ARC-01、FND-01/05；CAP-007 | 拆为消费修复与调度切片；新状态、容量/接单语义或多订阅契约先 CR | 提交、预加载、claim 各点中断后已受理任务可追踪；无永久未领取孤儿，不重复消费/副作用（校验：`apps/worker/test/outbox-worker.test.ts`；`apps/api/test/conversation-dispatch-resilience.test.ts`） | platform（分支 `fix/iter-002-reliable-dispatch-and-outbox`；2026-09-18 移交：完成两阶段切片闭环——切片一修复 Outbox 消费归属、事件类型隔离、死信转移与抢先完成防御（FND-01）；切片二闭合 Turn/Attempt 预加载异常状态终态化与未认领孤儿 Attempt 扫描恢复（ARC-01）；测试用例 apps/worker/test/outbox-worker.test.ts 与 apps/api/test/conversation-dispatch-resilience.test.ts 全绿，./aervox ci 通过） |
| <a id="iter-003"></a>ITER-003 · 建议 | 删除效果与召回资格：先做 Memory 及其索引的完整清理/独立验证切片，检查期限、用途、撤权与 Restricted；ARC-06/08；CAP-005/013/027/033 | 已有隐私契约的修复先做；扩大删除范围或改变保留/恢复语义先 CR；失败继续拒绝受影响范围 | completed 有可重做的清理证据；空目标有明确依据；失败/未知不解闸；混合夹具越权结果为零 | data/privacy |
| <a id="iter-004"></a>ITER-004 · 建议 | 三个独立修复：消息版本短事务/CAS，Config 与同库 Secret 一致提交，会话锁尾链回收；ARC-07、FND-02/07；CAP-013/020 | 不引入全局通用事务框架；外部 Secret 补偿或历史数据转换单独评审 | 故障仅留完整旧/新版；同 revision 最多一次成功；409 不改 Secret；一万个 key 完成后锁缓存清空 | data |
| <a id="iter-005"></a>ITER-005 · 执行中 | 插件可恢复升级：全部入口校验、展开配额、staging 验证与激活、旧配置/Secret/授权保留；FND-02/04、插件规范；CAP-020。2026-09-18 追加差量：导出分发包可重现（细节见 §4.2 剩余差量，不在本表复述） | 激活依赖 ITER-004；限制资源可先做；升级/卸载状态和迁移语义先 CR | 成功意味着全部声明入口可用；超额包有界失败；任一安装阶段中断后可恢复完整旧/新版；同源码导出分发包的字节与校验和稳定 | ecosystem（分支 `docs/build-to-delete-pi-architecture-plan`；2026-09-28 CR-056 BTD-02 缺包保护切片：可用性独立于用户开关，新增兼容字段保留数据；原升级验收仍保留） |
| <a id="iter-006"></a>ITER-006 · 建议 | Page 与客户端认证：iframe source/nonce/会话/全部 capability、禁用撤权；附件 Bearer、合法预检与受限 Page 资源通道；FND-03、ARC-13；CAP-018/020 | 既有认证漏接可独立修；新页面凭据及 Origin 信任策略先 CR | 错误窗口/旧响应/无权/禁用访问无副作用；合法 Token 模式的 JSON、SSE、Page、附件可用，凭据不进入 URL | ecosystem/desktop |
| <a id="iter-007"></a>ITER-007 · 待评审 | 三个切片：父子任务/Driver 继承取消、截止、删除/授权修订与 local-only；执行时逐项核对 requiredPermissions/grants 的 scope/revision，由受信宿主映射 guarded/full_access 安全等级；动态工具 Schema 快照进入模型请求并在执行时重验；ARC-02/03、插件规范 §8.1；CAP-007/020/033 | 既有策略接线优先；动态工具开放依赖真实 grant/审批校验及最终输入容量检查；新根预算与 Driver/授权合同先 CR；进一步压缩与成本优化留 ITER-017 | 父取消后不进入子下一步；本地任务拒绝远程 Provider；工具可见；缺权限、错 scope、旧 revision、撤权/禁用和未批准写操作无副作用；最终输入加预留输出不超 Provider 窗口，超额有明确有界处理 | platform/ecosystem（分支 `feat/aervox-core-evolution`；2026-09-29 PR #231 缺陷修复已通过定向验收：预算执行、父子控制、生产取消/本地限制及原子终态；第二轮复核修复取消/预算收敛时序与审批有界等待；完整权限和模型窗口验收仍待完成，证据见 CR-056 §10.4–§10.5 / §4.2） |
| <a id="iter-008"></a>ITER-008 · 执行中 | 模型制品与进程：路径/symlink、响应与续传验证；启动 epoch、有界探针/日志/指标请求；ARC-11/12；本地模型基础设施 | 正确性修复可独立进行；制品来源/信任等级变化先 CR | 不写出模型根、不注册错误正文/错位字节；旧 exit 不污染新进程；悬挂探针按期结束；停止状态真实 | platform（分支 `docs/build-to-delete-pi-architecture-plan`；2026-09-28 CR-056 BTD-04 模型 Driver 替换与代际生命周期已落地并通过扩展 SPI 4 项测试，下载其余正确性要求仍保留） |
| <a id="iter-009"></a>ITER-009 · 建议 | 配套形态决策：比较九个硬件方向、电脑依赖、目标 OS、真实 Provider、成本和数据边界；同时登记移动端草稿待决策事项；CAP-001/012/018/025/030/033 | 本项仅探索与样本验证；不默认批准采购、SKU、固件、移动端顺序或工期 | 有候选比较、继续/暂缓证据和一至两个验证方向；明确 §3 的待决策项与 ITER-016 范围 | product-hardware/desktop |
| <a id="iter-020"></a>ITER-020 · 已移交 | HLS 本地智能体竞赛规划：三人团队、C++ 与 RX 9070 XT 条件下的能力复用、验证路径、实验协议和交付边界；AVX-EXPL-013；关联 CAP-007/020/027（规划，不改变能力状态） | 本项仅文档交付；赛规、实测、实现授权和产品化分别判断，后续实验见 ITER-021 | 专项文档明确规则与环境、双入口、对照实验、冻结提交和产品回接路径；三人角色、预算估算、去留标准、来源和索引齐全，文档门禁通过 | platform/docs（分支 `docs/hls-competition-validation-plan`；2026-09-22 文档移交：P0～P4 路径、三人角色、四组对照、冻结产物与去留标准已登记；ci-docs 全量通过（治理回归 33/33、队列回归 9/9、78 文件排版/术语及严格治理无问题）；未实施竞赛能力） |
| <a id="iter-021"></a>ITER-021 · 建议 | HLS 竞赛可行性验证：规则与环境核对、双入口最小闭环、同模型配对对照与去留证据；AVX-EXPL-013 P0～P2；关联 CAP-007/020/027（探索） | 依据 ITER-020 的规划复核范围与可投入工时；新增模块/工具合同先 CR；只修实际复用路径，不等待 ITER-007/008/013 全部完成 | 本地模型与 Vitis 真正运行，裸跑/Agent 双入口公平且逐题可追溯；留出题报告分级通过率、增益、不确定性与成本，并给出继续、限定补证或暂缓结论 | platform/competition（模型环境、HLS 工具、Agent 评测三个角色，待认领） |
| <a id="iter-023"></a>ITER-023 · 已移交 | Build to Delete 与类 pi 架构详细规划：[CR-056](docs/reference/changes/CR-056-build-to-delete-pi-style-architecture.md) 的固定基线、目标边界、决策差量、实施切片、退出验收与回滚；关联 CAP-002/005/007/018/020/027/033（仅规划） | 本项仅交付 Proposed/Planned 的 CR；实现认领继续使用既有 ITER 条目，架构接受、代码实施和发布分别判断 | 每个切片给出输入依赖、代码落点、契约影响、测试、退出条件与回滚；规划接入唯一队列、追踪和索引，文档门禁通过 | platform/docs（分支 `docs/build-to-delete-pi-architecture-plan`；2026-09-28 文档移交：CR-056 的九个切片、两项试点、依赖估算及退出/回滚验收已登记；ci-docs 全量通过（治理 33/33、队列 9/9、79 文件排版/术语及严格治理无问题）；CR 保持 Proposed/Planned，未启动业务重构） |
| <a id="iter-024"></a>ITER-024 · 已移交 | Aervox Core 架构解耦与演进落地：ExecutionPipeline 洋葱中间件、ApprovalPolicyPort 三端人机回环 SPI、HostToolRuntime 沙箱容器下沉与 Headless Agent 内核验证；关联 ADR-020、CR-056 | 遵循单用户本地架构；保持 18 包 100% 测试通过率；无 boundary guard 回归；通过自动化 smoke 验证 | ExecutionPipeline 洋葱中间件链解耦 agent-executor 编排关注点（指标、安全守卫、插件生命周期、主动策略）；ApprovalPolicyPort SPI 统一 CLI、Web/SSE 与无头测试的人机回环审批策略；HostToolRuntime 工具沙箱容器与代际调度下沉至 host-agent 并由 API 层薄适配继承；Headless Agent 具备轻量冷启动与独立运行能力，零数据库与零 Fastify 侵入（校验：`node scripts/run-headless-agent.mjs --smoke`；`packages/host-agent/test/pipeline.test.ts`；`packages/agent-loop/test/approval-policy.test.ts`；`packages/host-agent/test/cli-approval.test.ts`；`packages/host-agent/test/host-tool-runtime.test.ts`；`./aervox ci`） | platform/runtime（分支 `feat/aervox-core-evolution`；2026-09-29 移交：Phase 1-4 全部实施完成，中间件链、三端审批 SPI、工具沙箱下沉与独立 Headless 验证全绿；ADR-020 已归档接受；第二轮复核补齐调用时门禁与入参沙箱加固，证据见 CR-056 §10.5；§4.2 完成登记） |
| <a id="iter-025"></a>ITER-025 · 已移交 | Aervox Core 懒加载与毫秒级冷启动：解耦顶级重型依赖导入，消灭 1440ms 启动警告，压减模块导入开销至 100ms 内；基础设施/ADR-020 | 不破坏既有 Headless 7 步验证；不引入未经验证的打包器私有运行时 | `node scripts/run-headless-agent.mjs --smoke` 内核加载耗时稳定收敛至 <= 150ms（消除 WARN 警告）；未触碰数据库与持久层时，零加载 @libsql/client、Drizzle Schema 与重型 Fastify 插件；apps/api 73 套件模块静态解析耗时显著降低（校验：`node scripts/run-headless-agent.mjs --smoke`；`./aervox test fast`） | platform/runtime（分支 `feat/aervox-core-evolution`；2026-09-29 移交：完成子路径按需导出与重型依赖解耦（@aervox/repositories/errors、@aervox/schema/audit 与 @aervox/host-agent/core）；run-headless-agent 内核加载耗时从 1440ms 降至 20ms（提速 98.6%，告警消除）；73 套件 485 测试在内的 check-affected 全绿；§4.2 完成登记） |
| <a id="iter-029"></a>ITER-029 · 已移交 | 思隅 CLI 完整落地规划：连接本地服务与 Core 独立运行两种形态、命令范围、阶段依赖、验收及发布回滚；详见[§7](#siyu-cli-delivery-plan)，关联 CAP-002/003/005/006/007/009/013/016/019/020/027（仅规划） | 本项仅交付规划；产品与架构合同由 ITER-030 复核，实施与发布分别认领，不改变已有 CAP 或 ADR 状态 | 两种运行形态的数据归属、受信工具与恢复边界明确；实施切片接入唯一队列，契约复核、真实验证和发布门槛可追踪；§4.2 登记规划交付，派生视图及文档门禁通过 | platform/product/docs（分支 `docs/siyu-cli-plan`；2026-09-29 文档移交：完整规划与 ITER-030～036 已入队；ci-docs 全量通过，保留既有 ITER-005 的 S5 提示；后续实现待认领，证据见 §4.2） |
| <a id="iter-030"></a>ITER-030 · 已移交 | CLI 首个连接版合同：命令/输入输出、认证配置、审批取消、macOS arm64 开发预览与既有 API 数据归属；[CR-058](docs/reference/changes/CR-058-siyu-cli-attached-client.md)；其余命令与独立形态继续按 §7 规格化 | 用户已授权实施；CR-058 接受终端连接版首片；独立宿主/发布矩阵/新增业务 API 不在本次合同移交内 | 首片命令映射已有 API，错误/配额/审批/幂等/取消可测试，未提供接口的命令明确保留缺口；固定 siyu/@aervox/cli、macOS arm64 + Node.js 24 开发预览、凭据与 API 数据责任；完整平台分发矩阵归 ITER-033，独立形态合同归 ITER-034/035 | 3yearszhuang / platform（分支 `feat/siyu-cli`；2026-09-29 首片合同及验证已移交，CR-058/PRD/架构/流式协议同步；实现证据见 §4.2；不等同于完整 CLI 或发布） |

### 2.2 下一批：恢复、生命周期与部署

| 条目 / 状态 | 最小交付与依据 | 依赖及 CR 门槛 | 完成判定 | 建议责任（待认领） |
|---|---|---|---|---|
| <a id="iter-010"></a>ITER-010 · 建议 | 先修 Resume 库覆盖/事件高水位/执行关联/接管；再接审批与答案续跑、撤权账本及恢复水位；ARC-04/06；CAP-007/027/033 | 依赖 ITER-002/003/007 的必要切片；续跑、一次性授权/有效期、跨库恢复和账本保留先 CR；不直接启用现有 Resume Host | 缺账本、多工具、跨进程答案、重复接管与旧备份恢复不重复副作用、不吞答案、不复活撤权；未知结果不盲重放 | platform/data |
| <a id="iter-011"></a>ITER-011 · 建议 | 完整 Schema 迁移：排除 FTS shadow 表、真源重建；接线版本 journal、校验和、恢复状态；ARC-09；CAP-027 | 完整库失败夹具可立即补；迁移协调方案先评审，破坏性转换先 CR，生产操作另过门禁 | 每个支持旧版本升级、失败恢复、回滚通过；主库/Vault/账本归属明确；源库不受 staging 失败影响 | data/quality |
| <a id="iter-012"></a>ITER-012 · 建议 | 索引生命周期：dirty/reindex、来源修订、模型/维度版本、可切换投影；修可选回填旧列；中文固定语料；ARC-08；CAP-005/026 | 依赖 ITER-003；当前错误 SQL 可先修；投影切换和模型版本合同先评审，不能恢复旧隔离列 | 故障可追平；A→B→A 可切换；资格零越界；单列中文 Recall@K、空间、重建成本 | data |
| <a id="iter-013"></a>ITER-013 · 待评审 | 有界运行和观测：Worker/Host drain、Provider 排队/取消、安全文本窗口、SSE 背压/分页、跨进程终态；复用 metrics；ARC-05/12、FND-05/06/09；CAP-007/018 | 依赖 ITER-002/008 的相关切片；先观测后定参数；跨进程通知/新隔离边界先 CR | 慢源/慢客户端和日志洪泛资源有界；停机有截止；已提交窗口提前可读；故障可定位 | platform/quality（分支 `feat/aervox-core-evolution`；2026-09-29 PR #231 已修复 Host 有界停机、实时/回放投影、Fetch 重连与真实组件旧流隔离；第二轮复核补齐审批有界等待；SSE 背压/分页、跨进程恢复及生产资源全范围仍未移交，证据见 CR-056 §10.4–§10.5 / §4.2） |
| <a id="iter-014"></a>ITER-014 · 已移交 | 模块公开 Port 与 Build to Delete：评审 ADR-014 的通信/装配差量，建立试点模块边界、MemoryStore 贡献与退出演练；ARC-10、[CR-056](docs/reference/changes/CR-056-build-to-delete-pi-style-architecture.md)；CAP-005/007/020 与架构基础设施 | CR-056 相关决策先接受；模型 Driver 归 ITER-008，生命周期/控制协同 ITER-005/007/013；不要求先改完全部模块，也不阻塞已有缺陷修复 | 私有引用 fixture 失败、公开 Port 通过、模块可用 Fake Port 测试；实际依赖与批准规则一致；临时检出移除试点实现后非目标能力通过，资源无残留且数据权利连续 | platform（分支 `docs/build-to-delete-pi-architecture-plan`；2026-09-29 PR #230 四项审查阻断已修复并补证：生命周期/AST 回归与三阶段 11 包零缓存物理退出构建，真实 SQLite 数据权利和恢复通过；具体证据及发布限制见 CR-056 §10.2 / §4.2） |
| <a id="iter-015"></a>ITER-015 · 建议 | 单机部署主管：API/Worker/模型归属，数据目录、端口、Token、版本、就绪与退出；ARC-13；CAP-001/018/027 | 依赖 ITER-006/008 与 ITER-011/013 的必要部分；新主管先 CR；与移动端决策协调 | 干净用户目录安装、升级、异常退出、端口占用、磁盘满、卸载保留数据均验证；签名/公证/平台矩阵另过发布门禁 | desktop/release |
| <a id="iter-016"></a>ITER-016 · 建议 | 已选方向单设备 PoC：真实能力样本，模拟器与一块开发板，身份/ACK/幂等/截止/撤权/热插拔；硬件评估；复用所选 CAP | 依赖 ITER-009 决策；先设备 CR/ADR/单一协议；音频/OCR 先证明真实产物；独立算力盒额外依赖 ITER-015 | 设备缺席不破坏核心流程；获得五至十人使用记录及方向对应价值证据；不把接口响应当实物成功 | product-hardware/platform |
| <a id="iter-026"></a>ITER-026 · 已移交 | 伴学业务与会话执行器深度解耦：extractStudyTerms、PracticeAttempt 与 MemoryRecall 插件化/中间件化；CAP-002/007/016；ADR-020 | 保持既有 API 行为与契约 100% 兼容；通过既有 quiz-mode、study-term-plugins 等集成测试 | agent-executor.ts 聚焦于纯粹的 LLM + 工具多轮驱动，代码行数收敛 50% 以上；术语提取转为独立 TurnMiddleware（afterTurn 异步管道处理）；刷题出题判定转为声明式插件工具 Contribution，移除执行器硬编码逻辑（校验：`apps/api/test/quiz-mode.test.ts`；`apps/api/test/study-term-plugins.test.ts`；`apps/api/test/conversation-loop.test.ts`） | companion/learning（分支 `feat/aervox-core-evolution`；2026-09-29 移交：agent-executor.ts 代码行数由 473 行收敛 54% 至 217 行，职责纯粹聚焦于 LLM+工具多轮循环；记忆召回与上下文组装收敛至 context-builder.ts；工具组合声明化收敛至 tool-providers.ts；管道与独立术语提取中间件收敛至 pipeline-middlewares.ts；quiz-mode、study-term-plugins 与 conversation-loop 全套测试全绿；§4.2 完成登记） |
| <a id="iter-027"></a>ITER-027 · 建议 | 多进程 SQLite 写入并发与 Worker 自适应退避：消除高频空轮询，流式会话写入期间后台任务自适应降频与 IPC 唤醒；ARC-05/FND-07；基础设施 | 依赖 ITER-002 的 Outbox 消费修复；不破坏 WAL 模式快照隔离与单写者约束 | API 执行多轮密集对话与流式写入期间，Worker 自动退避至 3s+ 低频轮询，写锁冲突率降至 0；探索基于本地 Domain Socket 或命名管道的事件驱动触发式唤醒，替代持续空写轮询；长周期运行与压测下无 SQLITE_BUSY 报错与 P99 延迟抖动（校验：`apps/worker/test/outbox-worker.test.ts`；`apps/api/test/conversation-dispatch-resilience.test.ts`） | platform/data |
| <a id="iter-031"></a>ITER-031 · 执行中 | 连接版 CLI 基础：最小 bin、无 Vue 传输入口、ask/chat/sessions/status/config/doctor、认证、流式/JSON、审批/用户问题、取消与历史重开；CAP-002/007/020 | 依赖 ITER-030；ITER-006/007/013 只闭合实际涉及的认证、授权/窗口与有界控制；只连接已有本机 API，不启用自动 Attempt 恢复，不等待 Page 或全部宿主重构 | 真实 API/临时 SQLite 完成提问到权威终态与历史重开；至少一个真实 Provider 通过答疑及工具往返；TTY/管道、认证、审批、取消、受理响应丢失及 SSE 重连无重复副作用，机器输出可解析且资源有界；最小分发包可在无源码目录安装运行，不依赖 Vue 或仓库私有路径 | 3yearszhuang / platform（分支 `feat/siyu-cli`；2026-09-29 首片通过全量 ci-code/ci-docs、CLI 24 项测试；实现 commands 模块化解耦；打包压缩包并在空目录安装，真实 Token API/临时 SQLite、API 重启后持久历史验证；追加本机 DeepSeek 真实答疑、跨进程续会话、历史补读与 TTY 启动验证；集成测试完成只读多步工具链往返（aervox_notes_search 执行账本落库）与写工具非 TTY 拒绝自动授权边界；剩余会话详情与模型命令、完整平台分发与响应丢失恢复全面验收；不标整项移交） |
| <a id="iter-032"></a>ITER-032 · 建议 | CLI 伴学与数据命令分片：学习目标、提示/作答/复习、日记读取、人格选择及记忆查询/纠正/删除/导出；CAP-002/003/005/006/009/013/016/019/027 | 依赖 ITER-031；复用领域 Port/API，缺口先补公开合同；涉及 Memory 的命令启用前闭合 ITER-003/012 的必要资格与删除证据，其余学习切片可先交付 | CLI 与桌面共享学习事实，提示→作答→反馈→复习闭环成立，重复提交不重复记分或排期；声明的数据命令具备来源、授权、删除状态与持久完成证据，不将 202 受理视为完成；按命令保存范围矩阵与回归证据，未验收能力不开放；整项按已评审范围移交 | companion/learning/data（建议角色，待认领） |
| <a id="iter-033"></a>ITER-033 · 建议 | 连接版 CLI 安装分发、兼容矩阵、终端用户试用与发布回滚；[§7.7](#siyu-cli-delivery-plan)；终端交付基础设施及已声明 CAP | 正式移交依赖 ITER-031/032 的已评审范围；031 后可先做基础预览；不依赖独立宿主；自动管理服务另受 ITER-015 门槛约束 | 声明平台的干净用户能安装或连接兼容服务并完成伴学闭环，制品无 workspace/源码依赖和 Secret；版本兼容、失败诊断、升级失败、卸载保留数据及上一兼容制品回滚通过；真实用户试用、继续/暂缓依据、发布制品和环境证据齐全；实现/验证/发布状态分别登记 | cli/quality/release（建议角色，待认领） |

### 2.3 后续候选：只有证据成立才投入

| 条目 / 状态 | 最小交付与依据 | 依赖及 CR 门槛 | 完成判定 | 建议责任（待认领） |
|---|---|---|---|---|
| <a id="iter-017"></a>ITER-017 · 建议 | 测量后分别决定 Prompt 预算/保真压缩、SQLite 写竞争、向量 topK、计算隔离和资产归属；FND-07/08/10、ARC-05/08/12；相关基础设施 | 依赖正确性修复与 ITER-013 指标；全局单写者、独立执行进程、二进制索引扩展先 CR | 同设备同数据报告延迟分位数、失败率、内存和质量；未达收益门槛即可停止；不承诺未测倍数 | platform/data/quality |
| <a id="iter-018"></a>ITER-018 · 建议 | 第二终端检验共享生命周期，再决策 PCB/结构/电源、样机和小批验证；硬件评估 | 依赖 ITER-016 价值成立；新增无线、电池、采集或运动能力分别评审，不因 PoC 成功自动批准量产 | 两种终端无需复制宿主；更新/回滚/删除可测；24→72 小时稳定性、功耗温升、密钥/追溯/维修验证；发布单列 | product-hardware/release |
| <a id="iter-019"></a>ITER-019 · 建议 | 是否开放第三方可执行插件；若开放，按已接受 [ADR-009](docs/reference/adr/ADR-009-electron-plugin-sandbox.md) 的进程外隔离、默认无权限与撤权要求设计 Host、签名信任根、SDK 与依赖解析 | 先证明声明式/第一方扩展不足，再用 CR 明确实现差量与生命周期；隔离基线不作为自由选项，改变基线须显式 CR；现行规范不代表运行能力已实现 | 有明确用例、威胁与成本比较，并通过 ADR-009 的拒绝/撤权/隔离/兼容验收；未选定前不建通用平台 | ecosystem/security |
| <a id="iter-022"></a>ITER-022 · 建议 | HLS 参赛方案扩大验证与冻结提交：正式评分接口、最终 32 GB 环境、离线容器、固定技能和复现报告；AVX-EXPL-013 P3 | ITER-021 证据支持继续且正式范围/必要 CR 已评审；先取得最新细则与提交窗口；本项不自动包含产品化、微调或硬件采购 | 官方目标环境在预算内完成，干净环境断网双入口可复现且冻结哈希一致；报告包含分级通过率、pass@1/pass@5、裸跑增益、墙钟和失败证据；产品化另作决定 | platform/competition |
| <a id="iter-028"></a>ITER-028 · 建议 | 纯本地多端点对点加密同步探索：局域网发现（mDNS）、SQLite Changeset 增量对齐与去中心化数据同步；CAP-018/027；CR-030/CR-055 | 坚决不引入中心化多租户云端数据库；同步前必须通过端到端加密与用户显式配对授权 | 完成多设备同网发现与 TLS 证书配对 PoC；利用 SQLite Session Extension 提取增量 Changeset 并验证无冲突双向合并；移动端（Capacitor）与桌面端（Electron）局域网直连同步学习进度与错题本成功 | desktop/mobile |
| <a id="iter-034"></a>ITER-034 · 建议 | CLI 所需共享应用装配：原生会话与首批业务命令的上下文、人格、记忆、学习工具、审批、安全及持久化公开 Port；ADR-020/CR-056；CAP-002/005/007/020/027 | 依赖 ITER-030；接口盘点可提前，正式抽取以独立使用价值和已接受差量为前提；不要求一次抽空 API，不复制产品策略或反向依赖私有实现 | Fake Port 与私有依赖反向夹具通过，产品应用装配可在无 HTTP 宿主运行；API 与独立装配在固定输入下公共事件、终态、数据和副作用一致，API 回归及回滚通过 | platform/domain（建议角色，待认领） |
| <a id="iter-035"></a>ITER-035 · 建议 | 独立 CLI 宿主：A 真实模型/工具/SQLite、执行独占与后台归属；B 既有恢复合同接线与故障演练；CAP-002/005/007/020/027 | 依赖 ITER-032/034 的命令和共享装配；A 可先验证，B 启用前闭合 ITER-010 及所涉删除/授权/迁移切片；未完成 B 时禁用自动恢复和恢复命令，不改写原恢复计划 | A 无必需 HTTP 服务且行为与声明命令一致；同数据根不双重执行，活锁不抢占、陈旧锁安全接管、旧 fencing 写入被拒绝，资源有界释放；B 在 claim/副作用/结果/终态及审批、撤权、旧备份等故障点恢复不重复副作用、不丢答案、不复活撤权，未知结果不盲重放；短命令与后台任务所有权明确；只有 A/B 和声明命令均有证据才整项移交 | platform/data/security（建议角色，待认领） |
| <a id="iter-036"></a>ITER-036 · 建议 | 独立版 CLI 分发与发布：平台依赖闭包、数据版本、凭据权限、真实模型、冲突启动、恢复、升级及回滚；CAP-027 与终端交付基础设施 | 依赖 ITER-033 的分发基础及 ITER-035；自动模型/服务管理才依赖 ITER-008/015，实际破坏性转换须先通过 ITER-011 相关演练；与连接版分别发布 | 每个声明平台的干净环境完成安装、独立持久伴学、取消、关闭和恢复，无遗漏私有依赖；故障升级不破坏源库，回滚不让旧程序写新 Schema，不复活撤权；卸载保留用户数据；真实独立需求、性能分位数、制品/许可证/校验和及适用签名、发布后验证证据齐全 | cli/platform/release（建议角色，待认领） |

<!-- plan-queue:end -->

未列入当前队列的长期 CAP 仍以 PRD 的生命周期路线和追踪基线为准，不视为取消。新发现先合并到已有条目或新增稳定编号，再决定是否进入当前批次；不要把旧文档中的所有未勾选项不加核验地搬进来。**发现只登记一次**：实现事实与剩余差量写进[§4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)，本表只保留目标、门槛与验收，不复述细节。

## 3. 设备与移动端的待决策项

ITER-009 需要给出下面的可审阅结论，目前不替用户选定产品：

| 决策 | 建议起点 | 需要的证据 |
|---|---|---|
| 是否要求电脑关机后独立使用 | 先分别比较依赖现有电脑的配件与独立算力盒 | 典型使用时段、成本/能耗、维护能力与本地模型规格 |
| 首个硬件形态 | USB 桌宠、专注旋钮、电子纸卡可优先做低成本概念比较；语音/扫描由真实能力验证决定 | 用户价值、现有外设替代、Provider 真实性、无设备时流程完整性 |
| 移动端定位与平台 | 先明确配套端还是独立端，再决定 Android/iOS 顺序和版本范围 | 后台/权限限制、目标用户设备、打包与真实平台验收 |
| 同网连接与认证 | 明确发现、证书、设备凭据和撤销；不把同一 Wi-Fi 当作授权 | 当前 Token 与隐私契约中身份要求的差量及威胁评审 |
| 跨设备数据范围 | 普通资料与 local_only/混合来源严格分开 | 导出/同步授权、删除传播、离线期限与来源验证 |
| 第一版交互范围 | 从通知、图片、分享、只读复习中选择最小闭环 | 实际任务完成率与成本，不按接口数量决定范围 |

清点发现 `docs/mobile-landing-plan` 分支另有未合入的 `CR-055-mobile-delivery-plan.md` 草稿；该草稿已随本次收割移入 `main` 并登记（Proposed/Planned），不再是分支私有材料。其 Web→Android→iOS 顺序与 20～34 工作日估算仍只作提案参考，不作为承诺；移动范围、连接与数据边界的决策继续在本节维护，不再由第二份草稿维护独立全项目排期。配套硬件方向的两份版本也已合成为单一文档，器件级事实仍由 ESP32 方案承载。

## 4. 实施与移交建议

建议首先交付 ITER-001 的可重现验证入口，然后按独立故障路径建立修复 PR：接单/Outbox、删除/资格、模型文件边界可并行；每个 PR 只关闭能由对应夹具证明的问题。Config CAS、Page、工具发现和进程代际随后按依赖衔接。独立执行 Host、自动恢复、设备主管和新协议保持“先合同、后接线、再故障演练”的顺序。

开始每个条目前先核对其证据是否仍适用于当前 HEAD。提交内容至少包含：最小触发、修复行为、受影响契约、必要测试、回滚与剩余门禁。只改变既有行为的正确性修复可单独推进；涉及决策差量按[CR 工作流](docs/how-to/cr-workflow.md)处理。数据库破坏性操作继续采用[停写→备份→显式范围→staging→校验→换库→保留回滚包](docs/how-to/run-database-migration-drill.md)。

门禁遵循仓库现有流程：相关组件回归、依赖边界、构建/类型检查与文档校验；提交前双门禁，推送前全量终验。历史评估里已经暴露的冷 CI/生成物缺口应如实记录，不得通过删除测试或扩大 SQLite 测试并发来获得绿灯。

性能参数需在 [ARC 测量矩阵](docs/explanation/architecture-implementation-review.md#7-如何测量优化是否值得)规定的同设备/同数据实验中确定；真机、供应商、签名、迁移和发布演练单独记录。每项完成后先在[§4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)写实现证据，再将计划条目标“已移交”并保留链接。

## 5. 同类材料清点与归并结果

此次清点覆盖 Git 文档、根入口、隐藏协作目录及已知移动规划工作树；外部 `reference/` 子模块仅作设计输入，产品学习计划代码不属于项目迭代计划。逐条去向已固定在各文档自身与[§4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)，本表只保留分类结论，不再随收割增长。

| 材料类别 | 归并结论 | 当前入口 |
|---|---|---|
| 评估类：[FND 评估](docs/explanation/foundation-optimization-review.md)、[ARC 评估](docs/explanation/architecture-implementation-review.md)、[参考设计迁移](docs/explanation/reference-design-transfer.md)、[Agent Loop 计划](docs/reference/agent-harness-loop.md#15-分阶段落地计划)与[历史记录](docs/reference/agent-loop-rollout-history.md)、[Web 方案](docs/explanation/web-implementation.md)、[主动智能方案](docs/explanation/proactive-intelligence-mode.md) | 保留源码、实验、风险与方案；撤去独立当前排期，历史优先级只作评估时的风险标签；已实现部分不重做，未接线部分核验后入队 | 队列见 §2；证据与来源见各评估文档自身 |
| 硬件与移动：[硬件方向](docs/explanation/companion-hardware-directions.md)、[ESP32 方案](docs/explanation/esp32-s3-hardware-extension.md)、[CR-055](docs/reference/changes/CR-055-mobile-delivery-plan.md) | 两份硬件方向版本合成为单一文档，ESP32 保留完整正文作器件级事实源；移动规划随收割移入 `main` 并登记（Proposed/Planned），其平台顺序与工期估算只作提案参考 | §3 待决策项；ITER-009、016、018 |
| 需求与决策权威：[追踪基线 §4.1](docs/reference/REQUIREMENTS_TRACEABILITY.md#41-建议交付批次与拆分原则)、PRD/SRS、ADR、CR、数据库与安全契约、覆盖矩阵、[治理规范 §7](docs/reference/document-governance.md#7-分阶段迁移) | 保留各自需求/决策/验收权威，不因计划统一而降级或删除；建议批次转至本文件，§4.2 继续维护实现事实 | 本文件只引用 |
| 非迭代材料：`docs/CR-033-plan.md` 等旧计划（已归档且本地不存在）、`.workbuddy/REFACTOR-PLAN.md`、`.workbuddy/ARCHIVE-CANDIDATES.md`、`.zcode/plans/*.md`（Git 忽略的历史/会话快照）、StudyPlan 与学习/日记/复习排期、迁移与发布操作指南 | 旧计划不重新创建；忽略目录内的快照不删除、不强制纳入 Git、不作为当前队列（后续 Agent 先读本文件，旧建议须重新核验）；产品功能与操作程序保持原有归属 | 不进入本队列 |

## 6. 本次分支与后续维护

本轮规划在 `docs/iteration-plan-governance` 独立分支交付，评估基线为原 `feat/plugin-capability-consolidation` 的 `6b20e7e`；PR 准备时已对齐该分支的 `5e20a0e`，以保留后续 UI 提交及其独立登记。本次规划差量不修改 UI，实现审查以该功能分支为基准，并依赖 PR #218。合入 `main` 时应先确认底层功能分支已合入，再按当前基线复核；若采用 squash 导致祖先不同，优先只移植规划提交，不重复合入功能历史。

截至 2026-09-18，`#218`（`d91b121`）与 `#219`（`5584bdf`）均已合入 `main`；本轮另将 `docs/mobile-landing-plan` 的两条提交（`dff68b8`、`00d83ad`）连同 `CR-055` 收割进 `main`，并把两份硬件方向版本合成单一文档。该移动规划分支此后不再承载独立排期；后续硬件与移动的当前排序一律回到本文件维护。

ITER-001 的落地在 `fix/iter-001-ci-verification-entry` 独立分支交付，只修验证入口本身：工作流触发路径与 Turbo 声明同源、各 Job 显式锁文件安装、gitignore 生成物的声明恢复任务及其可重现性，以及本地增量门禁对包外输入的显式选择（登记见 [§4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)）。该分支不改业务代码、不改任何 CAP 的交付状态，也不开启已禁用的缓存。三条验收均有证据：干净 checkout 由 PR [#221](https://github.com/3yearsZhuang/Aervox-harness/pull/221) 的冷 CI 证明（Install/build/typecheck、E2E、Docs 全绿），仅插件变动会重新验证由 `scripts/ci-scope.test.mjs` 与反向验证守住，生成物由声明任务重建并断言。核对中还发现产品侧导出分发包同样不可重现，因涉及业务代码未在本分支修复，已追加到 ITER-005。ITER-002、003、008 等其余条目仍为建议态，待认领。

本文件不持有完整日志。§2 的队列不是手写表：真源在 `docs/_meta/plan-queue.json`，改条目后运行 `mise tasks run plan-render` 生成派生的 §2 表格，`mise tasks run plan-check` 校验结构、依赖与“状态—证据”一致性（已接入文档治理，2026-09-18 起强制级别为 `error`：H1–H6 与 S1–S4 一律阻断，仅 S5 依赖次序保持提示）。每次认领、调整和移交更新真源、元数据与签名，同步注册表；PR 说明列出关联 `ITER-*` 及是否改变计划。迭代复盘时合并重复项、明确暂停原因并压缩已移交项，避免计划退化为永久堆积的 TODO。

<a id="siyu-cli-delivery-plan"></a>

## 7. 思隅 CLI 完整落地规划

本节是 CLI 的完整实施路径与待决策入口；当前状态、依赖和认领只以 §2 生成队列为准。ITER-029 记录规划文档交付；2026-09-29 用户进一步授权新开分支实施，`feat/siyu-cli` 按 [CR-058](docs/reference/changes/CR-058-siyu-cli-attached-client.md)固定并实现首个连接版切片。已固定命令与参数以该 CR 和命令帮助为准，本节其余命令及独立形态仍为后续候选，当前状态与剩余差量只维护在 §2。

### 7.1 产品目标与已核验起点

CLI 面向在终端学习编程、阅读代码和排查报错的用户，提供“提交问题 → 引导学习 → 作答反馈 → 后续复习”的入口，并与桌面端共享会话、人格、学习事实和数据权利。业务目标仍以 [PRD §1](docs/reference/PRD.md#1-产品决策摘要)为准；本计划覆盖终端形态的完整落地，不要求一次搬齐视觉小说、Live2D、语音、插件 Page 或所有长期 CAP。

评估基线为 `feat/aervox-core-evolution` 的 `dd5afcc`。已具备 [Agent Loop](packages/agent-loop/src/executor.ts)、[真实模型兼容接口](packages/agent-loop/src/openai-compat-provider.ts)、[轻量 Core 导出](packages/host-agent/src/core.ts)、终端审批及执行存储端口。[Headless 脚本](scripts/run-headless-agent.mjs)仍是规则模型、模拟笔记与内存状态演示，不能证明真实模型、持久会话、终端流式和独立安装已完成；脚本模块加载计时也不是完整进程启动承诺。已有验证的范围登记在[§4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)，新实现必须另补实际证据。

核心分离的既有决定见 [ADR-020](docs/reference/adr/ADR-020-aervox-core-decoupling.md)；产品编排、公开 Port 与组合根边界见 [CR-056 §3](docs/reference/changes/CR-056-build-to-delete-pi-style-architecture.md#3-建议的分层与代码落点)。当前[上下文装配](apps/api/src/modules/companion/conversation/context-builder.ts)与[工具装配](apps/api/src/modules/companion/conversation/tool-providers.ts)仍包含 API 侧产品依赖。独立版按实际消费者需要提取共享应用服务，不复制业务规则、不反向导入 API 私有文件，也不把教学、记忆、插件安装塞回执行内核。

### 7.2 运行形态与命令范围

首个连接版切片采用主仓宿主 `apps/cli`、包名 `@aervox/cli` 和产品命令 `siyu`；现有根脚本 `./aervox` 继续承担开发、测试和打包入口。CLI 与其他入口复用 Aervox 契约，依赖仍在根目录统一治理。

| 形态 | 执行与数据归属 | 建议交付范围 | 启用前提 |
|---|---|---|---|
| 连接版（候选 `--mode attached`） | 连接本机既有 API；会话、SQLite 与后台任务仍由现有 API/Worker 管理；CLI 仅保存连接配置、会话选择及恢复查询所需标识 | 真实模型答疑、连续会话、工具审批/用户问题、伴学与复习；已验收的数据操作 | ITER-031/032 对应命令通过验收；用户版本由 ITER-033 单独发布 |
| 独立版（候选 `--mode standalone`） | CLI 宿主组合共享应用服务、Core 与既有本地持久层；无必需 HTTP 服务；数据根、主库/Vault/账本及执行拥有者明确 | 与连接版声明的命令子集行为一致；持久历史；恢复按能力单独启用 | ITER-034/035 完成相应切片；用户版本由 ITER-036 单独发布 |

两种形态显式选择。连接失败不得静默另起独立宿主、切换数据根或改用远程 Provider；独立版遇到已被占用的数据根时明确拒绝并提示显式连接，不再创建竞争执行器。首版连接已有服务；自动启动/管理 API、Worker 或模型进程属于 ITER-015 的主管合同。局域网连接、多设备同步不是 CLI 前置，也不由本计划隐式启用 ITER-028。

以下命令为候选界面；实施时建立精确帮助与 DTO 映射，缺少公开 API 的操作需补业务 Port/API 后再开放，不允许 CLI 直接查询或修改业务表。

| 命令组 | 用户行为 | 关联能力与实施条目 |
|---|---|---|
| `ask`、`chat`、`sessions list/show`、`status` | 单次提问、连续会话、选择既有会话、查询 Turn 及权威终态；输入可来自参数或显式交付的 stdin/文件 | CAP-002/007；ITER-031 |
| `config`、`doctor`、`model list/select` | 检查版本、连接、认证和可用模型，选择已配置 Provider；模型下载及后台管理按独立能力判断 | 运行基础设施/CAP-020；ITER-031，独立适配归 ITER-035 |
| `learn`、`quiz`、`review`、`goals` | 提示分层、提交答案、查看反馈与到期复习、完成复习和查看学习目标 | CAP-002/003/006/007/016；ITER-032 学习切片 |
| `diary show`、`persona list/select` | 查看已有复盘，选择现有人格并沿用其授权与记忆边界 | CAP-009/019；ITER-032 读取与选择切片 |
| `memory search/show/correct/delete/export` | 查询来源、纠正、删除和可读导出；每个写操作展示影响、受理状态及完成证据 | CAP-005/013/027；ITER-032 数据权利切片，按必要公开合同逐项开放 |

首版限定已知受信工具；通用 Shell、任意文件写入、自主编程、第三方可执行插件、完整 TUI 和常驻主动感知不列入默认范围。CLI 的进程内工具容器不能代替 OS 隔离；新增这些能力时复用 ITER-007/019 及相关 CR，不另建一套权限系统。声明式 Skill 可按当前产品能力复用，插件 Page 的界面兼容性不作终端承诺。

### 7.3 跨形态的候选行为合同

下列要求用于 ITER-030 的规格化与后续验收；新外部字段、写入/恢复语义或已接受架构的差量先按 [CR 工作流](docs/how-to/cr-workflow.md)登记，已有 ADR-020 内核复用不重复审批。

- **输入与终端**：明确参数、stdin、文件的组合与冲突规则，采用 UTF-8，限定文本/附件大小和超时；仅处理用户显式交付内容，不默认递归扫描目录。TTY 交互与非 TTY 执行分流；管道正文不能充当审批回答。终端控制字符、ANSI/OSC 序列按显示策略处理，测试恶意模型/工具输出不能操纵终端。
- **输出与错误**：正文或机器结果写 stdout，进度、诊断、审批写 stderr/控制终端；候选 `--json` 输出单个最终对象，`--jsonl` 输出版本化事件流，两者互斥且没有横幅/颜色污染。输出只使用公开投影字段，保留会话/Turn/事件游标、结果与错误分类，退出成功必须有权威成功终态。冻结使用错误、认证、服务/模型失败、需要审批、超时/未知结果的非零退出码；Ctrl-C 与 SIGTERM 的候选退出码分别为 130/143。数值、时间格式、结构版本及兼容政策由 ITER-030 确认。
- **配置与凭据**：候选优先级为命令参数 → 环境变量 → 用户配置 → 默认值；普通配置与 Secret 分离，不自动信任当前目录配置。API Token 与模型密钥分别管理；连接版复用服务端模型配置。Secret 通过受保护存储或环境注入，避免命令行明文参数、URL、日志和诊断导出泄露；新凭据存储或权限边界先明确合同，独立版复用既有 Secret 归属。
- **认证与版本**：普通请求、SSE 及实际开放的上传接口统一注入认证；不得为通过连接测试退回免认证。明确本地地址来源与可信端点，兼容性握手失败时有稳定错误。连接版的版本查询不泄露 Secret；CLI/API 支持矩阵、未知字段与不兼容变更处理在 ITER-030 冻结。
- **审批与工具**：连接版提交服务端审批，只有有效批准才继续；独立版注入同一受信授权适配，不能固定传 `approval: true`。列工具与执行前核对定义、参数 Schema、安全等级、grant scope/revision 和撤权；批准绑定具体调用与参数，旧批准、重复消费及工具替换均不得产生越权副作用。非 TTY 遇到必需审批有界返回 `needs_approval` 或拒绝，不能默认自动通过；预授权仅在相应合同已定义并验收后提供。
- **取消与恢复**：区分断开本地显示、请求取消、确认权威终态。Ctrl-C/SIGTERM 发出取消并有界等待，无法确认时报告未知状态及查询标识，不能显示“已取消”。服务已受理后即使响应丢失也能查询归属，重试不重复创建任务。历史会话重开、SSE 游标补读、崩溃 Attempt 续执行分开验收；未知副作用不自动重放，自动恢复沿用 ITER-010。
- **数据与后台**：API 或独立宿主是所选数据根的产品执行权威，持久会话不能由内存 Store 或虚拟会话冒充。所有写入走领域命令与写者连接，保留删除、用途、来源、召回资格及 local-only 限制。短命令退出后仍需进行的复习排期、日记提炼和删除传播，在连接版由现有 Worker 承担；独立版须声明持续宿主或按需工作范围，不能在进程退出后承诺主动提醒。退出和卸载保留用户数据，显式删除走领域删除合同。

### 7.4 实施切片与交付顺序

每个条目均可拆为小 PR；以下只解释最小实施内容，状态、责任和硬依赖见 §2。命令清单、数据范围或依赖改变时先更新对应队列条目，再调整本节；未认领项目不承诺日期。

1. **ITER-030：范围与合同冻结。** 将 §7.2/7.3 转为可测试的 CLI 用例、命令帮助、公开 DTO、错误/取消/审批和模式选择合同。逐项列出现有 HTTP/SSE/领域 Port 与缺口，确定首发 OS/架构、包名、配置目录和服务端兼容矩阵。新增产品入口、应用装配与执行所有权涉及的差量按需建立 CR，并联动 PRD、架构、流式协议、隐私、能力组合及追踪基线；不以改计划代替接受决定。
2. **ITER-031：连接版最小纵向闭环。** 建立 `apps/cli` 候选入口和可安装的最小 `bin`；为 `packages/api-client` 增加无 Vue 的公开传输入口及分发产物。完善认证、Turn 标识、对外 AbortSignal 和服务端取消；实现提问、连续会话、流式显示、审批/用户问题、状态查询、配置与诊断。用真实 API 和临时 SQLite 跑通创建→受理→执行→流输出→终态→重开历史；用确定性 Provider 做回归，再以至少一个真实 Provider 验收答疑和工具往返。最小打包 smoke 在本阶段建立，不能等发布时才发现 `workspace:*` 或源码路径无法安装。
3. **ITER-032：伴学与数据权利分片。** 先做学习目标/练习/复习和已有日记读取，再做人格选择、记忆查询及纠正/删除/导出。复用原有业务命令，不复制排期算法或记忆规则；验证 CLI 与桌面读取同一事实。当前记忆路由不等于完整检索/纠正 API，删除受理也不等于完成：缺口先补公开业务合同、状态查询与幂等依据，再开放对应命令。学习切片不等待整个隐私重构；数据命令必须先通过其实际触及的 ITER-003/012 等资格和删除验收。
4. **ITER-033：连接版分发与产品验证。** 基础提问闭环可在 ITER-031 后提供受控预览；本条目正式移交需覆盖 ITER-032 中明确承诺的伴学与数据命令，未验收命令默认不可用且在支持矩阵列明。交付安装包、帮助、故障诊断、版本兼容、升级卸载、回滚与真实用户记录。该发布不依赖 ITER-034/035；复用已有服务时也需验证干净用户如何安装或连接兼容服务，不能要求用户从仓库执行开发脚本。
5. **ITER-034：最小共享应用装配。** 针对原生会话与首批 CLI 业务命令，将 API 私有装配中的上下文/历史、人格、记忆、学习工具、审批、安全中间件和持久化依赖变为窄公开应用 Port，由 API 与无 HTTP 宿主共用。候选共享包名按实际所有权确定，不一次抽空全部模块。先做 Fake Port 与边界反向夹具，再以真实领域适配比较两种宿主的事件、终态、数据和副作用；保留 API 行为与回滚路径。接口盘点可在 ITER-030 后进行，正式抽取以独立形态的需求证据和已接受差量为前提。
6. **ITER-035：独立宿主与恢复启用。** 拆为两个切片：A 组合 Core、共享应用服务、真实 Provider、受信工具和 SQLite 执行存储，落实数据根、宿主独占、模型/数据库资源释放、信号与预算控制；B 复用 ITER-010 的必要恢复合同，验证审批/答案、事件高水位、撤权账本与未知副作用。A 可先验收，B 未通过前禁止启动时自动恢复以及恢复命令，只保留诊断和人工查询；整项移交需满足队列中的 A/B 验收。独立进程并发启动、陈旧锁接管及旧 fencing 写入必须用真实进程夹具验证，不能仅用“先读后写”的锁文件证明独占。后台任务归属需在本阶段落实。
7. **ITER-036：独立版发布与运行演练。** 复用连接版分发基础，补独立依赖闭包、无 Fastify 必需依赖、平台凭据/文件权限、数据库兼容、占用冲突、崩溃恢复、资源退出及本地数据回滚演练。需要模型时连接已配置端点；自动下载和管理模型仅在 ITER-008/015 相应门槛完成后开放。独立版单独记录已实现、已验证与已发布状态，不根据连接版发布状态自动晋级。

### 7.5 既有工作协同与启用门槛

队列的 `dependsOn` 表示整个条目的输入；下面列出按功能触发的必要切片，避免把相关条目的全部范围变成 CLI 的统一阻塞项。认领时将确切切片和证据链接写回对应条目；改变实际硬依赖时同步队列字段。

| 既有工作 | CLI 需要闭合的部分 | 不阻塞的范围 |
|---|---|---|
| ITER-006 客户端认证 | 连接版 JSON/SSE/实际开放上传的认证与凭据保护 | iframe/Page 的独立重构 |
| ITER-002/007/013 接单、控制和有界运行 | 受理可追踪、实际工具权限与窗口、取消终态、流式资源与停机有界 | 未开放动态工具、额外 Driver 或跨进程通知的后续范围 |
| ITER-003/012 删除与索引资格 | 记忆查询、纠正、删除、导出实际涉及的来源资格、完成证据和索引一致性 | 不涉及 Memory 的基础提问和既有学习入口 |
| ITER-010 恢复 | 独立恢复切片的账本覆盖、答案/审批续跑与禁止未知重放 | 连接版历史重开、SSE 补读，以及显式关闭自动恢复的独立宿主验证 |
| ITER-011 迁移 | 实际出现 Schema/数据根转换时的完整校验、staging、回滚与权限 | 沿用现有 Schema 的客户端，不为 CLI 主动制造迁移 |
| ITER-008/015/027 模型、主管与并发 | 自动管理进程才要求主管；独立宿主须证明其声明的并发边界 | 用户已有模型端点、已有本机服务，以及未涉及的 Worker 优化 |
| ITER-005/019 插件生命周期与隔离 | 实际开放安装/升级或第三方可执行工具时的相应验收 | 基础 CLI 与已知受信工具；不得把规划当作通用插件兼容保证 |

### 7.6 验收矩阵与证据要求

每个发布命令映射到既有 CAP、输入输出合同、实现位置、测试和发布矩阵；下表是拟补的验收，不代表已通过。确定性回归使用 Fake Provider/临时库，真实模型、平台和安装验证分别记录；供应商不可用不能用模拟结果代替真实模型门槛。

| 验收面 | 必需场景与判定 | 归属 |
|---|---|---|
| 最小产品闭环 | 干净用户完成配置→真实模型提问→流式回答→持久会话→重开；工具结果真实参与后续回答；CLI 与桌面可读同一记录 | ITER-031/033 |
| 终端与机器协议 | TTY、stdin 管道、空/超额输入、UTF-8、无颜色模式、JSON/JSONL、慢消费者、断管、终端控制字符；stdout 可解析，错误非零，有界资源 | ITER-031，两版发布回归 |
| 认证/审批/提问 | 错 Token、过期批准、参数变化、工具替换、缺 grant/错 scope/旧 revision、禁用/撤权、非 TTY 及超时；未授权零副作用，管道输入不被当作确认，用户答案不丢失 | ITER-031/035 |
| 受理/取消/重连 | 提交已受理但响应丢失、Ctrl-C/SIGTERM、审批等待、模型卡住、SSE 断线与游标失效；不重复提交，终态来自权威源，取消未确认时明确未知 | ITER-031/035 |
| 学习与数据 | 提示→答案→判定→复习；重复请求不重复记分/排期；记忆来源/纠正/删除/导出遵守现有合同，删除受理与完成可区分，旧缓存不恢复已撤权内容 | ITER-032 |
| 两宿主等价 | 相同固定输入、Provider 与工具夹具下，API/独立宿主的公共事件、终态、记录与副作用等价；安全/人格/记忆中间件未漏装，禁用能力失败明确 | ITER-034/035 |
| 独占与恢复 | 两进程同时启动、活宿主占用、陈旧锁、旧 fencing 写；在 claim 前后、工具意图落账后、副作用后结果落账前、结果后终态前、待审批、撤权和旧备份恢复后中断 | ITER-035：不双重执行、不丢答案、不复活撤权，未知结果不盲重放 |
| 安装与升级 | 无源码/node_modules 的干净目标环境、非 ASCII/空格路径、凭据权限、离线帮助、版本不匹配、升级失败、卸载保留数据、回滚和独立资源释放 | ITER-033/036 |

性能分别报告完整 CLI 进程到可用、服务连接、模型首个公开文本片段、取消完成、RSS 与慢流资源；固定设备/数据/模型、重复样本和冷暖条件，记录分位数及失败率。默认 deadline、输入配额、缓冲上限和发布阈值在 ITER-030/预览实测后冻结，不沿用 Headless 的单次模块加载数字宣称产品冷启动达标。

### 7.7 分发、试用、退出与回滚

建议先交付 Node.js CLI 包与明确 `bin`，运行时版本沿用工具链真源；若采用随包运行时或单文件制品，在 ITER-030 明确平台和维护成本。候选平台为 macOS、Windows、Linux，实际首发 OS/架构须逐项认领验收，未测平台不宣称支持。制品不得依赖仓库绝对路径、未打包的私有包或外部 `workspace:*` 引用；冻结许可证/NOTICE、依赖清单、校验和、分发身份及适用的签名门槛。

连接版在 ITER-033 独立执行“内部预览 → 小范围终端用户试用 → 声明范围发布”。建议邀请五至十名实际使用终端的学习者，覆盖一次引导学习与后续复习，记录任务完成率、复习完成、失败原因、桌面切换和用户摩擦；样本仅作方向判断，不外推总体效果。独立版在 ITER-036 另行验证“无需既有 API 服务”的真实使用需求、安装成本和数据维护成本；没有价值证据时可停留连接版，不以已投入为理由推进架构扩张。采样方式、继续/暂缓阈值和是否采集诊断数据在试用前确认，遵守既有隐私合同。

连接版回滚为恢复上一兼容 CLI 制品和配置，既有服务与业务数据不变；不兼容命令或未验收能力可撤下，保留状态查询与数据权利入口。独立版升级前检查 Schema/资源版本，失败不改源库；需要破坏性转换时沿用[停写→备份→显式范围→staging→校验→原子换库→保留回滚包](docs/how-to/run-database-migration-drill.md)，不得仅回退程序后让旧版本写新 Schema。回滚保留或隔离更新后的数据与审计证据，不能把恢复旧备份当作恢复已撤销授权。

每个切片完成后立即同步 §4.2、相关契约复核结果与队列，执行对应测试和文档门禁；提交前按仓库双门禁、PR 推送前全量终验。发布还需独立保存制品、目标环境、真实 Provider、兼容矩阵、试用与回滚证据；功能实现、验证和发布三个状态分别判断。

### 7.8 首片决定与后续待决策项

| 决策 | 建议起点 | 必须形成的可审阅结果 |
|---|---|---|
| 产品命令与首版边界 | CR-058 已固定 `siyu` 连接版答疑/续聊首片；复习归 ITER-032 | 正式分发前核查公共包名与命令冲突，业务命令逐项验收 |
| 包与平台 | 已采用 `apps/cli`、`@aervox/cli`，macOS arm64 + Node.js 24 开发预览 | ITER-033 扩展平台矩阵、安装与发布身份；本机安装证据见 §4.2 |
| 终端公共合同 | 首片输入/输出、审批、错误、配置与配额见 CR-058 | 后续新增命令、版本握手和独立形态按实际差量补合同 |
| 现有服务的获得方式 | 连接已有本机服务，复用受控部署入口 | 干净用户安装/发现/认证流程；缺服务时的诊断和主管依赖 |
| 独立形态的投入 | 先观察连接版价值，再按实际需求抽共享装配 | 独立需求证据、最小命令等价范围、数据根/后台/恢复所有权及成本 |
| 人力、顺序与发布 | 按 §2 依赖认领，仍不超过 3 个在制工作包 | 每片责任人、预计投入与回归范围；日期承诺需另行确定 |

规划最初使用独立分支 `docs/siyu-cli-plan`；实施已复用该工作区，新建 `feat/siyu-cli` 并对齐核心修复基线 `0478053`，保留原规划与双方交付登记。合并时逐 ID 保留两边队列增量，协调元数据与 §4.2 记录后重新渲染；若基线已修复本节提到的差量，则引用新证据并删除重复工作，不覆盖或倒退原条目状态。
