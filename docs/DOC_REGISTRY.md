---
id: AVX-DOC-CONF-001
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.9.0
updated_at: 2026-09-12
reviewed_at: 2026-09-12
review_interval_days: 90
---

# 文档生命周期登记表（核验节奏与陈旧信号）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-12

关联：[文档索引](README.md)、[文档治理与事实源规范](reference/document-governance.md)

本表只跟踪关键文档的最后核验时间、核验节奏与陈旧信号；分类、状态、事实源和复核触发规则以[文档治理与事实源规范](reference/document-governance.md)为准。`最后核验` 默认取文档头的核验日期；兼容期未单列核验日期时取更新日期。文档体系总览与权威顺序见[文档索引](README.md)。

| 文档编号 | 文档 | 最后核验 | 核验节奏 | 陈旧信号 |
|---|---|---|---|---|
| `AVX-PRD-001` | [PRD](reference/PRD.md) | 2026-09-10 | 每次版本立项 / G0 | CAP 范围或优先级变更未建立 `CR-*` |
| `AVX-PRD-002` | [能力验收标准附录](reference/prd-cap-acceptance.md) | 2026-09-10 | 每次版本立项 / CAP 验收变更 | P0/P1/P2/P3/专项验收标准未同步 |
| `AVX-SRS-001` | [SRS](reference/SRS.md) | 2026-09-11 | G1 需求基线前 | 版本内 FR/BR/AC 变化未同步或未过 DoR |
| `AVX-SRS-002` | [主动智能与外部信号需求规格](reference/srs-proactive-intelligence.md) | 2026-09-10 | G1 需求基线前 / 主动智能需求变更 | CAP-033/034/035 FR/BR/AC/DATA/SEC 变化未同步 |
| `AVX-SAD-001` | [架构设计](reference/ARCHITECTURE.md) | 2026-09-10 | G2 评审 + 架构变更 | CR-030 本地单用户边界、API 安全或数据拓扑未同步 |
| `ADR-001~019` | [ADR 索引](reference/adr/README.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 `Superseded/Rejected` 未登记 |
| `ADR-001` | [模块化单体架构与 Worker 拆分](reference/adr/ADR-001-modular-monolith.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-002` | [Web 端与 API 契约设计（已归档，由 ADR-015 替代）](reference/adr/ADR-002-web-api-contract.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-003` | [SQLite 永久本地真源与 Schema/Repository 分层](reference/adr/ADR-003-postgres-retrieval.md) | 2026-09-11 | G2 评审 + 决策变更 | CR-030 修订、Repository 边界或迁移协议未同步 |
| `ADR-004` | [Outbox 模式与幂等作业执行](reference/adr/ADR-004-outbox-idempotent-jobs.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-005` | [内部 Provider Port 包裹 AI SDK](reference/adr/ADR-005-provider-port.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-006` | [AI 召回期限与用户历史保留期限分离](reference/adr/ADR-006-recall-retention.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-007` | [记忆树投影：从会话日志重建层次化记忆](reference/adr/ADR-007-memory-tree-projection.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-008` | [Cloud-first 与本地 Port 历史方案（已替代）](reference/adr/ADR-008-cloud-first-local-port.md) | 2026-09-10 | G2 评审 + 决策变更 | Superseded 状态或历史说明与 CR-030 冲突 |
| `ADR-009` | [Electron 插件沙箱与主进程安全](reference/adr/ADR-009-electron-plugin-sandbox.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-010` | [DSH/pi 外部模型适配器模式](reference/adr/ADR-010-dsh-pi-adapters.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-011` | [日记周期与会话总结调度修订](reference/adr/ADR-011-diary-cycle-schedule-revision.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-012` | [流式协议安全持久化与部分响应恢复](reference/adr/ADR-012-streaming-safety-persistence.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-013` | [恢复控制账本：撤权拦截与确定性恢复](reference/adr/ADR-013-recovery-control-ledger.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-014` | [演进式模块化单体架构与模块目录组织](reference/adr/ADR-014-modular-monolith-structure.md) | 2026-09-11 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-015` | [Vue 全栈单栈方案](reference/adr/ADR-015-vue-full-stack.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-016` | [底座边界冻结与依赖规则门禁](reference/adr/ADR-016-base-boundaries.md) | 2026-08-31 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `ADR-017` | [上下文清单、模型运行记录与多步执行持久化](reference/adr/ADR-017-context-manifest-modelrun-step.md) | 2026-09-10 | G2 评审 + 决策变更 | 决策被 Superseded/Rejected 未登记 |
| `AVX-SPC-001` | [流式协议](reference/STREAMING_PROTOCOL.md) | 2026-09-10 | OpenAPI/事件 schema 变更 | `packages/contracts` 版本高于文档描述 |
| `AVX-DB-001` | [SQLite 本地单用户数据库契约](reference/DATABASE.md) | 2026-09-11 | Schema/仓储接口/迁移计划变更 | CR-030 目标、当前过渡状态、迁移器或回滚门禁与实现不一致 |
| `AVX-DB-002` | [数据库数据模型覆盖矩阵](reference/database-coverage-matrix.md) | 2026-09-11 | PRD §8 实体增减或落表状态变更 | 实体落表状态、CR-030 阶段、仓储 Port 或 DDL 初始化与实现不符 |
| `AVX-DATA-001` | [数据与隐私](reference/DATA_PRIVACY.md) | 2026-09-10 | 每季度 + 数据流/迁移变更 | 本地目录、导出、备份、破坏性迁移或删除边界未评审 |
| `AVX-AIQ-001` | [AI 质量与安全](reference/AI_QUALITY_SAFETY.md) | 2026-09-10 | 模型/Prompt/算法变更 + AI 评估 | 本地来源边界、Diary 唯一性或模型上下文规则未同步 |
| `AVX-SEC-001` | [威胁模型](reference/THREAT_MODEL.md) | 2026-09-10 | 每季度 + 信任边界变更 | loopback、文件 ACL 或 CR-030 迁移威胁未加入模型 |
| `AVX-QA-001` | [测试策略](reference/TEST_STRATEGY.md) | 2026-09-10 | G1/G4 门禁 | 本地安全或 CR-030 故障注入 AC/TC 状态未回填 |
| `AVX-OPS-001` | [运行、值班与演练手册](reference/operations.md) | 2026-09-10 | 每季度演练 + 每次发布 + 值班变更 | 本地恢复、CR-030 回滚或告警/拓扑变化未更新 |
| `AVX-TRC-001` | [需求追踪与交付基线](reference/REQUIREMENTS_TRACEABILITY.md) | 2026-09-12 | 版本立项 / G1 / G4 / 落地登记 | CAP/AC/TC 状态或追踪关系变化未回填；§4.2 落地登记与实现不符 |
| `AVX-HOW-001` | [操作指南索引](how-to/README.md) | 2026-09-10 | 新增指南或操作流程变更 | 指南清单与实际目录不一致 |
| `AVX-GUIDE-001` | [工程与发布流程](how-to/engineering-process.md) | 2026-08-29 | 规则变更或季度评审 | 与追踪/ADR/门禁流程表述不符 |
| `AVX-GUIDE-002` | [撰写与批准 ADR](how-to/write-adr.md) | 2026-08-28 | 规则变更或季度评审 | 与追踪/ADR/门禁流程表述不符 |
| `AVX-GUIDE-003` | [submodule 初始化与协作规范](how-to/submodule-collaboration.md) | 2026-08-31 | 规则变更或季度评审 | 与追踪/ADR/门禁流程表述不符 |
| `AVX-GUIDE-004` | [开发 Aervox 扩展插件](how-to/develop-plugin-ui-extension.md) | 2026-09-10 | 插件 Bundle、Turn 管道或 UI 扩展契约变更 | 指南与插件运行时、插槽注册表或安全边界不一致 |
| `AVX-CAP-REG-001` | [能力注册表](reference/capability-registry.md) | 2026-09-10 | 每次自选状态 / 模块变更 | 交付载体、启用方式或已注册模块与实现/CR 不一致 |
| `AVX-CAP-001` | [能力组合与可选化目录规范](reference/capability-composition.md) | 2026-09-10 | G2 评审 + 能力宿主/适配器机制变更 | Manifest、Profile、Provider、Adapter、Kernel 边界与实现或 ADR/CR 不一致 |
| `ADR-018` | [CAP-033 本地私密存储与主动智能 Host](reference/adr/ADR-018-proactive-local-privacy-host.md) | 2026-09-10 | CAP-033 本地存储、OS Permission Broker、动作授权或后台生命周期变更 | Host 签名/设备绑定、local-only、全动作授权、七天提炼清理或恢复门禁与实现不一致 |
| `ADR-019` | [主动智能外部连接本地网关](reference/adr/ADR-019-proactive-integrations-local-gateway.md) | 2026-08-29 | HA/健康连接、凭据隔离、工具白名单或撤销语义变更 | REST/WS、OAuth、实体/service 白名单、健康最小化或连接删除与实现不一致 |
| `AVX-HAR-001` | [Agent Harness Loop 设计与落地规范](reference/agent-harness-loop.md) | 2026-09-10 | G2 评审 + Agent Loop/Provider/工具/持久化边界变更 | Turn/Attempt/Step、Provider、Tool、Inbox、恢复或 Profile 语义与实现/ADR 不一致 |
| `AVX-HAR-002` | [Agent Loop 分阶段落地进展与追溯历史](reference/agent-loop-rollout-history.md) | 2026-09-10 | 各阶段代码落位、表结构或测试矩阵变更 | 落地条目、测试覆盖映射或包路径与实现不一致 |
| `AVX-WEB-001` | [Web 工作台实现规划](explanation/web-implementation.md) | 2026-09-11 | Web 端实现或技术基线变更 | `apps/web` 结构与 ADR-015/规划不一致 |
| `CR-002` | [Fairy Agent Electron 桌面端](reference/changes/CR-002-fairy-desktop-module.md) | 2026-09-10 | CAP-018 桌面端实现或安全边界变更 | Electron 端目录、契约边界、测试证据或回滚条件与实现不符 |
| `CR-003` | [SQLite 当前真源与历史 PG 兼容方案（已替代）](reference/changes/CR-003-sqlite-primary-pg-compat.md) | 2026-09-10 | 数据真源 / 仓储抽象变更 | Superseded 状态或历史范围与 CR-030 冲突 |
| `CR-004` | [人格插件 SQLite 持久化](reference/changes/CR-004-persona-sqlite-persistence.md) | 2026-09-10 | 数据库 schema / Port / 模块指针变更 | 表、Port 或 CR 状态与实现不一致 |
| `CR-005` | [共享工作台与 Web 无桌宠表现层](reference/changes/CR-005-shared-workbench-web-without-pet.md) | 2026-09-10 | 端形态与共享 UI 边界变更 | Electron/Web 目录、共享组件契约或回滚条件与实现不符 |
| `CR-006` | [插件配置解析与可视化](reference/changes/CR-006-plugin-config-and-pages.md) | 2026-09-10 | 插件配置/Page 机制变更 | 代码与 Config/Page 规范或安全边界不一致 |
| `CR-007` | [可替换 Live2D 桌宠渲染层](reference/changes/CR-007-live2d-sekai-viewer-pet.md) | 2026-09-10 | 桌宠渲染、模型资产或桌面依赖变更 | Live2D 资产许可、回退行为、资源预算或实现与 CR 不一致 |
| `CR-008` | [练习会话与作答契约补全](reference/changes/CR-008-practice-session-contract.md) | 2026-09-10 | `CAP-003` 练习会话、作答或报告契约变更 | SRS、OpenAPI、实现与 `FR-PRC-001` 的快照、幂等、会话状态和隔离规则不一致 |
| `CR-009` | [错题本忽略与恢复规则](reference/changes/CR-009-mistake-book-dismissal.md) | 2026-09-10 | `CAP-004` 错题本处置或重练规则变更 | SRS、API、数据库和 UI 对忽略状态、恢复与学习事实保留的语义不一致 |
| `CR-010` | [复习完成幂等与结果重放](reference/changes/CR-010-review-completion-idempotency.md) | 2026-09-10 | `CAP-006` 完成、重试或调度结果契约变更 | SRS、API、数据库、OpenAPI 和 UI 的幂等语义不一致 |
| `CR-011` | [时区安全的复习调度与逾期汇总](reference/changes/CR-011-timezone-safe-review-scheduling.md) | 2026-09-10 | `CAP-006` 时区来源、日界线或调度版本变更 | 时区快照、DST 算法、逾期口径与实现不一致 |
| `CR-012` | [Agent Harness Loop 目标规范与迁移基线](reference/changes/CR-012-agent-harness-loop.md) | 2026-09-10 | Agent Loop、TurnAttempt、工具管线、Provider 或部署形态变更 | AVX-HAR-001、流式协议、能力组合、实现阶段或回滚边界不一致 |
| `CR-013` | [活跃练习会话恢复与续答](reference/changes/CR-013-practice-session-recovery.md) | 2026-09-10 | `CAP-003` 活跃会话、题组快照或续答边界变更 | SRS、OpenAPI、持久化进度与工作台恢复行为不一致 |
| `CR-014` | [WebUI 语音输出配置](reference/changes/CR-014-voice-config-webui.md) | 2026-09-10 | `CAP-019/020` 系统语音输出 / 本地语音模型配置变更 | 表、契约、Voice 模块或设置 UI 与实现不一致 |
| `CR-015` | [WebUI 大语言模型与供应商配置](reference/changes/CR-015-llm-provider-config-webui.md) | 2026-09-10 | `CAP-020` / `ADR-005` 大语言模型供应商与配置变更 | 表、契约、LLM 模块或设置 UI 与实现不一致 |
| `CR-016` | [离线语音输入 ASR](reference/changes/CR-016-offline-voice-input-asr.md) | 2026-09-10 | `CAP-019/020` / `ADR-005` 离线语音输入与交互变更 | 表、契约、ASR 模块或输入交互与实现不一致 |
| `CR-017` | [文档治理与事实源标准化](reference/changes/CR-017-document-governance-standardization.md) | 2026-09-10 | 文档治理策略、校验门禁或迁移阶段变更 | AVX-DOC-GOV-001、机器策略、入口文档或 CI 门禁不一致 |
| `CR-018` | [错题错因记录工作流](reference/changes/CR-018-mistake-insight-workflow.md) | 2026-09-10 | `CAP-004` 错因元数据、筛选或工作台交互变更 | SRS、OpenAPI、数据库、API Client 与工作台错因语义不一致 |
| `CR-019` | [能力注册表状态同步：CAP-010~019 主仓交付裁定](reference/changes/CR-019-capability-registry-status-sync.md) | 2026-09-10 | 已落地 CAP 的自选状态 / 主仓交付边界变更 | 能力注册表、追踪基线 §4.2 或实现载体与 CR-019 结论不一致 |
| `CR-020` | [确定性练习反馈与下一轮建议](reference/changes/CR-020-deterministic-practice-guidance.md) | 2026-09-10 | `CAP-016` 作答观测、练习报告或自适应建议变更 | SRS、OpenAPI、作答事实、报告统计或工作台展示与确定性规则不一致 |
| `CR-021` | [向用户询问能力接入](reference/changes/CR-021-ask-user-question-capability.md) | 2026-09-10 | `CAP-001` / `AVX-HAR-001` 人机交互回环与向用户提问能力变更 | 流式协议、Loop 执行器、契约、API 协调或前端呈现不一致 |
| `CR-022` | [Turn 级完全访问工具权限开关](reference/changes/CR-022-full-access-tool-permission.md) | 2026-09-10 | `CAP-002/007/020/033` / `AVX-HAR-001` 工具授权模式、审计或双端开关变更 | CreateTurn 契约、自动授权排除、CAP-033 动作授权、API Client/IPC 或 Workbench 状态不一致 |
| `CR-023` | [广域本地主动智能模式](reference/changes/CR-023-proactive-local-intelligence-mode.md) | 2026-09-10 | `CAP-033` + `CAP-002/005/007/008/009/010/012/013/018/020/022/023/024/026/027/030` 广域画像、Agent Host/Inbox、OS 权限、本地私密数据或授权语义变更 | AVX-EXPL-008、CR-022、OS Permission Broker、本地 Provider/存储、撤权、导出或待决策不一致 |
| `CR-024` | [主动智能能力套件与外部环境连接](reference/changes/CR-024-proactive-intelligence-suite-integrations.md) | 2026-09-10 | `CAP-033/034/035` 十二能力、HA/健康连接、工具或本地数据结构变更 | ADR-019、OpenAPI、数据库、Worker、桌面设置、凭据或撤销删除与实现不一致 |
| `CR-025` | [桌面端首次启动引导](reference/changes/CR-025-desktop-first-run-onboarding.md) | 2026-09-10 | `CAP-001/018` 桌面首启、Live2D、模型配置入口或本机完成标记变更 | 首次启动判定、CR-015 配置复用、快速开始或启动过渡与实现不一致 |
| `CR-026` | [对话触发写日记与日记契约补全](reference/changes/CR-026-on-demand-diary.md) | 2026-09-10 | `CAP-009` 对话触发写日记、桌宠视角生成或审批事件契约变更 | PRD §6.7、流式协议、日记工具/生成核心、`/v1/diaries` 契约或工作台授权交互与实现不一致 |
| `CR-027` | [Turn 流活性治理：执行解耦、SSE 活流与思考增量透传](reference/changes/CR-027-turn-stream-liveness.md) | 2026-09-10 | 流式协议建流语义、思考事件类型、客户端超时/取消语义变更 | STREAMING_PROTOCOL、OpenAPI、Agent Loop/Provider、API Client/桌面桥或 Workbench 与实现不一致 |
| `CR-028` | [在线语音模型配置](reference/changes/CR-028-voice-remote-model-config.md) | 2026-09-10 | `CAP-019/020` 在线语音模型配置、api_v2 协议或设置 UI 变更 | 表、契约、Voice 模块远程 provider 或设置「语音」子页签与实现不一致 |
| `CR-029` | [模型 / 语音多预设与「你的思隅」设置页](reference/changes/CR-029-presets-and-siyu-settings.md) | 2026-09-10 | `CAP-020` 模型/语音多预设存储、预设 API、设置页导航或面板交互变更 | 表结构、OpenAPI、LLM/Voice service 或「你的思隅」设置页与实现不一致 |
| `CR-030` | [SQLite 永久本地单用户真源与去租户化](reference/changes/CR-030-pure-local-sqlite-database.md) | 2026-09-11 | Schema、Repository、API 监听、迁移或回滚变更 | D0～D3 状态、破坏性范围选择、备份/staging/原子换库与实现不一致 |
| `AVX-PLUG-001` | [插件 Config、Page 与 UI 扩展规范](reference/plugin-config-and-pages.md) | 2026-09-11 | CR-006 / 插件机制变更 | Manifest、Config Schema、Page Bridge、Turn 管道或 UI 扩展与实现不一致 |
| `AVX-DOC-GOV-001` | [文档治理与事实源规范](reference/document-governance.md) | 2026-09-10 | 文档分类、状态、事实源、复核触发或迁移策略变更 | 策略 JSON、校验器、索引、登记表或写作规范与治理基线不一致 |
| `AVX-STD-001` | [文档写作规范](reference/standards/doc-standards.md) | 2026-09-10 | 写作规则、模板或季度评审 | 新文档未使用规范元数据/签名，或 Vale 规则与术语表不一致 |
| `AVX-TERM-001` | [术语表](reference/standards/terminology.md) | 2026-09-10 | 术语新增/变更 | 新增缩写未登记，或正文拼写与「禁写」列不一致 |
| `AVX-TUT-001` | [教程：第一个对话](tutorials/first-conversation.md) | 2026-09-10 | 启动命令/端点变更 | 快速开始命令、Turn/SSE 端点与 README/契约不一致 |
| `AVX-TUT-002` | [教程：迁移已集成能力并接入 DSH/pi](tutorials/migrate-integrated-capabilities.md) | 2026-09-10 | 能力目录、DSH/pi 上游或迁移步骤变更 | 当前实现路径、固定 SHA、权限/隔离边界或验证命令与仓库不一致 |
| `AVX-TUT-003` | [教程：编写自定义 Agent 工具](tutorials/create-agent-tool.md) | 2026-09-10 | 工具运行时、安全级别或注册表持久化变更 | Schema 定义、安全级别枚举或 Handler 接口与代码不一致 |
| `AVX-EXPL-001` | [数据流总览](explanation/data-flow-overview.md) | 2026-09-10 | 模块/Worker/路由/数据真源变更 | SQLite 终态、迁移或新增 Worker 循环未入概念地图 |
| `AVX-EXPL-002` | [参考项目能力迁移与借鉴评估](explanation/reference-design-transfer.md) | 2026-09-10 | 参考项目升级或架构变更 | 新增借鉴决策未登记，或参考项目 commit 超出固定清单 |
| `AVX-EXPL-003` | [桌宠角色设定文档化与多人格模板组织](explanation/persona-organization.md) | 2026-08-26 | 桌宠 IP / CAP-019 立项或人设变更 | 新增/变更角色文档未按字段化结构与模板版本化落地，或识别边界未同步评审 |
| `AVX-EXPL-004` | [能力拆分路线（已归档）](explanation/roadmap.md) | 2026-09-10 | CAP 批次/依赖变更时 | 批次顺序与追踪基线 CAP 状态或新增 CAP 不一致 |
| `AVX-EXPL-005` | [ESP32-S3 硬件延伸](explanation/esp32-s3-hardware-extension.md) | 2026-09-10 | 硬件方案、设备协议或设备能力（独立设备 CAP 提议）立项变更 | 硬件边界、设备协议、隐私红线或阶段结论与 ADR-016 / 追踪基线 §4.2 / 数据隐私规范不一致 |
| `AVX-EXPL-006` | [Home Assistant 集成评估（已归档）](explanation/home-assistant-integration-assessment.md) | 2026-09-10 | Agent Loop 工具机制 / 本地优先 / 插件机制变更 | HA 接入形态、数据实体或阶段结论与 CR-024 / ADR-019 不一致 |
| `AVX-EXPL-007` | [运动与健康数据接入评估（已归档）](explanation/health-data-integration-assessment.md) | 2026-09-10 | 移动端形态 / 数据隐私 / 苹果或小米接入政策变更 | 接入路径、敏感分级或阶段结论与 CR-024 / DATA_PRIVACY 不一致 |
| `AVX-EXPL-008` | [主动智能模式设计方案](explanation/proactive-intelligence-mode.md) | 2026-09-10 | CR-023/CAP-033、完全访问、全量画像、OS 能力授权、特权观察 Host、本地处理、动作授权、CAP-022/026/027/030 变更 | 四维状态、完整画像 manifest、平台能力清单、OS grant、本地出网边界、七天提炼保留、动作授权、阻断项或实现门禁与基线不一致 |
| `AVX-EXPL-009` | [`packages/database` 拆分规划（已归档）](explanation/database-split-plan.md) | 2026-09-10 | `packages/database` schema/仓储接口、包结构或拆分方向变更 | 拆分方向、包边界、re-export 兼容层或分阶段落点与实现/ADR-014/追踪基线 §4.2 不一致 |
| `AVX-DOC-001` | [文档索引](README.md) | 2026-09-11 | 每季度 + 每次文档集变更 | 事实源映射与仓库实际不符 |
| `AVX-DOC-002` | [从哪开始](getting-started.md) | 2026-09-10 | 每季度 + 每次文档集变更 | 仓库结构/阅读顺序/自检清单与索引或实际不符 |
| `AVX-DOC-CONF-001` | [文档生命周期登记表](DOC_REGISTRY.md) | 2026-09-12 | 每季度 + 每次文档集变更 | 登记条目与实际文档集不一致 |

## 维护规则

- 登记强度按[文档写作规范 §3.1 改动等级](reference/standards/doc-standards.md#31-改动等级与同步要求)执行；分类、状态与事实源边界以[文档治理规范](reference/document-governance.md)为准：
  - L1 编辑性：只过 ci-docs，不登记；
  - L2 内容更新：更新本表「最后核验」日期，不新增/改条目；
  - L3 结构性（新增文档、目录迁移、编号/类型/事实源变更）：新增或更新条目，并同步[文档索引](README.md)体系表与[从哪开始](getting-started.md)入口；
- 每份文档创建/改版时，按上一条分级在此登记或更新对应条目（编号、核验日期、陈旧信号）；
- 新增文档按[文档治理规范 §4](reference/document-governance.md#4-元数据和状态模型)标注元数据，并按[文档写作规范](reference/standards/doc-standards.md)维护标题、签名与体例；
- 核验时更新 `最后核验` 日期；长期未核验或陈旧信号命中时按[更新与评审节奏](README.md#4-更新与评审节奏)处置。
