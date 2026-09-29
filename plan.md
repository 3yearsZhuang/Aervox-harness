---
id: AVX-PLAN-001
type: reference
scope: guide
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
planning_role: current
version: 0.4.0
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
| <a id="iter-007"></a>ITER-007 · 建议 | 三个切片：父子任务/Driver 继承取消、截止、删除/授权修订与 local-only；执行时逐项核对 requiredPermissions/grants 的 scope/revision，由受信宿主映射 guarded/full_access 安全等级；动态工具 Schema 快照进入模型请求并在执行时重验；ARC-02/03、插件规范 §8.1；CAP-007/020/033 | 既有策略接线优先；动态工具开放依赖真实 grant/审批校验及最终输入容量检查；新根预算与 Driver/授权合同先 CR；进一步压缩与成本优化留 ITER-017 | 父取消后不进入子下一步；本地任务拒绝远程 Provider；工具可见；缺权限、错 scope、旧 revision、撤权/禁用和未批准写操作无副作用；最终输入加预留输出不超 Provider 窗口，超额有明确有界处理 | platform/ecosystem |
| <a id="iter-008"></a>ITER-008 · 执行中 | 模型制品与进程：路径/symlink、响应与续传验证；启动 epoch、有界探针/日志/指标请求；ARC-11/12；本地模型基础设施 | 正确性修复可独立进行；制品来源/信任等级变化先 CR | 不写出模型根、不注册错误正文/错位字节；旧 exit 不污染新进程；悬挂探针按期结束；停止状态真实 | platform（分支 `docs/build-to-delete-pi-architecture-plan`；2026-09-28 CR-056 BTD-04 模型 Driver 替换与代际生命周期已落地并通过扩展 SPI 4 项测试，下载其余正确性要求仍保留） |
| <a id="iter-009"></a>ITER-009 · 建议 | 配套形态决策：比较九个硬件方向、电脑依赖、目标 OS、真实 Provider、成本和数据边界；同时登记移动端草稿待决策事项；CAP-001/012/018/025/030/033 | 本项仅探索与样本验证；不默认批准采购、SKU、固件、移动端顺序或工期 | 有候选比较、继续/暂缓证据和一至两个验证方向；明确 §3 的待决策项与 ITER-016 范围 | product-hardware/desktop |
| <a id="iter-020"></a>ITER-020 · 已移交 | HLS 本地智能体竞赛规划：三人团队、C++ 与 RX 9070 XT 条件下的能力复用、验证路径、实验协议和交付边界；AVX-EXPL-013；关联 CAP-007/020/027（规划，不改变能力状态） | 本项仅文档交付；赛规、实测、实现授权和产品化分别判断，后续实验见 ITER-021 | 专项文档明确规则与环境、双入口、对照实验、冻结提交和产品回接路径；三人角色、预算估算、去留标准、来源和索引齐全，文档门禁通过 | platform/docs（分支 `docs/hls-competition-validation-plan`；2026-09-22 文档移交：P0～P4 路径、三人角色、四组对照、冻结产物与去留标准已登记；ci-docs 全量通过（治理回归 33/33、队列回归 9/9、78 文件排版/术语及严格治理无问题）；未实施竞赛能力） |
| <a id="iter-021"></a>ITER-021 · 建议 | HLS 竞赛可行性验证：规则与环境核对、双入口最小闭环、同模型配对对照与去留证据；AVX-EXPL-013 P0～P2；关联 CAP-007/020/027（探索） | 依据 ITER-020 的规划复核范围与可投入工时；新增模块/工具合同先 CR；只修实际复用路径，不等待 ITER-007/008/013 全部完成 | 本地模型与 Vitis 真正运行，裸跑/Agent 双入口公平且逐题可追溯；留出题报告分级通过率、增益、不确定性与成本，并给出继续、限定补证或暂缓结论 | platform/competition（模型环境、HLS 工具、Agent 评测三个角色，待认领） |
| <a id="iter-023"></a>ITER-023 · 已移交 | Build to Delete 与类 pi 架构详细规划：[CR-056](docs/reference/changes/CR-056-build-to-delete-pi-style-architecture.md) 的固定基线、目标边界、决策差量、实施切片、退出验收与回滚；关联 CAP-002/005/007/018/020/027/033（仅规划） | 本项仅交付 Proposed/Planned 的 CR；实现认领继续使用既有 ITER 条目，架构接受、代码实施和发布分别判断 | 每个切片给出输入依赖、代码落点、契约影响、测试、退出条件与回滚；规划接入唯一队列、追踪和索引，文档门禁通过 | platform/docs（分支 `docs/build-to-delete-pi-architecture-plan`；2026-09-28 文档移交：CR-056 的九个切片、两项试点、依赖估算及退出/回滚验收已登记；ci-docs 全量通过（治理 33/33、队列 9/9、79 文件排版/术语及严格治理无问题）；CR 保持 Proposed/Planned，未启动业务重构） |

