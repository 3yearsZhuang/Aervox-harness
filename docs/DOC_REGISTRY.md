# 文档生命周期登记表（核验节奏与陈旧信号）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-28

> 文档编号：AVX-DOC-CONF-001  
> 版本：v0.7
> 更新日期：2026-08-28
> 状态：评审候选  
> 关联：[文档索引](README.md)

本表跟踪每份关键文档的最后核验时间、核验节奏与陈旧信号；文档历史责任通过各文档头部的 `- 提出人 / - 修改人` 点阵签名追踪（见[文档写作规范 §2](reference/standards/doc-standards.md#2-文档头元数据)）。`最后核验` 默认取文档头更新日期，核验后更新该字段。文档体系总览与权威顺序见[文档索引](README.md)。

| 文档编号 | 文档 | 最后核验 | 核验节奏 | 陈旧信号 |
|---|---|---|---|---|
| `AVX-PRD-001` | [PRD](reference/PRD.md) | 2026-08-25 | 每次版本立项 / G0 | CAP 范围或优先级变更未建立 `CR-*` |
| `AVX-SRS-001` | [SRS](reference/SRS.md) | 2026-08-28 | G1 需求基线前 | 版本内 FR/BR/AC 变化未同步或未过 DoR |
| `AVX-SAD-001` | [架构设计](reference/ARCHITECTURE.md) | 2026-08-28 | G2 评审 + 架构变更 | 新增 ADR/技术基线变化未同步 |
| `ADR-001~016` | [ADR 索引](reference/adr/README.md) | 2026-08-28 | G2 评审 + 决策变更 | 决策被 `Superseded/Rejected` 未登记 |
| `AVX-SPC-001` | [流式协议](reference/STREAMING_PROTOCOL.md) | 2026-08-24 | OpenAPI/事件 schema 变更 | `packages/contracts` 版本高于文档描述 |
| `AVX-DB-001` | [数据库设计与双引擎契约](reference/DATABASE.md) | 2026-08-25 | Schema/仓储接口/迁移计划变更 | 仓储接口签名或租户隔离模式/PG 切换计划与实现不一致 |
| `AVX-DATA-001` | [数据与隐私](reference/DATA_PRIVACY.md) | 2026-08-24 | 每季度 + 数据流变更 | 新增数据实体/用途/保留未评审 |
| `AVX-AIQ-001` | [AI 质量与安全](reference/AI_QUALITY_SAFETY.md) | 2026-08-24 | 模型/Prompt/算法变更 + AI 评估 | ModelRun/PromptVersion 更新未同步 |
| `AVX-SEC-001` | [威胁模型](reference/THREAT_MODEL.md) | 2026-08-24 | 每季度 + 信任边界变更 | 新增数据流/信任边界未加入威胁模型 |
| `AVX-QA-001` | [测试策略](reference/TEST_STRATEGY.md) | 2026-08-24 | G1/G4 门禁 | AC/TC 状态变化未回填 |
| `AVX-OPS-001` | [运行、值班与演练手册](reference/operations.md) | 2026-08-26 | 每季度演练 + 每次发布 + 值班变更 | 演练日期超期、告警/拓扑变化或联系人未更新 |
| `AVX-TRC-001` | [需求追踪与交付基线](reference/REQUIREMENTS_TRACEABILITY.md) | 2026-08-28 | 版本立项 / G1 / G4 / 落地登记 | CAP/AC/TC 状态或追踪关系变化未回填；§4.2 落地登记与实现不符 |
| `AVX-GUIDE-001~003` | [操作指南](how-to) | 2026-08-26 | 规则变更或季度评审 | 与追踪/ADR/门禁流程表述不符 |
| `AVX-CAP-REG-001` | [能力注册表](reference/capability-registry.md) | 2026-08-28 | 每次自选状态 / 模块变更 | 交付载体、启用方式或已注册模块与实现/CR 不一致 |
| `AVX-CAP-001` | [能力组合与可选化目录规范](reference/capability-composition.md) | 2026-08-28 | G2 评审 + 能力宿主/适配器机制变更 | Manifest、Profile、Provider、Adapter、Kernel 边界与实现或 ADR/CR 不一致 |
| `AVX-HAR-001` | [Agent Harness Loop 设计与落地规范](reference/agent-harness-loop.md) | 2026-08-28 | G2 评审 + Agent Loop/Provider/工具/持久化边界变更 | Turn/Attempt/Step、Provider、Tool、Inbox、恢复或 Profile 语义与实现/ADR 不一致 |
| `AVX-WEB-001` | [Web 工作台实现规划](explanation/web-implementation.md) | 2026-08-25 | Web 端实现或技术基线变更 | `apps/web` 结构与 ADR-015/规划不一致 |
| `CR-002` | [Fairy Agent Electron 桌面端](reference/changes/CR-002-fairy-desktop-module.md) | 2026-08-24 | CAP-018 桌面端实现或安全边界变更 | Electron 端目录、契约边界、测试证据或回滚条件与实现不符 |
| `CR-003` | [SQLite 业务真源与 PG 兼容](reference/changes/CR-003-sqlite-primary-pg-compat.md) | 2026-08-24 | 数据真源 / 仓储抽象变更 | 仓储接口或 PG 切换计划与实现不符 |
| `CR-004` | [人格插件 SQLite 持久化](reference/changes/CR-004-persona-sqlite-persistence.md) | 2026-08-25 | 数据库 schema / Port / 模块指针变更 | 表、Port 或 CR 状态与实现不一致 |
| `CR-005` | [共享工作台与 Web 无桌宠表现层](reference/changes/CR-005-shared-workbench-web-without-pet.md) | 2026-08-25 | 端形态与共享 UI 边界变更 | Electron/Web 目录、共享组件契约或回滚条件与实现不符 |
| `CR-006` | [插件配置解析与可视化](reference/changes/CR-006-plugin-config-and-pages.md) | 2026-08-26 | 插件配置/Page 机制变更 | 代码与 Config/Page 规范或安全边界不一致 |
| `CR-007` | [可替换 Live2D 桌宠渲染层](reference/changes/CR-007-live2d-sekai-viewer-pet.md) | 2026-08-26 | 桌宠渲染、模型资产或桌面依赖变更 | Live2D 资产许可、回退行为、资源预算或实现与 CR 不一致 |
| `CR-008` | [练习会话与作答契约补全](reference/changes/CR-008-practice-session-contract.md) | 2026-08-27 | `CAP-003` 练习会话、作答或报告契约变更 | SRS、OpenAPI、实现与 `FR-PRC-001` 的快照、幂等、会话状态和隔离规则不一致 |
| `CR-009` | [错题本忽略与恢复规则](reference/changes/CR-009-mistake-book-dismissal.md) | 2026-08-27 | `CAP-004` 错题本处置或重练规则变更 | SRS、API、数据库和 UI 对忽略状态、恢复与学习事实保留的语义不一致 |
| `CR-010` | [复习完成幂等与结果重放](reference/changes/CR-010-review-completion-idempotency.md) | 2026-08-27 | `CAP-006` 完成、重试或调度结果契约变更 | SRS、API、数据库、OpenAPI 和 UI 的幂等语义不一致 |
| `CR-011` | [时区安全的复习调度与逾期汇总](reference/changes/CR-011-timezone-safe-review-scheduling.md) | 2026-08-27 | `CAP-006` 时区来源、日界线或调度版本变更 | 时区快照、DST 算法、逾期口径与实现不一致 |
| `CR-012` | [Agent Harness Loop 目标规范与迁移基线](reference/changes/CR-012-agent-harness-loop.md) | 2026-08-28 | Agent Loop、TurnAttempt、工具管线、Provider 或部署形态变更 | AVX-HAR-001、流式协议、能力组合、实现阶段或回滚边界不一致 |
| `CR-013` | [活跃练习会话恢复与续答](reference/changes/CR-013-practice-session-recovery.md) | 2026-08-28 | `CAP-003` 活跃会话、题组快照或续答边界变更 | SRS、OpenAPI、持久化进度与工作台恢复行为不一致 |
| `CR-014` | [WebUI 语音输出配置](reference/changes/CR-014-voice-config-webui.md) | 2026-08-28 | `CAP-019/020` 系统语音输出 / 本地语音模型配置变更 | 表、契约、Voice 模块或设置 UI 与实现不一致 |
| `CR-015` | [WebUI 大语言模型与供应商配置](reference/changes/CR-015-llm-provider-config-webui.md) | 2026-08-28 | `CAP-020` / `ADR-005` 大语言模型供应商与配置变更 | 表、契约、LLM 模块或设置 UI 与实现不一致 |
| `CR-016` | [离线语音输入 ASR](reference/changes/CR-016-offline-voice-input-asr.md) | 2026-08-28 | `CAP-019/020` / `ADR-005` 离线语音输入与交互变更 | 表、契约、ASR 模块或输入交互与实现不一致 |
| `AVX-PLUG-001` | [插件 Config 与 Page 规范](reference/plugin-config-and-pages.md) | 2026-08-26 | CR-006 / 插件机制变更 | Manifest、Config Schema、Page Bridge 与实现不一致 |
| `AVX-STD-001` | [文档写作规范](reference/standards/doc-standards.md) | 2026-08-26 | 规则变更或季度评审 | 新增文档未标注四分类/头字段不合规，或 Vale 规则与术语表不一致 |
| `AVX-TERM-001` | [术语表](reference/standards/terminology.md) | 2026-08-28 | 术语新增/变更 | 新增缩写未登记，或正文拼写与「禁写」列不一致 |
| `AVX-TUT-001` | [教程：第一个对话](tutorials/first-conversation.md) | 2026-08-25 | 启动命令/端点变更 | 快速开始命令、Turn/SSE 端点与 README/契约不一致 |
| `AVX-TUT-002` | [教程：迁移已集成能力并接入 DSH/pi](tutorials/migrate-integrated-capabilities.md) | 2026-08-28 | 能力目录、DSH/pi 上游或迁移步骤变更 | 当前实现路径、固定 SHA、权限/隔离边界或验证命令与仓库不一致 |
| `AVX-EXPL-001` | [数据流总览](explanation/data-flow-overview.md) | 2026-08-25 | 模块/Worker/路由变更 | 新增模块或 Worker 循环未入概念地图 |
| `AVX-EXPL-002` | [参考项目能力迁移与借鉴评估](explanation/reference-design-transfer.md) | 2026-08-28 | 参考项目升级或架构变更 | 新增借鉴决策未登记，或参考项目 commit 超出固定清单 |
| `AVX-EXPL-003` | [桌宠角色设定文档化与多人格模板组织](explanation/persona-organization.md) | 2026-08-26 | 桌宠 IP / CAP-019 立项或人设变更 | 新增/变更角色文档未按字段化结构与模板版本化落地，或识别边界未同步评审 |
| `AVX-EXPL-004` | [能力拆分路线](explanation/roadmap.md) | 2026-08-26 | CAP 批次/依赖变更时 | 批次顺序与追踪基线 CAP 状态或新增 CAP 不一致 |
| `AVX-DOC-001` | [文档索引](README.md) | 2026-08-28 | 每季度 + 每次文档集变更 | 事实源映射与仓库实际不符 |
| `AVX-DOC-002` | [从哪开始](getting-started.md) | 2026-08-28 | 每季度 + 每次文档集变更 | 仓库结构/阅读顺序/自检清单与索引或实际不符 |

## 维护规则

- 登记强度按[文档写作规范 §3.1 改动等级](reference/standards/doc-standards.md#31-改动等级与同步要求)执行：
  - L1 编辑性：只过 ci-docs，不登记；
  - L2 内容更新：更新本表「最后核验」日期，不新增/改条目；
  - L3 结构性（新增文档、目录迁移、编号/类型/事实源变更）：新增或更新条目，并同步[文档索引](README.md)体系表与[从哪开始](getting-started.md)入口；
- 每份文档创建/改版时，按上一条分级在此登记或更新对应条目（编号、核验日期、陈旧信号）；
- 新增文档按[文档写作规范](reference/standards/doc-standards.md)标注类型与头字段；导航/登记类（[文档索引](README.md)、本表）只登记不标四分类；
- 核验时更新 `最后核验` 日期；长期未核验或陈旧信号命中时按[更新与评审节奏](README.md#4-更新与评审节奏)处置。
