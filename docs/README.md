---
id: AVX-DOC-001
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.14.0
updated_at: 2026-09-18
reviewed_at: 2026-09-18
review_interval_days: 90
---

# Aervox｜思隅 产品与工程文档索引

- 提出人：3yearszhuang · 2026-08-26
- 修改人：WorkBuddy · 2026-09-18

本目录把产品目标、可测试需求、架构决策、数据权利和 AI 质量分开维护，避免单一 PRD 同时承担所有细节。所有上线范围必须能从用户价值追踪到需求、设计、测试和发布证据。

## 1. 文档体系与事实源

### 产品与需求

| 文档 | 负责回答 | 事实源边界 |
|---|---|---|
| [当前迭代计划](../plan.md)（AVX-PLAN-001） | 接下来建议做什么、依赖什么、谁认领、怎样移交 | 当前迭代建议的唯一入口；不改写需求、决策或发布事实 |
| [PRD](reference/PRD.md) | 为什么做、为谁做、全生命周期做什么、用户层面如何验收 | 产品定位、场景、CAP-001～CAP-035、优先级、路线和用户级指标 |
| [能力验收标准附录](reference/prd-cap-acceptance.md)（AVX-PRD-002） | P1/P2/P3 差异化与连接生态能力、主动智能专项能力的验收标准是什么 | 最低可验收结果、DoR 晋级条件、CAP-033/034/035 专项边界 |
| [SRS](reference/SRS.md)（AVX-SRS-001） | 发布范围内每个行为、异常和业务规则如何原子化 | FR/BR/NFR、Given/When/Then 验收和测试 ID |
| [主动智能与外部信号需求规格](reference/srs-proactive-intelligence.md)（AVX-SRS-002） | CAP-033 全域感知与个人画像、CAP-034 Home Assistant 连接与 CAP-035 运动健康信号连接原子需求规格 | 授权、观察、画像、后台、动作、派生能力、连接器、DATA/AIQ/SEC/PRIV/OPS 要求 |
| [需求追踪与交付标准](reference/REQUIREMENTS_TRACEABILITY.md) | 每条需求是否完整、由谁负责、怎样证明交付，以及代码落地完成情况 | ID、状态、DoR/DoD、CAP 映射、测试证据、发布门禁、风险和变更控制；§4.1 规格化原则与计划入口；§4.2 落地实现登记 |
| 能力拆分路线（AVX-EXPL-004，已归档至归档库，见[§4.1](#41-能力拆分路线建议批次)） | CAP 按什么批次、什么顺序进入规格化与开发 | 历史存根；当前建议已统一到根 plan.md，追踪基线保留依赖与规格化原则 |

### 架构与决策

| 文档 | 负责回答 | 事实源边界 |
|---|---|---|
| [架构设计](reference/ARCHITECTURE.md) | 系统如何实现和演进 | TypeScript 全栈选型、C4、模块/数据所有权、部署、可靠性、安全和 ADR |
| [视觉系统与设计规范](reference/DESIGN.md)（AVX-DS-001） | 界面视觉哲学、色彩矩阵、字阶架构与组件实体触感规范 | 统一 Design Tokens、单主色秩序、Doppelrand 双层边框、禁止模式与微动效 |
| [ADR 索引](reference/adr/README.md) | 为什么选择当前架构、舍弃了什么方案 | 架构决策状态、后果、迁移和回滚边界 |
| [能力组合与可选化目录规范](reference/capability-composition.md)（AVX-CAP-001） | 所有业务能力最终如何通过 Manifest、Provider、Adapter 和 Profile 自由组合 | 目标目录、Kernel 不变量、依赖解析、生命周期、DSH/pi 适配与迁移验收 |
| [能力注册表](reference/capability-registry.md)（AVX-CAP-REG-001） | 哪些能力纳入自选机制、以什么方式启用、当前处于哪个状态 | 交付载体与启用方式、CAP 分类与已注册模块登记；判定规则与交付机制见 AVX-CAP-001 |

### Agent 与流式协议

| 文档 | 负责回答 | 事实源边界 |
|---|---|---|
| [Agent Harness Loop 设计与落地规范](reference/agent-harness-loop.md)（AVX-HAR-001） | 一次 Agent Turn 如何经过 Context、模型、工具、多 Step、取消恢复并安全终止 | Loop 状态机、Port、持久化、工具管线、限额、DSH/pi Driver 与分阶段迁移 |
| [Agent Loop 落地进展追溯](reference/agent-loop-rollout-history.md)（AVX-HAR-002） | Agent Harness Loop 各阶段（2b 至 6f）详细的代码落位、数据表、测试用例与历史进展追溯 | 取消闭环、预算闸门、工具幂等、可观测性、三级恢复、收件箱、Context 压缩、Subagent 贡献与 DSH 适配 |
| [流式协议契约](reference/STREAMING_PROTOCOL.md) | Turn 创建、SSE 事件、幂等、重连、取消和部分响应如何保持一致 | OpenAPI 配套的机器可验证事件 envelope、状态机、游标、保留和安全持久化规则 |
| [Aervox 插件开发规范](reference/plugin-config-and-pages.md)（AVX-PLUG-001） | 插件如何声明、开发、打包、安装、授权、扩展与维护 | Manifest、Config、Page、工具与 Skill、Turn 与 UI、兼容性、验证清单及当前实现边界 |

### 数据与隐私

| 文档 | 负责回答 | 事实源边界 |
|---|---|---|
| [SQLite 本地单用户数据库契约](reference/DATABASE.md) | SQLite 永久本地真源、Schema/Repository 双包、无租户目标、破坏性迁移与删除传播规则 | 机器事实源、Repository Port、CR-030 staging/原子换库、回滚与 TC 门禁 |
| [数据库数据模型覆盖矩阵](reference/database-coverage-matrix.md)（AVX-DB-002） | PRD §8 实体在 SQLite 中的落表状态和 CR-030 过渡状态 | 逐实体阶段、对应表、仓储 Port、DDL 初始化与 PRD 数据模型映射 |
| [数据与隐私规范](reference/DATA_PRIVACY.md) | 数据为什么收集、何时召回/保留/删除、谁能访问 | 数据分类、同意、来源链、保留表、删除传播、导出和审计 |

### 质量、安全与运维

| 文档 | 负责回答 | 事实源边界 |
|---|---|---|
| [AI 质量与安全规范](reference/AI_QUALITY_SAFETY.md) | 模型、记忆和日记怎样达到可复现质量与安全门槛 | 模型运行记录、评估集、记忆压缩、日记事实性、安全分类和回滚 |
| [威胁模型](reference/THREAT_MODEL.md) | 哪些资产和信任边界会受到何种攻击 | 威胁场景、控制、验证、残余风险和安全评审输入 |
| [测试策略](reference/TEST_STRATEGY.md) | 各类需求怎样验证、哪些路径阻断发布 | 测试分层、P0 必测路径、AI 评估、覆盖门槛和证据要求 |
| [运行、值班与演练手册](reference/operations.md) | 生产故障怎样止损、恢复和验证；出问题找谁、如何升级；季度演练留什么证 | 告警、事件响应、降级、恢复、回滚、值班与 SEV 升级、演练项与证据字段；G5 门禁引用 |

### 教程与操作指南

| 文档 | 负责回答 | 事实源边界 |
|---|---|---|
| [教程：第一个对话](tutorials/first-conversation.md)（AVX-TUT-001） | 新成员如何从 0 跑到第一条对话 | 可执行步骤与验证 |
| [教程：迁移已集成能力并接入 DSH/pi](tutorials/migrate-integrated-capabilities.md)（AVX-TUT-002） | 如何把现有 tools/plugins/skills 迁移为可组合能力，并设计 DSH/pi 适配器 | 原生能力迁移、Job Handler、外部 Host、Profile、撤权和回滚演练 |
| [教程：编写自定义 Agent 工具](tutorials/create-agent-tool.md)（AVX-TUT-003） | 如何为 Aervox Agent 编写一个自定义工具并接入运行时与安全检查 | 工具参数 Schema、ToolHandler 实现、只读/审批安全级别与单测验证 |
| [操作指南](how-to/README.md)（AVX-HOW-001） | 怎么新增/修改需求、写 ADR、过发布会门禁、做季度演练、管可选模块 submodule；贡献者流程见根级 [CONTRIBUTING](../CONTRIBUTING.md) | 任务型流程导航与操作指引（工程流程、写 ADR、submodule 协作）；规则以对应专项文档为事实源 |
| [开发 Aervox 扩展插件](how-to/develop-plugin-ui-extension.md)（AVX-GUIDE-004） | 如何完成最小插件并验证打包、配置和扩展行为 | 可跟做示例、声明式分发包、第一方扩展接线与验证步骤 |
| [操作指南：提出与闭环 CR](how-to/cr-workflow.md)（AVX-GUIDE-005） | 如何为 Aervox 提出、撰写、实施并闭环一个变更请求（CR） | 变更分级、差量分析、CR 模板、回滚预案与 §4.2 落地登记 |
| [操作指南：执行 SQLite 换库演练](how-to/run-database-migration-drill.md)（AVX-GUIDE-006） | 如何执行 CR-030 破坏性迁移、staging 隔离校验与原子换库回滚 | 不可变备份、单用户数据抽取、双向校验、原子换库与回滚命令 |
| [操作指南：新增与规格化 CAP 能力](how-to/add-capability.md)（AVX-GUIDE-007） | 如何在 Aervox 中立项、规格化、推进并落地一个全新的 CAP 业务能力 | PRD 场景、SRS 原子需求、AC 验收条件、DoR 门禁与追踪矩阵 |

### 概念与设计方案

| 文档 | 负责回答 | 事实源边界 |
|---|---|---|
| [数据流总览](explanation/data-flow-overview.md)（AVX-EXPL-001） | 消息端到端如何流动 | 先写后投递、Worker 周期、记忆/知识写入 |
| [参考项目能力迁移与借鉴评估](explanation/reference-design-transfer.md)（AVX-EXPL-002） | 参考项目哪些设计值得落地或借鉴 | 判定框架、来源映射、历史评估与 AGPL 边界；当前排序见根 plan.md |
| [桌宠角色设定文档化与多人格模板组织](explanation/persona-organization.md)（AVX-EXPL-003） | 桌宠 IP 与多人格模板（CAP-019）的角色如何文档化、版本化并维护 | 角色文档清单、字段化结构（prompt/开场白/语气/技能/错误兜底语）、人设目录与模板版本化、维护责任 |
| [主动智能模式](explanation/proactive-intelligence-mode.md)（AVX-EXPL-008） | 完全访问上如何以广域画像授权、OS 能力、特权观察 Host、本地私密数据和主动操作组合既有 CAP | 评审提案；不替代 PRD/SRS/DATA_PRIVACY/ADR，不表示运行时已实现 |
| [ESP32-S3 硬件延伸方案](explanation/esp32-s3-hardware-extension.md)（AVX-EXPL-005） | 如何把 ESP32-S3 做成物理桌宠终端 | 器件级设计输入：硬件边界、表现映射、设备协议与隐私红线；跨产品方向取舍与阶段准入见[配套硬件方向](explanation/companion-hardware-directions.md)（AVX-EXPL-011） |
| [底层优化审阅与建议](explanation/foundation-optimization-review.md)（AVX-EXPL-010） | 当前基础设施有哪些可验证的问题、应如何排序改进 | 代码证据、触发条件、优先级、改进成本与验收建议；不代表修复完成 |
| [当前架构实现与演进评估](explanation/architecture-implementation-review.md)（AVX-EXPL-012） | 实际进程、数据和执行链路如何运转，底层应如何继续演进 | 14 个深入专题、故障实验、模块边界、持久恢复、资源与部署、选项权衡和测量计划；不改写已接受决策 |
| [配套硬件方向：能力核查、移动协同取舍与原型路线](explanation/companion-hardware-directions.md)（AVX-EXPL-011） | 当前能力能支撑哪些硬件、手机已替代什么、哪些值得保留、如何从最小原型推进 | 能力现状与真机缺口、九方向实证、手机重合与过度设计取舍、ESP32 工程边界、成本口径、阶段准入、停止条件与验证矩阵；不冻结设备协议；器件级事实仍见 [ESP32-S3 硬件延伸方案](explanation/esp32-s3-hardware-extension.md) |
| Home Assistant 集成评估（已归档）（AVX-EXPL-006） | 如何为 Aervox 引入 Home Assistant 支持 | 候选方案与后续路线；推荐组合已由 CR-024/ADR-019 接受 |
| 运动与健康数据接入评估（已归档）（AVX-EXPL-007） | 是否可以接入苹果/小米运动健康数据（步数、睡眠、情绪） | 小米每日指标路径已由 CR-024/ADR-019 接受；苹果与情绪健康仍为评估输入 |
| 数据库拆分计划（已归档）（AVX-EXPL-009） | `packages/database` 如何拆分为 `@aervox/schema` 与 `@aervox/repositories` | 已完成的六阶段拆分执行记录；架构决策见 ADR-014 |
| [Web 工作台实现说明](explanation/web-implementation.md)（AVX-WEB-001） | `apps/web` 工作台如何基于 Vue 单栈复用 Desktop 核心组件 | 实现边界、历史里程碑与目录结构；技术栈见 ADR-015，当前排序见根 plan.md |

### 文档治理与生命周期

| 文档 | 负责回答 | 事实源边界 |
|---|---|---|
| [文档治理与事实源规范](reference/document-governance.md)（AVX-DOC-GOV-001） | 文档如何分类、标记状态、确定唯一事实源并触发复核 | 分类、事实源矩阵、元数据、状态模型、owner、复核触发器与分阶段迁移 |
| [文档写作规范](reference/standards/doc-standards.md)（AVX-STD-001） | 每份文档如何使用模板、命名、写作并通过门禁 | 写作体例、签名、命名、风格基线、Vale 术语门禁与模板族；治理规则见 AVX-DOC-GOV-001 |
| [代码与 API 命名规范](reference/standards/naming-conventions.md)（AVX-STD-002） | 代码 / API 命名的唯一一致性标准 | 标识符与上下文 `ctx`、路由与 HTTP 语义、包名与目录组织、禁止词与术语开关；陈旧信号见 DOC_REGISTRY |
| [术语表](reference/standards/terminology.md)（AVX-TERM-001） | 项目术语的唯一含义与规范写法 | 缩写/产品名唯一语义；Vale 依据「禁写」列自动校验 |
| [文档生命周期登记表](DOC_REGISTRY.md) | 每份文档何时核验、多久复核、什么信号表示陈旧 | 核验节奏/陈旧信号；独立于索引维护 |
| [从这里开始](getting-started.md)（AVX-DOC-002，见[§7](#7-从哪开始)） | 新成员/Agent 从哪看起、提交前自检什么 | 导航型；不承载规则 |
| [暂存提案](proposals) | 尚未进入基线的方案是什么 | 待补充证据（More Evidence Required）或未采纳的技术探索提案；不承载已批准规则 |
| [变更请求](reference/changes)（现行 CR，编号 ≥ CR-053） | 尚未归档的现行变更提案与决策 | 变更差量、决策状态与回滚预案；已闭环提案（CR-002~052）见私有归档库 |
| [移动端落地规划](reference/changes/CR-055-mobile-delivery-plan.md)（CR-055） | 移动 Web、Capacitor 配套端与独立手机端如何分阶段推进 | 待评审提案：范围、连接与数据边界、实施切片及验收；不代表移动端已交付 |
| 已归档记录（私有归档库） | 历史变更与已退役决策的原始记录是什么 | 已完成或已退役的历史变更；已整体移入独立私有归档仓库，避免混淆当前活跃规范 |

### 历史变更请求与临时落地计划归档说明

为保持主仓库文档精炼、避免历史推演过程污染日常检索与 AI 编程上下文，**已确认闭环实施的变更提案（CR-002 至 CR-052，共 50 篇）以及阶段性临时落地计划（CR-033/034/035 plan）已整体归档至独立私有归档仓库 [Aervox-docs-archive](https://github.com/3yearsZhuang/Aervox-docs-archive)**。编号自 **CR-053** 起恢复在主仓库 `docs/reference/changes/` 建立现行变更提案。

- 主仓库只维护反映当前系统状态的**现行权威真源（Living System Truth）**；
- 业务需求以 [PRD](reference/PRD.md) 与 [需求追踪与交付基线](reference/REQUIREMENTS_TRACEABILITY.md) 为准；
- 架构设计与数据库契约以 [架构设计](reference/ARCHITECTURE.md) 与 [数据库契约](reference/DATABASE.md) 为准；
- 如需回溯历史提案细节或阶段性计划推演，请查阅私有归档仓库 [Aervox-docs-archive](https://github.com/3yearsZhuang/Aervox-docs-archive)。

### 1.1 文档生命周期登记表（核验节奏与陈旧信号）

每份关键文档的最后核验时间、核验节奏与陈旧信号，独立维护在[文档生命周期登记表](DOC_REGISTRY.md)（AVX-DOC-CONF-001）；文档历史责任由各文档标题下的 `- 提出人 / - 修改人` 点阵签名追踪。何时更新登记、哪些代码路径触发复核，以[文档治理规范 §5-6](reference/document-governance.md#5-维护责任和更新触发器)为准。

## 2. 权威顺序与冲突处理

1. 已批准的法律、安全和隐私政策优先于产品或技术便利。
2. PRD 决定用户价值、范围和不可突破的产品边界。
3. 原子需求/SRS 决定具体行为和验收条件。
4. 架构设计与 ADR 决定已批准实现方案。
5. OpenAPI、数据库迁移和事件契约是实现接口的机器可验证事实源。
6. 测试和发布记录证明某一版本是否兑现需求，但不能反向修改需求含义。

文档冲突时停止相关发布，创建 `CR-*`，记录受影响的 `CAP/FR/NFR/DATA/AIQ/SEC/PRIV`，经评审批准后同步修订；不得在代码或口头沟通中静默选择一种解释。变更留痕见各文档头部的 `- 修改人` 签名。

## 3. 文档状态

文档可用性、决策批准情况和代码交付进度是三个独立维度，允许值与组合规则以[文档治理规范 §4](reference/document-governance.md#4-元数据和状态模型)为唯一事实源。本索引只展示入口，不从 CR/ADR 正文反推交付状态。

当前文档集整体仍为 `Review Candidate`：它可以指导进一步规格化和原型实现，但不能替代生产发布批准或对应测试证据。

## 4. 更新与评审节奏

- 每个版本规划开始时：确认 CAP 范围、实验、NFR、数据影响。
- 需求进入开发前：通过 Definition of Ready，并冻结对应 AC 和测试策略。
- 每个 RC：执行需求、架构、隐私、安全、AI 评估和恢复门禁。
- 上线后 7/30 天：核对业务指标、错误预算、AI 错误、安全事件、删除积压和成本。
- 每季度：复核数据保留表、供应商、许可证、依赖版本、灾备演练和风险登记。
- 文档每次变更：更新版本、日期、变更摘要、`- 修改人` 签名和关联 `CR/ADR/EXP`，不得只修改正文。

阶段命名唯一映射：`R0=原型验证`、`R1=MVP`、`R1.5=MVP+`、`R2=P1 学习深化`、`R3=端形态扩展`、`R4=P2 连接智能化`、`R5=P3 生态规模化`。`P0～P3` 是能力优先级，不是发布阶段；产品发布计划表必须同时写两者。工程工作包的迭代批次不重新定义产品阶段。

### 4.1 能力拆分路线（建议批次）

当前迭代的建议顺序、依赖和认领状态统一在根目录 [plan.md](../plan.md) 维护。[需求追踪基线 §4.1](reference/REQUIREMENTS_TRACEABILITY.md#41-建议交付批次与拆分原则)保留 CAP 依赖与规格化原则（历史原文见私有归档仓库 AVX-EXPL-004）；能力从 `Mapped` 转 `Specified` 的实际状态仍以[追踪基线覆盖矩阵](reference/REQUIREMENTS_TRACEABILITY.md#4-cap-001cap-035-覆盖矩阵全部能力状态唯一速览)为准。

## 5. 专业基线自检

一个能力只有同时满足以下条件，才可称为“需求已就绪”：

- 有稳定 ID、目标用户、业务理由、范围和非目标；
- 主流程、异常、权限、空状态、撤销和删除影响明确；
- 有可观测且可重复的验收条件，不以“智能、自然、友好”等形容词代替；
- 数据、AI、安全、隐私、无障碍、性能、成本和迁移影响已评审；
- 与 UX、API、数据实体、ADR、测试、埋点和目标版本双向关联；
- 待验证判断登记为 `EXP-*`，风险登记为 `RISK-*`，不可逆决策登记为 `ADR-*`；
- 发布后仍支持导出、更正、删除、降级、回滚和服务退出。

## 6. 参考项目

以下 6 个项目均已作为固定 commit 的子模块放入仓库 `reference/`，用于验证设计假设与寻找实现模式；不作为 MVP 运行时强依赖：

- `reference/baishou-next`（[BaiShou-Next](https://github.com/foxletters-hq/BaiShou-Next)）：研究 TypeScript 多端、本地数据、记忆与日记设计；AGPLv3，默认只借鉴公开思想，不复制代码。
- `reference/dsh-synapse`（[dsh-synapse](https://github.com/liangmianya/dsh-synapse)）：研究会话分支、地图投影和 DSH 插件边界；MIT。
- `reference/deepseek-harness`（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）：研究稳定接口、会话、模型提供方与扩展能力；MIT。
- `reference/pi`（[pi monorepo](https://github.com/earendil-works/pi)）：研究可替换模型、会话与扩展接口；MIT。
- `reference/AstrBot`（[AstrBot](https://github.com/AstrBotDevs/AstrBot)）：研究管线阶段、会话锁、插件元数据与人设管理；AGPLv3，默认只借鉴公开思想，不复制代码。
- `reference/Petra`（[Petra](https://github.com/Wumiu/Petra)）：研究桌宠表现命令通道、自主行为引擎与记忆条目字段；MIT。

借鉴设计不等于验证用户需求，也不等于自动通过许可证、安全或维护性评审。

固定 commit 与许可证清单以 [PRD 15.1](reference/PRD.md#prd-reference-manifest) 为唯一事实源（复核日期 2026-08-26）；任何升级需建立 `CR-*`、重跑许可证/契约测试并更新复核日期。

## 7. 从哪开始

> 面向新成员或首次接触本仓库的 AI Agent 的完整 onboarding（仓库结构、阅读顺序、写作硬规则、Docs CI 自检、介入路径），见[从哪开始](getting-started.md)（AVX-DOC-002）。