### 2.2 下一批：恢复、生命周期与部署

| 条目 / 状态 | 最小交付与依据 | 依赖及 CR 门槛 | 完成判定 | 建议责任（待认领） |
|---|---|---|---|---|
| <a id="iter-010"></a>ITER-010 · 建议 | 先修 Resume 库覆盖/事件高水位/执行关联/接管；再接审批与答案续跑、撤权账本及恢复水位；ARC-04/06；CAP-007/027/033 | 依赖 ITER-002/003/007 的必要切片；续跑、一次性授权/有效期、跨库恢复和账本保留先 CR；不直接启用现有 Resume Host | 缺账本、多工具、跨进程答案、重复接管与旧备份恢复不重复副作用、不吞答案、不复活撤权；未知结果不盲重放 | platform/data |
| <a id="iter-011"></a>ITER-011 · 建议 | 完整 Schema 迁移：排除 FTS shadow 表、真源重建；接线版本 journal、校验和、恢复状态；ARC-09；CAP-027 | 完整库失败夹具可立即补；迁移协调方案先评审，破坏性转换先 CR，生产操作另过门禁 | 每个支持旧版本升级、失败恢复、回滚通过；主库/Vault/账本归属明确；源库不受 staging 失败影响 | data/quality |
| <a id="iter-012"></a>ITER-012 · 建议 | 索引生命周期：dirty/reindex、来源修订、模型/维度版本、可切换投影；修可选回填旧列；中文固定语料；ARC-08；CAP-005/026 | 依赖 ITER-003；当前错误 SQL 可先修；投影切换和模型版本合同先评审，不能恢复旧隔离列 | 故障可追平；A→B→A 可切换；资格零越界；单列中文 Recall@K、空间、重建成本 | data |
| <a id="iter-013"></a>ITER-013 · 建议 | 有界运行和观测：Worker/Host drain、Provider 排队/取消、安全文本窗口、SSE 背压/分页、跨进程终态；复用 metrics；ARC-05/12、FND-05/06/09；CAP-007/018 | 依赖 ITER-002/008 的相关切片；先观测后定参数；跨进程通知/新隔离边界先 CR | 慢源/慢客户端和日志洪泛资源有界；停机有截止；已提交窗口提前可读；故障可定位 | platform/quality |
| <a id="iter-014"></a>ITER-014 · 待评审 | 模块公开 Port 与 Build to Delete：评审 ADR-014 的通信/装配差量，建立试点模块边界、MemoryStore 贡献与退出演练；ARC-10、[CR-056](docs/reference/changes/CR-056-build-to-delete-pi-style-architecture.md)；CAP-005/007/020 与架构基础设施 | CR-056 相关决策先接受；模型 Driver 归 ITER-008，生命周期/控制协同 ITER-005/007/013；不要求先改完全部模块，也不阻塞已有缺陷修复 | 私有引用 fixture 失败、公开 Port 通过、模块可用 Fake Port 测试；实际依赖与批准规则一致；临时检出移除试点实现后非目标能力通过，资源无残留且数据权利连续 | platform（分支 `docs/build-to-delete-pi-architecture-plan`；2026-09-29 PR #230 复核撤回移交：工具开关后释放失效、Driver 迟到启动与动态导入漏检已复现，物理退出和存量数据权利仍缺证据；文档 CI 链接已修复，具体差量见 CR-056 §10.1 与 §4.2） |
| <a id="iter-015"></a>ITER-015 · 建议 | 单机部署主管：API/Worker/模型归属，数据目录、端口、Token、版本、就绪与退出；ARC-13；CAP-001/018/027 | 依赖 ITER-006/008 与 ITER-011/013 的必要部分；新主管先 CR；与移动端决策协调 | 干净用户目录安装、升级、异常退出、端口占用、磁盘满、卸载保留数据均验证；签名/公证/平台矩阵另过发布门禁 | desktop/release |
| <a id="iter-016"></a>ITER-016 · 建议 | 已选方向单设备 PoC：真实能力样本，模拟器与一块开发板，身份/ACK/幂等/截止/撤权/热插拔；硬件评估；复用所选 CAP | 依赖 ITER-009 决策；先设备 CR/ADR/单一协议；音频/OCR 先证明真实产物；独立算力盒额外依赖 ITER-015 | 设备缺席不破坏核心流程；获得五至十人使用记录及方向对应价值证据；不把接口响应当实物成功 | product-hardware/platform |

