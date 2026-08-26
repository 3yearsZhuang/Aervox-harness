# Aervox｜思隅 产品与工程文档索引

> 文档编号：AVX-DOC-001  
> 版本：v0.3  
> 更新日期：2026-08-26  
> 状态：评审候选  
> 文档负责人：待指定

本目录把产品目标、可测试需求、架构决策、数据权利和 AI 质量分开维护，避免单一 PRD 同时承担所有细节。所有上线范围必须能从用户价值追踪到需求、设计、测试和发布证据。

## 1. 文档体系与事实源

| 文档 | 负责回答 | 事实源边界 |
|---|---|---|
| [PRD](reference/PRD.md) | 为什么做、为谁做、全生命周期做什么、用户层面如何验收 | 产品定位、场景、CAP-001～CAP-032、优先级、路线和用户级指标 |
| [SRS](reference/SRS.md) | 发布范围内每个行为、异常和业务规则如何原子化 | FR/BR/NFR、Given/When/Then 验收和测试 ID |
| [架构设计](reference/ARCHITECTURE.md) | 系统如何实现和演进 | TypeScript 全栈选型、C4、模块/数据所有权、部署、可靠性、安全和 ADR |
| [流式协议契约](reference/STREAMING_PROTOCOL.md) | Turn 创建、SSE 事件、幂等、重连、取消和部分响应如何保持一致 | OpenAPI 配套的机器可验证事件 envelope、状态机、游标、保留和安全持久化规则 |
| [数据库设计与双引擎契约](reference/DATABASE.md) | SQLite ↔ PostgreSQL 双引擎真源切换、租户隔离、仓储 Port、迁移三阶段与删除传播规则 | Drizzle schema 生成双方言 DDL、Repository/Vector Search Port 签名、Expand/Contract 迁移与 TC 门禁 |
| [需求追踪与交付标准](reference/REQUIREMENTS_TRACEABILITY.md) | 每条需求是否完整、由谁负责、怎样证明交付，以及代码落地完成情况 | ID、状态、DoR/DoD、CAP 映射、测试证据、发布门禁、风险和变更控制；§4.2 落地实现登记 |
| [数据与隐私规范](reference/DATA_PRIVACY.md) | 数据为什么收集、何时召回/保留/删除、谁能访问 | 数据分类、同意、来源链、保留表、删除传播、导出和审计 |
| [AI 质量与安全规范](reference/AI_QUALITY_SAFETY.md) | 模型、记忆和日记怎样达到可复现质量与安全门槛 | 模型运行记录、评估集、记忆压缩、日记事实性、安全分类和回滚 |
| [威胁模型](reference/THREAT_MODEL.md) | 哪些资产和信任边界会受到何种攻击 | 威胁场景、控制、验证、残余风险和安全评审输入 |
| [测试策略](reference/TEST_STRATEGY.md) | 各类需求怎样验证、哪些路径阻断发布 | 测试分层、P0 必测路径、AI 评估、覆盖门槛和证据要求 |
| [运行与恢复手册](reference/RUNBOOK.md) | 生产故障怎样止损、恢复和验证 | 告警、事件响应、降级、恢复、回滚、演练和证据 |
| [ADR 索引](reference/adr/README.md) | 为什么选择当前架构、舍弃了什么方案 | 架构决策状态、后果、迁移和回滚边界 |
| [能力组合与可选化目录规范](reference/capability-composition.md)（AVX-CAP-001） | 所有业务能力最终如何通过 Manifest、Provider、Adapter 和 Profile 自由组合 | 目标目录、Kernel 不变量、依赖解析、生命周期、DSH/pi 适配与迁移验收 |
| [可选功能模块化方案](explanation/optional_modules.md) | 当前非核心功能如何以子仓库开发并作为 workspace 包自选消费 | 过渡期 `modules/*` 机制、构建+运行时双轴、模块清单与门禁；目标演进见 AVX-CAP-001 |
| [操作指南](how-to) | 怎么新增需求、写 ADR、过发布门禁、做演练、管可选模块 submodule | 任务型流程；规则以对应专项文档为事实源 |
| [文档生命周期登记表](DOC_REGISTRY.md) | 每份文档由谁负责、何时核验、多久复核 | Owner/核验节奏/陈旧信号；独立于索引维护 |
| [从这里开始](getting-started.md)（AVX-DOC-002，见[§8](#8-从哪开始)） | 新成员/Agent 从哪看起、提交前自检什么 | 导航型；不承载规则 |
| [能力拆分路线](explanation/roadmap.md)（AVX-EXPL-004，见[§5.1](#51-能力拆分路线建议批次)） | CAP 按什么批次、什么顺序进入规格化与开发 | 建议批次与拆分节奏；既不重复 PRD 路线图，也不重复追踪基线矩阵 |
| [值班与升级矩阵](reference/ONCALL.md) | 出问题找谁、如何升级、如何交接 | 值班角色与 SEV 升级；联系人人名待定 |
| [演练证据模板](reference/DRILL_TEMPLATE.md) | 季度演练留什么证 | 演练项、通过标准与证据字段；G5 门禁引用 |
| [插件 Config 与 Page 规范](reference/plugin-config-and-pages.md)（AVX-PLUG-001） | 插件配置如何声明、校验、可视化与 Page 如何安全承载 | Config Schema v1、配置存储/API、Page Bridge 与安全边界（CR-006） |
| [文档写作规范](reference/standards/doc-standards.md)（AVX-STD-001） | 每份文档怎么分类、文档头怎么填、怎么写、如何被校验 | Diátaxis 四分类、元数据 schema、命名、风格基线、Vale 术语门禁、模板族 |
| [术语表](reference/standards/terminology.md)（AVX-TERM-001） | 项目术语的唯一含义与规范写法 | 缩写/产品名唯一语义；Vale 依据「禁写」列自动校验 |
| [教程：第一个对话](tutorials/first-conversation.md)（AVX-TUT-001） | 新成员如何从 0 跑到第一条对话 | 可执行步骤与验证 |
| [教程：迁移已集成能力并接入 DSH/pi](tutorials/migrate-integrated-capabilities.md)（AVX-TUT-002） | 如何把现有 tools/plugins/skills 迁移为可组合能力，并设计 DSH/pi 适配器 | 原生能力迁移、Job Handler、外部 Host、Profile、撤权和回滚演练 |
| [数据流总览](explanation/data-flow-overview.md)（AVX-EXPL-001） | 消息端到端如何流动 | 先写后投递、Worker 周期、记忆/知识写入 |
| [参考项目能力迁移与借鉴评估](explanation/reference-design-transfer.md)（AVX-EXPL-002） | 参考项目哪些设计值得落地或借鉴 | 判定框架、建议落地清单、落地顺序与 AGPL 边界 |
| [桌宠角色设定文档化与多人格模板组织](explanation/persona-organization.md)（AVX-EXPL-003） | 桌宠 IP 与多人格模板（CAP-019）的角色如何文档化、版本化并维护 | 角色文档清单、字段化结构（prompt/开场白/语气/技能/错误兜底语）、人设目录与模板版本化、维护责任 |

写作层规则（四分类、头字段、命名、Vale 门禁）见[文档写作规范](reference/standards/doc-standards.md)，术语唯一语义见[术语表](reference/standards/terminology.md)。

当前已提供 [SRS](reference/SRS.md) 原子需求样例、共享 ADR、威胁模型、测试策略、运行手册和基线 NFR/AIQ/DATA/SEC/PRIV/OPS 追踪。每个进入开发的能力仍应逐步补充其专属 API/OpenAPI 片段、UX 原型、数据字典、测试证据和 ADR 关联；这些材料未齐备前，不得把能力地图中的一行视为完整开发规格。

最近的端形态变更见 [CR-005：共享工作台与 Web 无桌宠表现层](reference/changes/CR-005-shared-workbench-web-without-pet.md)：Web 与 Electron 共用 `@aervox/ui` 工作台，Web 不渲染桌宠，Electron 保留桌面壳和桌宠窗口。

最近的插件能力变更见 [CR-006：插件配置解析与可视化](reference/changes/CR-006-plugin-config-and-pages.md)：新增插件 Config Schema v1、配置持久化/API 与受限 Page Bridge（规范见 [AVX-PLUG-001](reference/plugin-config-and-pages.md)）。

### 1.1 文档生命周期登记表（Owner 指派与核验）

每份关键文档的责任角色、最后核验时间、核验节奏与陈旧信号，独立维护在[文档生命周期登记表](DOC_REGISTRY.md)（AVX-DOC-CONF-001）。新增或改版文档时同步更新该表，避免索引与登记职责混在同一文件。

## 2. 权威顺序与冲突处理

1. 已批准的法律、安全和隐私政策优先于产品或技术便利。
2. PRD 决定用户价值、范围和不可突破的产品边界。
3. 原子需求/SRS 决定具体行为和验收条件。
4. 架构设计与 ADR 决定已批准实现方案。
5. OpenAPI、数据库迁移和事件契约是实现接口的机器可验证事实源。
6. 测试和发布记录证明某一版本是否兑现需求，但不能反向修改需求含义。

文档冲突时停止相关发布，创建 `CR-*`，记录受影响的 `CAP/FR/NFR/DATA/AIQ/SEC/PRIV`，经责任人批准后同步修订；不得在代码或口头沟通中静默选择一种解释。

## 3. 文档状态

| 状态 | 含义 |
|---|---|
| Draft | 可快速修改，不能作为开发或发布承诺 |
| Review Candidate | 内容基本完整，正在进行产品、工程、QA、安全/隐私评审 |
| Approved | 责任人批准，成为版本基线；变更需走 `CR-*` |
| Superseded | 被新版本替代，仅为追溯保留 |
| Retired | 对应能力或服务已退出，保留迁移和退出证据 |

当前文档集仍为评审候选，原因是负责人、目标地区、基础设施预算、模型供应商和实验样本量尚未批准。它可以指导进一步规格化和原型实现，但不能作为生产发布批准。

## 4. 责任与审批

| 角色 | 最低职责 |
|---|---|
| 产品负责人 | 产品范围、用户价值、优先级、指标、实验和变更批准 |
| 技术负责人 | 架构、容量、迁移、可靠性、技术风险和 ADR 批准 |
| 设计负责人 | 信息架构、交互状态、无障碍和跨端一致性 |
| QA 负责人 | 可测试性、追踪矩阵、评估集、测试证据和发布门禁 |
| 安全与隐私负责人 | 威胁模型、数据生命周期、同意、删除、安全事件和供应商评审 |
| AI 质量负责人 | Prompt/模型/评估集版本、教学正确性、记忆和日记质量 |
| 法务/内容治理 | 许可证、版权、未成年人、社区、市场和目标地区合规 |

PRD 批准至少需要产品、技术、设计、QA、安全/隐私负责人；涉及未成年人、社区、付费市场、健康内容或 AGPL 代码使用时增加法务审批。

## 5. 更新与评审节奏

- 每个版本规划开始时：确认 CAP 范围、实验、NFR、数据影响和负责人。
- 需求进入开发前：通过 Definition of Ready，并冻结对应 AC 和测试策略。
- 每个 RC：执行需求、架构、隐私、安全、AI 评估和恢复门禁。
- 上线后 7/30 天：核对业务指标、错误预算、AI 错误、安全事件、删除积压和成本。
- 每季度：复核数据保留表、供应商、许可证、依赖版本、灾备演练和风险登记。
- 文档每次批准：更新版本、日期、变更摘要、批准人和关联 `CR/ADR/EXP`，不得只修改正文。

阶段命名唯一映射：`R0=原型验证`、`R1=MVP`、`R1.5=MVP+`、`R2=P1 学习深化`、`R3=端形态扩展`、`R4=P2 连接智能化`、`R5=P3 生态规模化`。`P0～P3` 是能力优先级，不是发布阶段；任何计划表必须同时写两者。

### 5.1 能力拆分路线（建议批次）

每批 CAP 何时从 `Mapped` 转 `Specified`、按什么顺序拆分进入开发，见[能力拆分路线](explanation/roadmap.md)（AVX-EXPL-004）。拆分的唯一事实源是[追踪基线覆盖矩阵](reference/REQUIREMENTS_TRACEABILITY.md#4-cap-001cap-032-覆盖矩阵)。

## 6. 专业基线自检

一个能力只有同时满足以下条件，才可称为“需求已就绪”：

- 有稳定 ID、目标用户、业务理由、范围和非目标；
- 主流程、异常、权限、空状态、撤销和删除影响明确；
- 有可观测且可重复的验收条件，不以“智能、自然、友好”等形容词代替；
- 数据、AI、安全、隐私、无障碍、性能、成本和迁移影响已评审；
- 与 UX、API、数据实体、ADR、测试、埋点、Owner 和目标版本双向关联；
- 待验证判断登记为 `EXP-*`，风险登记为 `RISK-*`，不可逆决策登记为 `ADR-*`；
- 发布后仍支持导出、更正、删除、降级、回滚和服务退出。

## 7. 参考项目

以下 6 个项目均已作为固定 commit 的子模块放入仓库 `reference/`，用于验证设计假设与寻找实现模式；不作为 MVP 运行时强依赖：

- `reference/baishou-next`（[BaiShou-Next](https://github.com/foxletters-hq/BaiShou-Next)）：研究 TypeScript 多端、本地数据、记忆与日记设计；AGPLv3，默认只借鉴公开思想，不复制代码。
- `reference/dsh-synapse`（[dsh-synapse](https://github.com/liangmianya/dsh-synapse)）：研究会话分支、地图投影和 DSH 插件边界；MIT。
- `reference/deepseek-harness`（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）：研究稳定接口、会话、模型提供方与扩展能力；MIT。
- `reference/pi`（[pi monorepo](https://github.com/earendil-works/pi)）：研究可替换模型、会话与扩展接口；MIT。
- `reference/AstrBot`（[AstrBot](https://github.com/AstrBotDevs/AstrBot)）：研究管线阶段、会话锁、插件元数据与人设管理；AGPLv3，默认只借鉴公开思想，不复制代码。
- `reference/Petra`（[Petra](https://github.com/Wumiu/Petra)）：研究桌宠表现命令通道、自主行为引擎与记忆条目字段；MIT。

借鉴设计不等于验证用户需求，也不等于自动通过许可证、安全或维护性评审。

固定 commit 与许可证清单以 [PRD 15.1](reference/PRD.md#prd-reference-manifest) 为唯一事实源（复核日期 2026-08-26）；任何升级需建立 `CR-*`、重跑许可证/契约测试并更新复核日期。

## 8. 从哪开始

> 面向新成员或首次接触本仓库的 AI Agent 的完整 onboarding（仓库结构、阅读顺序、写作硬规则、Docs CI 自检、介入路径），见[从哪开始](getting-started.md)（AVX-DOC-002）。
