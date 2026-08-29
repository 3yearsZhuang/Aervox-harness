# Aervox｜思隅 产品与工程文档索引

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-29

> 文档编号：AVX-DOC-001  
> 版本：v1.3
> 更新日期：2026-08-29
> 状态：Review Candidate

本目录把产品目标、可测试需求、架构决策、数据权利和 AI 质量分开维护，避免单一 PRD 同时承担所有细节。所有上线范围必须能从用户价值追踪到需求、设计、测试和发布证据。

## 1. 文档体系与事实源

| 文档 | 负责回答 | 事实源边界 |
|---|---|---|
| [PRD](reference/PRD.md) | 为什么做、为谁做、全生命周期做什么、用户层面如何验收 | 产品定位、场景、CAP-001～CAP-035、优先级、路线和用户级指标 |
| [SRS](reference/SRS.md) | 发布范围内每个行为、异常和业务规则如何原子化 | FR/BR/NFR、Given/When/Then 验收和测试 ID |
| [架构设计](reference/ARCHITECTURE.md) | 系统如何实现和演进 | TypeScript 全栈选型、C4、模块/数据所有权、部署、可靠性、安全和 ADR |
| [流式协议契约](reference/STREAMING_PROTOCOL.md) | Turn 创建、SSE 事件、幂等、重连、取消和部分响应如何保持一致 | OpenAPI 配套的机器可验证事件 envelope、状态机、游标、保留和安全持久化规则 |
| [数据库设计与双引擎契约](reference/DATABASE.md) | SQLite ↔ PostgreSQL 双引擎真源切换、租户隔离、仓储 Port、迁移三阶段与删除传播规则 | Drizzle schema 生成双方言 DDL、Repository/Vector Search Port 签名、Expand/Contract 迁移与 TC 门禁 |
| [需求追踪与交付标准](reference/REQUIREMENTS_TRACEABILITY.md) | 每条需求是否完整、由谁负责、怎样证明交付，以及代码落地完成情况 | ID、状态、DoR/DoD、CAP 映射、测试证据、发布门禁、风险和变更控制；§4.2 落地实现登记 |
| [数据与隐私规范](reference/DATA_PRIVACY.md) | 数据为什么收集、何时召回/保留/删除、谁能访问 | 数据分类、同意、来源链、保留表、删除传播、导出和审计 |
| [AI 质量与安全规范](reference/AI_QUALITY_SAFETY.md) | 模型、记忆和日记怎样达到可复现质量与安全门槛 | 模型运行记录、评估集、记忆压缩、日记事实性、安全分类和回滚 |
| [威胁模型](reference/THREAT_MODEL.md) | 哪些资产和信任边界会受到何种攻击 | 威胁场景、控制、验证、残余风险和安全评审输入 |
| [测试策略](reference/TEST_STRATEGY.md) | 各类需求怎样验证、哪些路径阻断发布 | 测试分层、P0 必测路径、AI 评估、覆盖门槛和证据要求 |
| [运行、值班与演练手册](reference/operations.md) | 生产故障怎样止损、恢复和验证；出问题找谁、如何升级；季度演练留什么证 | 告警、事件响应、降级、恢复、回滚、值班与 SEV 升级、演练项与证据字段；G5 门禁引用 |
| [ADR 索引](reference/adr/README.md) | 为什么选择当前架构、舍弃了什么方案 | 架构决策状态、后果、迁移和回滚边界 |
| [能力组合与可选化目录规范](reference/capability-composition.md)（AVX-CAP-001） | 所有业务能力最终如何通过 Manifest、Provider、Adapter 和 Profile 自由组合 | 目标目录、Kernel 不变量、依赖解析、生命周期、DSH/pi 适配与迁移验收 |
| [Agent Harness Loop 设计与落地规范](reference/agent-harness-loop.md)（AVX-HAR-001） | 一次 Agent Turn 如何经过 Context、模型、工具、多 Step、取消恢复并安全终止 | Loop 状态机、Port、持久化、工具管线、限额、DSH/pi Driver 与分阶段迁移 |
| [能力注册表](reference/capability-registry.md)（AVX-CAP-REG-001） | 哪些能力纳入自选机制、以什么方式启用、当前处于哪个状态 | 交付载体与启用方式、CAP 分类与已注册模块登记；判定规则与交付机制见 AVX-CAP-001 |
| [插件 Config 与 Page 规范](reference/plugin-config-and-pages.md)（AVX-PLUG-001） | 插件配置如何声明、校验、可视化，Page 如何安全承载 | Config Schema v1、配置存储/API、Page Bridge 与安全边界（CR-006） |
| [操作指南](how-to) | 怎么新增/修改需求、写 ADR、过发布会门禁、做季度演练、管可选模块 submodule；贡献者流程见根级 [CONTRIBUTING](../CONTRIBUTING.md) | 任务型流程（工程与发布流程合一）；规则以对应专项文档为事实源 |
| [文档生命周期登记表](DOC_REGISTRY.md) | 每份文档何时核验、多久复核、什么信号表示陈旧 | 核验节奏/陈旧信号；独立于索引维护 |
| [文档治理与事实源规范](reference/document-governance.md)（AVX-DOC-GOV-001） | 文档如何分类、标记状态、确定唯一事实源并触发复核 | 分类、事实源矩阵、元数据、状态模型、owner、复核触发器与分阶段迁移 |
| [从这里开始](getting-started.md)（AVX-DOC-002，见[§7](#7-从哪开始)） | 新成员/Agent 从哪看起、提交前自检什么 | 导航型；不承载规则 |
| [能力拆分路线](explanation/roadmap.md)（AVX-EXPL-004，见[§4.1](#41-能力拆分路线建议批次)） | CAP 按什么批次、什么顺序进入规格化与开发 | 建议批次与拆分节奏；既不重复 PRD 路线图，也不重复追踪基线矩阵 |
| [主动智能模式](explanation/proactive-intelligence-mode.md)（AVX-EXPL-008） | 完全访问上如何以广域画像授权、OS 能力、特权观察 Host、本地私密数据和主动操作组合既有 CAP | 评审提案；不替代 PRD/SRS/DATA_PRIVACY/ADR，不表示运行时已实现 |
| [CR-024 主动智能能力套件与外部环境连接](reference/changes/CR-024-proactive-intelligence-suite-integrations.md) | 十二项主动智能能力与 HA/小米健康如何进入产品基线 | 已接受差量、实现位置、验证和回滚；关联 CAP-033～035 |
| [ADR-019 主动智能外部连接本地网关](reference/adr/ADR-019-proactive-integrations-local-gateway.md) | 外部连接为何使用本地网关、加密凭据和受控工具 | 已接受的 HA REST/WS、小米 OAuth/每日指标、白名单与撤销边界 |
| [文档写作规范](reference/standards/doc-standards.md)（AVX-STD-001） | 每份文档如何使用模板、命名、写作并通过门禁 | 写作体例、签名、命名、风格基线、Vale 术语门禁与模板族；治理规则见 AVX-DOC-GOV-001 |
| [术语表](reference/standards/terminology.md)（AVX-TERM-001） | 项目术语的唯一含义与规范写法 | 缩写/产品名唯一语义；Vale 依据「禁写」列自动校验 |
| [教程：第一个对话](tutorials/first-conversation.md)（AVX-TUT-001） | 新成员如何从 0 跑到第一条对话 | 可执行步骤与验证 |
| [教程：迁移已集成能力并接入 DSH/pi](tutorials/migrate-integrated-capabilities.md)（AVX-TUT-002） | 如何把现有 tools/plugins/skills 迁移为可组合能力，并设计 DSH/pi 适配器 | 原生能力迁移、Job Handler、外部 Host、Profile、撤权和回滚演练 |
| [数据流总览](explanation/data-flow-overview.md)（AVX-EXPL-001） | 消息端到端如何流动 | 先写后投递、Worker 周期、记忆/知识写入 |
| [参考项目能力迁移与借鉴评估](explanation/reference-design-transfer.md)（AVX-EXPL-002） | 参考项目哪些设计值得落地或借鉴 | 判定框架、建议落地清单、落地顺序与 AGPL 边界 |
| [桌宠角色设定文档化与多人格模板组织](explanation/persona-organization.md)（AVX-EXPL-003） | 桌宠 IP 与多人格模板（CAP-019）的角色如何文档化、版本化并维护 | 角色文档清单、字段化结构（prompt/开场白/语气/技能/错误兜底语）、人设目录与模板版本化、维护责任 |
| [ESP32-S3 硬件延伸方案](explanation/esp32-s3-hardware-extension.md)（AVX-EXPL-005） | 如何把 ESP32-S3 做成物理桌宠终端 | 评审输入：硬件边界、表现映射、设备协议与隐私红线；R0 先 USB 不联网 |
| [Home Assistant 集成评估](explanation/home-assistant-integration-assessment.md)（AVX-EXPL-006） | 如何为 Aervox 引入 Home Assistant 支持 | 候选方案与后续路线；推荐组合已由 CR-024/ADR-019 接受 |
| [运动与健康数据接入评估](explanation/health-data-integration-assessment.md)（AVX-EXPL-007） | 是否可以接入苹果/小米运动健康数据（步数、睡眠、情绪） | 小米每日指标路径已由 CR-024/ADR-019 接受；苹果与情绪健康仍为评估输入 |

文档分类、状态、事实源与复核触发以[文档治理与事实源规范](reference/document-governance.md)为准；模板、命名、签名和写作门禁见[文档写作规范](reference/standards/doc-standards.md)，术语唯一语义见[术语表](reference/standards/terminology.md)。

当前已提供 [SRS](reference/SRS.md) 原子需求样例、共享 ADR、威胁模型、测试策略、运行手册和基线 NFR/AIQ/DATA/SEC/PRIV/OPS 追踪。每个进入开发的能力仍应逐步补充其专属 API/OpenAPI 片段、UX 原型、数据字典、测试证据和 ADR 关联；这些材料未齐备前，不得把能力地图中的一行视为完整开发规格。

最近的端形态变更见 [CR-005：共享工作台与 Web 无桌宠表现层](reference/changes/CR-005-shared-workbench-web-without-pet.md)：Web 与 Electron 共用 `@aervox/ui` 工作台，Web 不渲染桌宠，Electron 保留桌面壳和桌宠窗口。

后续表现层变更见 [CR-007：可替换 Live2D 桌宠渲染层](reference/changes/CR-007-live2d-sekai-viewer-pet.md)：Web 工作台重新启用可回退的 Live2D 桌宠；Electron 主工作台保持无左侧桌宠，独立桌宠窗口继续使用 Live2D。

桌面端首次启动体验见 [CR-025：桌面端首次启动引导](reference/changes/CR-025-desktop-first-run-onboarding.md)：Electron 首次启动通过四步窗口内序章介绍产品，复用 Live2D 与 CR-015 模型配置能力，并用版本化本机标记控制后续跳过。

最近的插件能力变更见 [CR-006：插件配置解析与可视化](reference/changes/CR-006-plugin-config-and-pages.md)：新增插件 Config Schema v1、配置持久化/API 与受限 Page Bridge（规范见 [AVX-PLUG-001](reference/plugin-config-and-pages.md)）。

学习域练习会话的规格补全见 [CR-008：练习会话与作答契约补全](reference/changes/CR-008-practice-session-contract.md)：明确题组快照、重复提交、会话结束和租户隔离的验收边界；仍待 DoR 评审。

错题本的处置边界见 [CR-009：错题本忽略与恢复规则](reference/changes/CR-009-mistake-book-dismissal.md)：忽略只影响派生错题展示与重练资格，不删除原始学习事实。

错题本的错因记录边界见 [CR-018：错题错因记录工作流](reference/changes/CR-018-mistake-insight-workflow.md)：用户元数据可按错因筛选与重练，不改写原始作答或派生学习状态。

复习闭环的幂等边界见 [CR-010：复习完成幂等与结果重放](reference/changes/CR-010-review-completion-idempotency.md)：重复完成可重放首次结算，相反判定被拒绝且不重复调度。

复习日期边界见 [CR-011：时区安全的复习调度与逾期汇总](reference/changes/CR-011-timezone-safe-review-scheduling.md)：v2 按 IANA 时区增加本地日历天，并区分今日到期与历史逾期。

Agent 执行核心的当前与目标边界见 [CR-012：Agent Harness Loop](reference/changes/CR-012-agent-harness-loop.md) 与 [AVX-HAR-001](reference/agent-harness-loop.md)：阶段 0、1、2d、2e、3a、3b 已落地，包括 `packages/agent-loop`、API Replay/Scripted/LLM Loop、持久化 SSE、只读工具、写工具审批、工具账本、租约与 Worker 恢复；异步 Outbox Driver、完整上下文持久化、独立 Host 和 DSH/pi Adapter 仍按后续阶段推进。

Turn 流活性边界见 [CR-027：Turn 流活性治理](reference/changes/CR-027-turn-stream-liveness.md)：`POST /turns` 落库即返回（Loop 后台执行，`AERVOX_TURN_EXECUTION=inline` 可回退旧同步语义），SSE 为「重放 + 轮询 tail + 心跳」活流；思考型模型增量以 `reasoning_delta` 事件透传（`reasoning_content`/`reasoning` 双格式）；provider 与客户端超时均为空闲语义，桌面端空闲超时后经 IPC 中止上游在途请求。

工具授权的 Turn 级完全访问开关见 [CR-022](reference/changes/CR-022-full-access-tool-permission.md)：默认仍逐次确认，用户经风险确认后可自动放行普通写工具；CAP-033 另以独立的 `FullProfileActionGrant` 承载用户明确批准的全量主动动作，撤权/删除、租户隔离和平台访问控制仍由各自事实源约束。

本地主动智能能力见 [CR-023](reference/changes/CR-023-proactive-local-intelligence-mode.md)、[CR-024](reference/changes/CR-024-proactive-intelligence-suite-integrations.md) 与 [AVX-EXPL-008](explanation/proactive-intelligence-mode.md)：`CAP-033` 已具备本地 Vault、授权/lease、全动作授权器、部分来源、十二项本地派生、日/周回顾和桌面仪表盘；`CAP-034/035` 已具备 HA 私网 REST/WS、实体/service 白名单、小米健康每日指标和五个 Agent 工具。三项能力仍为 Not Ready，生产 OS Broker、HA 兼容矩阵和小米厂商沙箱/账号审批未完成，尚未 Released。

练习中断恢复边界见 [CR-013：活跃练习会话恢复与续答](reference/changes/CR-013-practice-session-recovery.md)：重开学习界面会恢复同一题组快照和首个未答题，重复启动不会创建第二个活跃会话。

系统语音输出的本地模型配置见 [CR-014：WebUI 语音输出配置](reference/changes/CR-014-voice-config-webui.md)：设置「语音」分类读写本地 `gpt-sovits-local` 模型（模型路径、音色支持手输，桌面端也可经系统「选择文件夹」获得，`modelPath` 受服务端 `allowedRoots` 白名单校验），持久化到 `voice_configs` 表并按租户隔离；人格编辑弹窗新增「语音」能力块，选择 provider/模型/音色并试听，写入 `PersonaRevisionConfig.voice`。

大语言模型供应商配置见 [CR-015：WebUI 模型与服务](reference/changes/CR-015-llm-provider-config-webui.md)：设置「模型与服务」分类持久化 LLM 供应商端点/密钥引用/模型名并支持连通性测试，按租户隔离存储。

文档治理基线见 [CR-017：文档治理与事实源标准化](reference/changes/CR-017-document-governance-standardization.md) 与 [AVX-DOC-GOV-001](reference/document-governance.md)：本轮先建立兼容式元数据、状态分层、事实源矩阵和 `docs-validate` 门禁，不批量搬迁历史文档。

能力注册表状态同步见 [CR-019：CAP-010~019 主仓交付裁定](reference/changes/CR-019-capability-registry-status-sync.md)：已主仓实现交付的能力（层级对话/思维宇宙/自适应刷题/考试日计划/多人格模板）按能力组合不变量转主仓交付，配套追踪基线 §4.2 登记。

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

阶段命名唯一映射：`R0=原型验证`、`R1=MVP`、`R1.5=MVP+`、`R2=P1 学习深化`、`R3=端形态扩展`、`R4=P2 连接智能化`、`R5=P3 生态规模化`。`P0～P3` 是能力优先级，不是发布阶段；任何计划表必须同时写两者。

### 4.1 能力拆分路线（建议批次）

每批 CAP 何时从 `Mapped` 转 `Specified`、按什么顺序拆分进入开发，见[能力拆分路线](explanation/roadmap.md)（AVX-EXPL-004）。拆分的唯一事实源是[追踪基线覆盖矩阵](reference/REQUIREMENTS_TRACEABILITY.md#4-cap-001cap-035-覆盖矩阵全部能力状态唯一速览)。

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