### 2.3 后续候选：只有证据成立才投入

| 条目 / 状态 | 最小交付与依据 | 依赖及 CR 门槛 | 完成判定 | 建议责任（待认领） |
|---|---|---|---|---|
| <a id="iter-017"></a>ITER-017 · 建议 | 测量后分别决定 Prompt 预算/保真压缩、SQLite 写竞争、向量 topK、计算隔离和资产归属；FND-07/08/10、ARC-05/08/12；相关基础设施 | 依赖正确性修复与 ITER-013 指标；全局单写者、独立执行进程、二进制索引扩展先 CR | 同设备同数据报告延迟分位数、失败率、内存和质量；未达收益门槛即可停止；不承诺未测倍数 | platform/data/quality |
| <a id="iter-018"></a>ITER-018 · 建议 | 第二终端检验共享生命周期，再决策 PCB/结构/电源、样机和小批验证；硬件评估 | 依赖 ITER-016 价值成立；新增无线、电池、采集或运动能力分别评审，不因 PoC 成功自动批准量产 | 两种终端无需复制宿主；更新/回滚/删除可测；24→72 小时稳定性、功耗温升、密钥/追溯/维修验证；发布单列 | product-hardware/release |
| <a id="iter-019"></a>ITER-019 · 建议 | 是否开放第三方可执行插件；若开放，按已接受 [ADR-009](docs/reference/adr/ADR-009-electron-plugin-sandbox.md) 的进程外隔离、默认无权限与撤权要求设计 Host、签名信任根、SDK 与依赖解析 | 先证明声明式/第一方扩展不足，再用 CR 明确实现差量与生命周期；隔离基线不作为自由选项，改变基线须显式 CR；现行规范不代表运行能力已实现 | 有明确用例、威胁与成本比较，并通过 ADR-009 的拒绝/撤权/隔离/兼容验收；未选定前不建通用平台 | ecosystem/security |
| <a id="iter-022"></a>ITER-022 · 建议 | HLS 参赛方案扩大验证与冻结提交：正式评分接口、最终 32 GB 环境、离线容器、固定技能和复现报告；AVX-EXPL-013 P3 | ITER-021 证据支持继续且正式范围/必要 CR 已评审；先取得最新细则与提交窗口；本项不自动包含产品化、微调或硬件采购 | 官方目标环境在预算内完成，干净环境断网双入口可复现且冻结哈希一致；报告包含分级通过率、pass@1/pass@5、裸跑增益、墙钟和失败证据；产品化另作决定 | platform/competition |

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
