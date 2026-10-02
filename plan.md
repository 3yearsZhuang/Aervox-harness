---
id: AVX-PLAN-001
type: reference
scope: guide
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
planning_role: current
version: 0.4.3
updated_at: 2026-10-01
reviewed_at: 2026-10-01
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
  - docs/reference/changes/README.md
---

# Aervox 当前迭代计划

- 提出人：3yearszhuang · 2026-09-18
- 修改人：3yearszhuang · 2026-10-01

本文件是**当前项目迭代建议、排序、依赖和待决策项的唯一权威入口**。维护字段、状态、分支协调与归档规则见[计划治理](docs/reference/document-governance.md#31-当前迭代计划的唯一入口)；产品范围见 [PRD](docs/reference/PRD.md)，决策见 [ADR/CR](docs/reference/adr/README.md)，实现与发布证据见[追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)。计划的优先级不改写这些契约，也不自动批准所有条目实施。

## 1. 本轮目标与起点

本轮建议聚焦“可信的本地执行底座 + 可验证的插件生命周期 + 配套设备方向选择”。继续采用本地单用户 SQLite 和模块化单体，先处理已确认的正确性问题，再以固定负载决定性能优化是否值得。没有测量依据时不启动数据库替换、全局单写者或整体微服务化。

输入基线为 `6b20e7e` 及 2026-09-18 的代码评估。已完成的准备工作是[插件开发规范](docs/reference/plugin-config-and-pages.md)、[开发指南](docs/how-to/develop-plugin-ui-extension.md)、[底层评估](docs/explanation/foundation-optimization-review.md)、[架构深入评估](docs/explanation/architecture-implementation-review.md)和[九个硬件方向评估](docs/explanation/companion-hardware-directions.md)。这些是规范与证据交付，下面的业务修复与设备原型均尚未开工；评估中的历史测试结果不能替代修复后的回归与发布验证。

**建议先启动 ITER-001、002、003、008 的范围复核与独立修复，认领后同时在制不超过 3 个工作包。** ITER-009 的产品访谈/方案比较可并行。CI 工作是合入验证前置，方案审阅和局部故障修复无需等它完成；涉及新契约的切片先完成 CR。每个工作包可拆多个小 PR，避免把整张表变成一次大重构。

角色均为建议责任，不代表已分配给具体个人。认领时在真源中填写责任人、分支与状态（`docs/_meta/plan-queue.json`）；没有日期承诺的项目不推算截止时间。状态解释：建议 → 待评审或就绪 → 执行中 → 已移交，暂停需写阻碍；已移交必须给出证据，不能据此宣布 Released。

2026-09-22 新增 [HLS 竞赛规划](docs/explanation/hls-agent-competition-plan.md)：ITER-020 仅交付规划，ITER-021 为可行性验证建议，ITER-022 为正向证据成立后的提交候选。三人/C++/RX 9070 XT 是范围输入；具体认领、期限、云配额和实现 CR 仍须在对应条目明确，不改变已有正确性修复的排序。

2026-09-28 新增 CR-056（Build to Delete 与类 pi 分层架构规划，已归档至 Aervox-docs-archive）：ITER-023 仅交付详细规划，ITER-014 进入架构差量待评审。CR 的切片按主归属和协同关系接入 ITER-005/007/008/013/014/019，具体依赖见 CR §7；先以 MemoryStore 工具与单个模型 Driver 验证实现可替换、资源可释放和数据责任连续性。规划不启动重构，也不将已有正确性修复统一阻塞在架构工作上。

2026-09-29 新增架构演进与深层瓶颈优化建议（ITER-025～028）：针对 ADR-020 解耦落地的剩余差量与深层性能瓶颈，提出思隅核心懒加载毫秒级冷启动（ITER-025）、伴学业务与会话执行器深度解耦插件化（ITER-026）、多进程 SQLite 写入并发与 Worker 自适应退避（ITER-027），以及纯本地多端点对点加密同步探索（ITER-028）。

2026-10-01 新增 pi（`PI-01`，固定 `5257d0d5`）对照改进建议：按[参考评估 §8.3](docs/explanation/reference-design-transfer.md#upstream-20260929) 的差量复评与 pi-ai 设计对照，新增 ITER-032（保真上下文投影与真实摘要压缩）与 ITER-033（统一模型 Provider 抽象面）两个建议条目。对照结论：思隅的核心缺点不在功能面，而在抽象收敛度与上下文保真；每请求证据链与取消/失败时序由 ITER-007/010 承接，流式背压与慢观察者由 ITER-013 承接，薄执行宿主仍按 CR-056（已归档至 Aervox-docs-archive）BTD-05/06 归属推进，不另设条目；按需工具披露与多模型路由仅在对照收益成立后另行立项。

## 2. 当前建议工作

下表是唯一活动队列，**由 `docs/_meta/plan-queue.json` 渲染生成**（改条目请改真源后运行 `mise tasks run plan-render`，校验见 `plan-check`）。每行“建议”表示尚未开工；“依赖”约束实际启用/交付顺序，前置设计与测试夹具可并行。证据编号 `FND-*` 见底层评估，`ARC-*` 见架构深入评估，不创建另一份问题正文。

<!-- plan-queue:begin · 本区由 `mise tasks run plan-render` 从 docs/_meta/plan-queue.json 生成，请勿手改 -->

### 2.1 第一批：正确性、验证入口与方向决策

| 条目 / 状态 | 最小交付与依据 | 依赖及 CR 门槛 | 完成判定 | 建议责任（待认领） |
|---|---|---|---|---|
| <a id="iter-001"></a>ITER-001 · 已移交 | 冷 CI 与插件验证：各 Job 锁文件安装、插件制品生成、工作流触发与 Turbo 输入；ARC-14、FND-10；基础设施/CAP-020 | 可独立修复；不借此开启已有禁用的资产缓存 | 干净 checkout 通过（显式锁文件安装，不依赖 pnpm 隐式安装）；仅插件变动会重新验证（工作流触发、Turbo 输入与增量选择三层同源）；删除生成物后由声明任务恢复，且产物字节可重现（校验：`scripts/ci-scope.test.mjs`；`scripts/export-plugins.test.mjs`；`.github/workflows/ci.yml` 的 frozen lockfile 与 plugin bundles 步骤） | quality/release（分支 `fix/iter-001-ci-verification-entry`；2026-09-18 移交：PR #221 冷 CI 全绿（Install/build/typecheck 5m23s、E2E 1m25s、Docs 24s），三条验收均有机会证据；合并后由 §4.2 记录交付） |
| <a id="iter-002"></a>ITER-002 · 已移交 | 可靠接单与 Outbox：先修消费者抢先完成，再闭合 Turn/Attempt/Inbox/可重放输入与受控派发；ARC-01、FND-01/05；CAP-007 | 拆为消费修复与调度切片；新状态、容量/接单语义或多订阅契约先 CR | 提交、预加载、claim 各点中断后已受理任务可追踪；无永久未领取孤儿，不重复消费/副作用（校验：`apps/worker/test/outbox-worker.test.ts`；`apps/api/test/conversation-dispatch-resilience.test.ts`） | platform（分支 `fix/iter-002-reliable-dispatch-and-outbox`；2026-09-18 移交：完成 Outbox 消费隔离、死信转移及 Turn/Attempt 孤儿恢复切片闭环（FND-01/ARC-01）；测试全绿，./aervox ci 通过） |
| <a id="iter-003"></a>ITER-003 · 建议 | 删除效果与召回资格：先做 Memory 及其索引的完整清理/独立验证切片，检查期限、用途、撤权与 Restricted；ARC-06/08；CAP-005/013/027/033 | 已有隐私契约的修复先做；扩大删除范围或改变保留/恢复语义先 CR；失败继续拒绝受影响范围 | completed 有可重做的清理证据；空目标有明确依据；失败/未知不解闸；混合夹具越权结果为零 | data/privacy |
| <a id="iter-004"></a>ITER-004 · 建议 | 三个独立修复：消息版本短事务/CAS，Config 与同库 Secret 一致提交，会话锁尾链回收；ARC-07、FND-02/07；CAP-013/020 | 不引入全局通用事务框架；外部 Secret 补偿或历史数据转换单独评审 | 故障仅留完整旧/新版；同 revision 最多一次成功；409 不改 Secret；一万个 key 完成后锁缓存清空 | data |
| <a id="iter-005"></a>ITER-005 · 执行中 | 插件可恢复升级：全部入口校验、展开配额、staging 验证与激活、旧配置/Secret/授权保留；FND-02/04、插件规范；CAP-020。2026-09-18 追加差量：导出分发包可重现（细节见 §4.2 剩余差量，不在本表复述） | 激活依赖 ITER-004；限制资源可先做；升级/卸载状态和迁移语义先 CR | 成功意味着全部声明入口可用；超额包有界失败；任一安装阶段中断后可恢复完整旧/新版；同源码导出分发包的字节与校验和稳定 | ecosystem（分支 `docs/build-to-delete-pi-architecture-plan`；2026-09-28 CR-056 BTD-02 缺包保护切片：可用性独立于用户开关，新增兼容字段保留数据；原升级验收仍保留） |
| <a id="iter-006"></a>ITER-006 · 建议 | Page 与客户端认证：iframe source/nonce/会话/全部 capability、禁用撤权；附件 Bearer、合法预检与受限 Page 资源通道；FND-03、ARC-13；CAP-018/020 | 既有认证漏接可独立修；新页面凭据及 Origin 信任策略先 CR | 错误窗口/旧响应/无权/禁用访问无副作用；合法 Token 模式的 JSON、SSE、Page、附件可用，凭据不进入 URL | ecosystem/desktop |
| <a id="iter-007"></a>ITER-007 · 建议 | 三个切片：父子任务/Driver 继承取消、截止、删除/授权修订与 local-only；执行时逐项核对 requiredPermissions/grants 的 scope/revision，由受信宿主映射 guarded/full_access 安全等级；动态工具 Schema 快照进入模型请求并在执行时重验；ARC-02/03、插件规范 §8.1；CAP-007/020/033 | 既有策略接线优先；动态工具开放依赖真实 grant/审批校验及最终输入容量检查；新根预算与 Driver/授权合同先 CR；进一步压缩与成本优化留 ITER-017 | 父取消后不进入子下一步；本地任务拒绝远程 Provider；工具可见；缺权限、错 scope、旧 revision、撤权/禁用和未批准写操作无副作用；最终输入加预留输出不超 Provider 窗口，超额有明确有界处理 | platform/ecosystem |
| <a id="iter-008"></a>ITER-008 · 执行中 | 模型制品与进程：路径/symlink、响应与续传验证；启动 epoch、有界探针/日志/指标请求；ARC-11/12；本地模型基础设施 | 正确性修复可独立进行；制品来源/信任等级变化先 CR | 不写出模型根、不注册错误正文/错位字节；旧 exit 不污染新进程；悬挂探针按期结束；停止状态真实 | platform（分支 `docs/build-to-delete-pi-architecture-plan`；2026-09-28 CR-056 BTD-04 模型 Driver 替换与代际生命周期已落地并通过扩展 SPI 4 项测试，下载其余正确性要求仍保留） |
| <a id="iter-009"></a>ITER-009 · 建议 | 配套形态决策：比较九个硬件方向、电脑依赖、目标 OS、真实 Provider、成本和数据边界；同时登记移动端草稿待决策事项；CAP-001/012/018/025/030/033 | 本项仅探索与样本验证；不默认批准采购、SKU、固件、移动端顺序或工期 | 有候选比较、继续/暂缓证据和一至两个验证方向；明确 §3 的待决策项与 ITER-016 范围 | product-hardware/desktop |
| <a id="iter-020"></a>ITER-020 · 已移交 | HLS 本地智能体竞赛规划：三人团队、C++ 与 RX 9070 XT 条件下的能力复用、验证路径、实验协议和交付边界；AVX-EXPL-013；关联 CAP-007/020/027（规划，不改变能力状态） | 本项仅文档交付；赛规、实测、实现授权和产品化分别判断，后续实验见 ITER-021 | 专项文档明确规则与环境、双入口、对照实验、冻结提交和产品回接路径；三人角色、预算估算、去留标准、来源和索引齐全，文档门禁通过 | platform/docs（分支 `docs/hls-competition-validation-plan`；2026-09-22 文档移交：P0～P4 路径、三人角色、四组对照、冻结产物与去留标准已登记；ci-docs 全量通过（治理回归 33/33、队列回归 9/9、78 文件排版/术语及严格治理无问题）；未实施竞赛能力） |
| <a id="iter-021"></a>ITER-021 · 建议 | HLS 竞赛可行性验证：规则与环境核对、双入口最小闭环、同模型配对对照与去留证据；AVX-EXPL-013 P0～P2；关联 CAP-007/020/027（探索） | 依据 ITER-020 的规划复核范围与可投入工时；新增模块/工具合同先 CR；只修实际复用路径，不等待 ITER-007/008/013 全部完成 | 本地模型与 Vitis 真正运行，裸跑/Agent 双入口公平且逐题可追溯；留出题报告分级通过率、增益、不确定性与成本，并给出继续、限定补证或暂缓结论 | platform/competition（模型环境、HLS 工具、Agent 评测三个角色，待认领） |
| <a id="iter-023"></a>ITER-023 · 已移交 | Build to Delete 与类 pi 架构详细规划：CR-056（已归档至 Aervox-docs-archive）的固定基线、目标边界、决策差量、实施切片、退出验收与回滚；关联 CAP-002/005/007/018/020/027/033（仅规划） | 本项仅交付 Proposed/Planned 的 CR；实现认领继续使用既有 ITER 条目，架构接受、代码实施和发布分别判断 | 每个切片给出输入依赖、代码落点、契约影响、测试、退出条件与回滚；规划接入唯一队列、追踪和索引，文档门禁通过 | platform/docs（分支 `docs/build-to-delete-pi-architecture-plan`；2026-09-28 文档移交：CR-056 的九个切片、两项试点、依赖估算及退出/回滚验收已登记；ci-docs 全量通过（治理 33/33、队列 9/9、79 文件排版/术语及严格治理无问题）；CR 保持 Proposed/Planned，未启动业务重构） |
| <a id="iter-030"></a>ITER-030 · 已移交 | DSH、pi、AstrBot 上游固定版本更新与差异复评：核对默认分支、许可证与适配准入，形成面向思隅的设计借鉴和验证建议；DSH-01/PI-01/AST-*；关联 CAP-007/020/027/033（参考维护与评估） | 仅更新参考基线及必要准入常量；产品能力和架构实施仍由既有 ITER 与 CR 决定 | 三个子模块固定到本次抓取的上游默认分支提交，保留旧版本可回溯；源码与测试证据区分本次变化、既有能力和未验证事项，映射思隅实际差量；参考清单、适配准入、追踪登记和文档门禁一致（校验：`git diff --submodule=short`；`mise tasks run ci-code`；`mise tasks run ci-docs`） | platform/docs（分支 `docs/update-reference-upstreams-20260929`；2026-09-29 移交：三个上游固定版本、源码/测试差异复评与 DSH 准入同步完成；ci-code 全量通过（测试 27/27 任务），ci-docs 全量通过；参考更新不代表真实外部运行时已集成，验证与限制见 §4.2/参考评估 §8） |
| <a id="iter-031"></a>ITER-031 · 已移交 | 标准工作台连续对话与雾蓝视觉重构；用户确认静态预览，关联 CAP-001/002/018 | 复用现有会话、发送、授权与插件接口；不新增服务端契约 | 标准模式完整展示多轮消息与流式全文，保留授权确认和插件插槽；雾蓝主题、底部收窄居中输入区通过亮暗主题及窄窗核验；桌宠陪伴模式分句显示继续可用（校验：`packages/ui/test/standard-conversation.test.ts`） | Codex（分支 `feat/workbench-frontend`；2026-09-29 用户确认并授权推送，功能分支待合并；ci-code、ci-docs 与 7 项回归通过；侧边栏加宽至 256px；合并解决 main 冲突并顺延为 ITER-031；UI 类型检查与测试全绿） |
| <a id="iter-029"></a>ITER-029 · 执行中 | 思隅 CLI 连接版首个切片：新增终端宿主 `@aervox/cli`（`siyu`）与 `@aervox/api-client/transport` 纯传输构建出口；提供单次问答、仅 TTY 连续会话、事件补读与终态等待、连接诊断、配置读写、JSON/JSONL 机器输出、Token 与幂等键、审批与用户问题、有界取消；CAP-002/007/020；CR-058 | 只消费本机 API 与共享传输层；不修改服务端路由、授权与恢复合同，不新增数据库 Schema，不引入中心化服务或独立宿主 | 打包产物在真实 API + 文件 SQLite 下完成受理/流式/终态、跨客户端与 API 重启的补读与续会话；非交互路径不自动批准工具；有界取消只在中断时触发，超时或失败不替用户取消已受理回合；架构拓扑、依赖边界与文档治理门禁通过，CLI 不反向依赖共享包，共享包也不反向引用 CLI 宿主（校验：`apps/cli/test/cli.test.ts`；`scripts/cli-smoke.test.mjs`；`packages/api-client/test/transport.test.ts`；`packages/api-client/test/projector.test.ts`；`scripts/import-boundary.test.mjs`） | Codex（分支 `feat/siyu-cli-attached`；2026-09-30 执行中：CLI 单次/连续会话、共享传输加固及端点测试通过；剩余会话详情/分页、模型配置入口及平台矩阵待补，保持执行中） |
| <a id="iter-032"></a>ITER-032 · 建议 | 保真上下文投影与真实摘要压缩：把 Turn 上下文装配改为「模型可见投影从权威历史重建」——先固化伴学必须保真的事实清单（当前学习目标、未解决错因、用户偏好、承诺及其来源），再以真实摘要替换规则压缩的占位文本（现默认关闭，仅保留首尾各两条并插入『已总结若干消息』说明，见 `packages/agent-loop/src/context-builder.ts`）；压缩按工具调用/结果组选择边界，超大结果不破坏配对；参考 PI-01 context_edit 投影设计（参考评估 §8.3）；CAP-002/005/007；对话质量基础设施 | 压缩不得伪造摘要或声称记得已压缩事实；模型可见投影不等于用户删除，删除仍须覆盖原文、摘要与索引；必须保真事实清单与压缩策略先评审，涉及对话契约差量先 CR；最终输入窗口验收与 ITER-007 协同、测量口径与 ITER-017 协同，不重复登记 | 固定长伴学对话夹具：压缩后学习目标、错因、承诺与来源保真可追溯，无占位文本；超大工具结果压缩不断开调用/结果配对；最终输入加预留输出不超 Provider 窗口，超额有明确有界处理；每次请求的模型可见上下文可从权威投影重建并复核，展示内容与持久历史分离、旧响应不覆盖终态（校验：`packages/agent-loop/test/context-builder.test.ts`；`packages/agent-loop/test/context-manifest.test.ts`） | platform/quality |

### 2.2 下一批：恢复、生命周期与部署

| 条目 / 状态 | 最小交付与依据 | 依赖及 CR 门槛 | 完成判定 | 建议责任（待认领） |
|---|---|---|---|---|
| <a id="iter-010"></a>ITER-010 · 建议 | 先修 Resume 库覆盖/事件高水位/执行关联/接管；再接审批与答案续跑、撤权账本及恢复水位；ARC-04/06；CAP-007/027/033 | 依赖 ITER-002/003/007 的必要切片；续跑、一次性授权/有效期、跨库恢复和账本保留先 CR；不直接启用现有 Resume Host | 缺账本、多工具、跨进程答案、重复接管与旧备份恢复不重复副作用、不吞答案、不复活撤权；未知结果不盲重放 | platform/data |
| <a id="iter-011"></a>ITER-011 · 建议 | 完整 Schema 迁移：排除 FTS shadow 表、真源重建；接线版本 journal、校验和、恢复状态；ARC-09；CAP-027 | 完整库失败夹具可立即补；迁移协调方案先评审，破坏性转换先 CR，生产操作另过门禁 | 每个支持旧版本升级、失败恢复、回滚通过；主库/Vault/账本归属明确；源库不受 staging 失败影响 | data/quality |
| <a id="iter-012"></a>ITER-012 · 建议 | 索引生命周期：dirty/reindex、来源修订、模型/维度版本、可切换投影；修可选回填旧列；中文固定语料；ARC-08；CAP-005/026 | 依赖 ITER-003；当前错误 SQL 可先修；投影切换和模型版本合同先评审，不能恢复旧隔离列 | 故障可追平；A→B→A 可切换；资格零越界；单列中文 Recall@K、空间、重建成本 | data |
| <a id="iter-013"></a>ITER-013 · 建议 | 有界运行和观测：Worker/Host drain、Provider 排队/取消、安全文本窗口、SSE 背压/分页、跨进程终态；复用 metrics；ARC-05/12、FND-05/06/09；CAP-007/018 | 依赖 ITER-002/008 的相关切片；先观测后定参数；跨进程通知/新隔离边界先 CR | 慢源/慢客户端和日志洪泛资源有界；停机有截止；已提交窗口提前可读；故障可定位 | platform/quality |
| <a id="iter-014"></a>ITER-014 · 已移交 | 模块公开 Port 与 Build to Delete：评审 ADR-014 的通信/装配差量，建立试点模块边界、MemoryStore 贡献与退出演练；ARC-10、CR-056（已归档至 Aervox-docs-archive）；CAP-005/007/020 与架构基础设施 | CR-056 相关决策先接受；模型 Driver 归 ITER-008，生命周期/控制协同 ITER-005/007/013；不要求先改完全部模块，也不阻塞已有缺陷修复 | 私有引用 fixture 失败、公开 Port 通过、模块可用 Fake Port 测试；实际依赖与批准规则一致；临时检出移除试点实现后非目标能力通过，资源无残留且数据权利连续 | platform（分支 `docs/build-to-delete-pi-architecture-plan`；2026-09-29 PR #230 四项审查阻断已修复并补证：生命周期/AST 回归与三阶段 11 包零缓存物理退出构建，真实 SQLite 数据权利和恢复通过；具体证据及发布限制见 CR-056 §10.2 / §4.2） |
| <a id="iter-015"></a>ITER-015 · 建议 | 单机部署主管：API/Worker/模型归属，数据目录、端口、Token、版本、就绪与退出；ARC-13；CAP-001/018/027 | 依赖 ITER-006/008 与 ITER-011/013 的必要部分；新主管先 CR；与移动端决策协调 | 干净用户目录安装、升级、异常退出、端口占用、磁盘满、卸载保留数据均验证；签名/公证/平台矩阵另过发布门禁 | desktop/release |
| <a id="iter-016"></a>ITER-016 · 建议 | 已选方向单设备 PoC：真实能力样本，模拟器与一块开发板，身份/ACK/幂等/截止/撤权/热插拔；硬件评估；复用所选 CAP | 依赖 ITER-009 决策；先设备 CR/ADR/单一协议；音频/OCR 先证明真实产物；独立算力盒额外依赖 ITER-015 | 设备缺席不破坏核心流程；获得五至十人使用记录及方向对应价值证据；不把接口响应当实物成功 | product-hardware/platform |
| <a id="iter-027"></a>ITER-027 · 待评审 | 多进程 SQLite 写入并发与 Worker 自适应退避：消除高频空轮询，流式会话写入期间后台任务自适应降频与 IPC 唤醒；ARC-05/FND-07；基础设施 | 依赖 ITER-002 的 Outbox 消费修复；不破坏 WAL 模式快照隔离与单写者约束 | API 执行多轮密集对话与流式写入期间，Worker 自动退避至 3s+ 低频轮询，写锁冲突率降至 0；探索基于本地 Domain Socket 或命名管道的事件驱动触发式唤醒，替代持续空写轮询；长周期运行与压测下无 SQLITE_BUSY 报错与 P99 延迟抖动（校验：`apps/worker/test/outbox-worker.test.ts`；`apps/worker/test/worker-concurrency-backoff.test.ts`；`apps/worker/test/worker-host.test.ts`；`packages/repositories/test/worker-ipc.test.ts`；`packages/repositories/test/turn-store-begin-contention.test.ts`；`packages/repositories/test/client-self-heal.test.ts`；`apps/api/test/worker-pressure-lease.test.ts`；`apps/api/test/conversation-dispatch-resilience.test.ts`） | platform/data（分支 `feat/iter-027-028-sqlite-worker-p2p`；2026-09-29 落地 IPC 唤醒、Worker 写入压力退避、API 侧压力租约与客户端连接自愈；并发与恢复单测全绿。2026-10-02 长周期压测补证（drill:worker-contention，10 分钟×2 轮）：真实单用户节奏（1 写入者 @1s）下验收 1/3 字面达成——写锁冲突率 0（0 换连接）、0 逃逸 busy、0 污染、退避全程生效（轮询 min 5297ms / p50 6005ms）、P99 10.5ms 无抖动、outbox 无积压完整性 OK；双写入者 @200ms 极端持续负载（≈每分钟 570 轮，超出单用户真实负载）下 0 逃逸错误、0 污染、P99 稳定 15.2ms，但存在被自愈吸收的冲突（640 次换连接）与 outbox 吞吐上限（487 条积压，生产 9.6 事件/s 超压力模式消费 8.75 事件/s），属负载边界行为而非锁错误，保持待评审） |
| <a id="iter-033"></a>ITER-033 · 建议 | 统一模型 Provider 抽象面：收敛两套模型接入栈——`@aervox/agent-loop` 的 OpenAI 兼容 Provider（对话路径，`src/openai-compat-provider.ts`）与 `apps/api` model-runtime 的 Driver SPI（本地 llama 侧车）；补齐统一 Provider 目录与代际注册、跨栈一致的 stop reason 归一与 usage 分账（复用 T-10）、跨 Provider 上下文交接与标准化测试 Provider；收敛 BTD-04 剩余 `Llama*` 类型泄漏，为多模型路由与成本治理铺路；参考 PI-01 `packages/ai` 设计（参考评估 §8.3）；CAP-002/007；本地模型基础设施 | 保持本地单用户与不出网红线：Driver 缺省仍为 unavailable 明确拒绝，受限本地任务缺合规 Provider 时不静默转远程；新增远程 Provider、改变制品信任等级或合并两栈持久化语义先 CR；不引入第二套 Provider 注册表真源；与 ITER-008 下载/进程正确性协同 | 同一 Fake/Replay Provider 轨迹下，对话与本地模型两条路径产出一致的规范化终止语义与 usage 分账（对照 provider-parity 表）；新增一个 OpenAI 兼容端点 Provider 仅需注册与目录声明，无需改动执行器、路由或宿主装配；临时检出移除 llama 具体实现后核心构建与数据权利回归通过（复用可移除性演练口径）；Driver 关闭与迟到启动语义保持 BTD-04 验收（校验：`packages/agent-loop/test/provider-parity.test.ts`；`apps/api/test/model-runtime-driver-spi.test.ts`） | platform |

### 2.3 后续候选：只有证据成立才投入

| 条目 / 状态 | 最小交付与依据 | 依赖及 CR 门槛 | 完成判定 | 建议责任（待认领） |
|---|---|---|---|---|
| <a id="iter-017"></a>ITER-017 · 建议 | 测量后分别决定 Prompt 预算/保真压缩、SQLite 写竞争、向量 topK、计算隔离和资产归属；FND-07/08/10、ARC-05/08/12；相关基础设施 | 依赖正确性修复与 ITER-013 指标；全局单写者、独立执行进程、二进制索引扩展先 CR | 同设备同数据报告延迟分位数、失败率、内存和质量；未达收益门槛即可停止；不承诺未测倍数 | platform/data/quality |
| <a id="iter-018"></a>ITER-018 · 建议 | 第二终端检验共享生命周期，再决策 PCB/结构/电源、样机和小批验证；硬件评估 | 依赖 ITER-016 价值成立；新增无线、电池、采集或运动能力分别评审，不因 PoC 成功自动批准量产 | 两种终端无需复制宿主；更新/回滚/删除可测；24→72 小时稳定性、功耗温升、密钥/追溯/维修验证；发布单列 | product-hardware/release |
| <a id="iter-019"></a>ITER-019 · 建议 | 是否开放第三方可执行插件；若开放，按已接受 [ADR-009](docs/reference/adr/ADR-009-electron-plugin-sandbox.md) 的进程外隔离、默认无权限与撤权要求设计 Host、签名信任根、SDK 与依赖解析 | 先证明声明式/第一方扩展不足，再用 CR 明确实现差量与生命周期；隔离基线不作为自由选项，改变基线须显式 CR；现行规范不代表运行能力已实现 | 有明确用例、威胁与成本比较，并通过 ADR-009 的拒绝/撤权/隔离/兼容验收；未选定前不建通用平台 | ecosystem/security |
| <a id="iter-022"></a>ITER-022 · 建议 | HLS 参赛方案扩大验证与冻结提交：正式评分接口、最终 32 GB 环境、离线容器、固定技能和复现报告；AVX-EXPL-013 P3 | ITER-021 证据支持继续且正式范围/必要 CR 已评审；先取得最新细则与提交窗口；本项不自动包含产品化、微调或硬件采购 | 官方目标环境在预算内完成，干净环境断网双入口可复现且冻结哈希一致；报告包含分级通过率、pass@1/pass@5、裸跑增益、墙钟和失败证据；产品化另作决定 | platform/competition |
| <a id="iter-028"></a>ITER-028 · 待评审 | 纯本地多端点对点加密同步探索：局域网发现（mDNS）、SQLite Changeset 增量对齐与去中心化数据同步；CAP-018/027；CR-030/CR-055 | 坚决不引入中心化多租户云端数据库；同步前必须通过端到端加密与用户显式配对授权 | 完成多设备同网发现 PoC（UDP 多播信标 + 静态对端兜底）与承诺-揭示零信任配对（Ed25519 身份签名、SAS 绑定完整 transcript、分向密钥与重放/乱序/篡改拒绝），替代原 TLS 证书配对设计；以行时间戳水位线 + 显式墓碑提取增量 Changeset（替代原 SQLite Session Extension 设计），验证无冲突双向合并与对抗性缺陷回归（接收端白名单、漂移行隔离、墓碑四向裁决）；移动端（Capacitor）与桌面端（Electron）局域网直连同步学习进度与错题本成功（校验：`packages/repositories/test/p2p-pairing-security.test.ts`；`packages/repositories/test/p2p-changeset-merge.test.ts`；`packages/repositories/test/p2p-changeset-sync.test.ts`；`packages/repositories/test/p2p-discovery.test.ts`；`packages/repositories/test/p2p-lan-sync.test.ts`） | desktop/mobile（分支 `feat/iter-027-028-sqlite-worker-p2p`；2026-09-29 已完成：承诺-揭示零信任配对、设备身份 0600 落盘、分向密钥与 Changeset 引擎设计，含 UDP 多播信标发现、分帧传输与真实环回 socket 端到端，P2P 用例合计 69 项通过（见 p2p-local-sync-exploration.md §3.1）；真实 mDNS/DNS-SD、生产接线与真实多设备直连待后续推进。2026-10-02 验收重述裁定（轻量文档裁定，依据 p2p-local-sync-exploration.md §2.2/§3.1 技术论证，维护者复核）：验收 1/2 按实际实现重述——承诺-揭示配对替代 TLS 证书配对、行时间戳水位线替代 Session Extension；验收 3 保留原文，保持待评审） |

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
| 评估类：[FND 评估](docs/explanation/foundation-optimization-review.md)、[ARC 评估](docs/explanation/architecture-implementation-review.md)、[参考设计迁移](docs/explanation/reference-design-transfer.md)、[Agent Loop 计划](docs/reference/agent-harness-loop.md#15-分阶段落地计划)与历史记录（已归档至 Aervox-docs-archive）、[Web 方案](docs/explanation/web-implementation.md)、[主动智能方案](docs/explanation/proactive-intelligence-mode.md) | 保留源码、实验、风险与方案；撤去独立当前排期，历史优先级只作评估时的风险标签；已实现部分不重做，未接线部分核验后入队 | 队列见 §2；证据与来源见各评估文档自身 |
| 硬件与移动：[硬件方向](docs/explanation/companion-hardware-directions.md)、[ESP32 方案](docs/explanation/esp32-s3-hardware-extension.md)、[CR-055](docs/reference/changes/CR-055-mobile-delivery-plan.md) | 两份硬件方向版本合成为单一文档，ESP32 保留完整正文作器件级事实源；移动规划随收割移入 `main` 并登记（Proposed/Planned），其平台顺序与工期估算只作提案参考 | §3 待决策项；ITER-009、016、018 |
| 需求与决策权威：[追踪基线 §4.1](docs/reference/REQUIREMENTS_TRACEABILITY.md#41-建议交付批次与拆分原则)、PRD/SRS、ADR、CR、数据库与安全契约、覆盖矩阵、[治理规范 §7](docs/reference/document-governance.md#7-分阶段迁移) | 保留各自需求/决策/验收权威，不因计划统一而降级或删除；建议批次转至本文件，§4.2 继续维护实现事实 | 本文件只引用 |
| 非迭代材料：`docs/CR-033-plan.md` 等旧计划（已归档且本地不存在）、`.workbuddy/REFACTOR-PLAN.md`、`.workbuddy/ARCHIVE-CANDIDATES.md`、`.zcode/plans/*.md`（Git 忽略的历史/会话快照）、StudyPlan 与学习/日记/复习排期、迁移与发布操作指南 | 旧计划不重新创建；忽略目录内的快照不删除、不强制纳入 Git、不作为当前队列（后续 Agent 先读本文件，旧建议须重新核验）；产品功能与操作程序保持原有归属 | 不进入本队列 |

## 6. 本次分支与后续维护

本轮规划在 `docs/iteration-plan-governance` 独立分支交付，评估基线为原 `feat/plugin-capability-consolidation` 的 `6b20e7e`；PR 准备时已对齐该分支的 `5e20a0e`，以保留后续 UI 提交及其独立登记。本次规划差量不修改 UI，实现审查以该功能分支为基准，并依赖 PR #218。合入 `main` 时应先确认底层功能分支已合入，再按当前基线复核；若采用 squash 导致祖先不同，优先只移植规划提交，不重复合入功能历史。

截至 2026-09-18，`#218`（`d91b121`）与 `#219`（`5584bdf`）均已合入 `main`；本轮另将 `docs/mobile-landing-plan` 的两条提交（`dff68b8`、`00d83ad`）连同 `CR-055` 收割进 `main`，并把两份硬件方向版本合成单一文档。该移动规划分支此后不再承载独立排期；后续硬件与移动的当前排序一律回到本文件维护。

ITER-001 的落地在 `fix/iter-001-ci-verification-entry` 独立分支交付，只修验证入口本身：工作流触发路径与 Turbo 声明同源、各 Job 显式锁文件安装、gitignore 生成物的声明恢复任务及其可重现性，以及本地增量门禁对包外输入的显式选择（登记见 [§4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)）。该分支不改业务代码、不改任何 CAP 的交付状态，也不开启已禁用的缓存。三条验收均有证据：干净 checkout 由 PR [#221](https://github.com/3yearsZhuang/Aervox-harness/pull/221) 的冷 CI 证明（Install/build/typecheck、E2E、Docs 全绿），仅插件变动会重新验证由 `scripts/ci-scope.test.mjs` 与反向验证守住，生成物由声明任务重建并断言。核对中还发现产品侧导出分发包同样不可重现，因涉及业务代码未在本分支修复，已追加到 ITER-005。ITER-002、003、008 等其余条目仍为建议态，待认领。

本文件不持有完整日志。§2 的队列不是手写表：真源在 `docs/_meta/plan-queue.json`，改条目后运行 `mise tasks run plan-render` 生成派生的 §2 表格，`mise tasks run plan-check` 校验结构、依赖与“状态—证据”一致性（已接入文档治理，2026-09-18 起强制级别为 `error`：H1–H6 与 S1–S4 一律阻断，仅 S5 依赖次序保持提示）。每次认领、调整和移交更新真源、元数据与签名，同步注册表；PR 说明列出关联 `ITER-*` 及是否改变计划。迭代复盘时合并重复项、明确暂停原因并压缩已移交项，避免计划退化为永久堆积的 TODO。
