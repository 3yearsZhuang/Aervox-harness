# 文档生命周期登记表（Owner 指派与核验）

> 文档编号：AVX-DOC-CONF-001  
> 版本：v0.1  
> 更新日期：2026-08-24  
> 状态：评审候选  
> 文档负责人：文档负责人（待指定）  
> 关联：[文档索引](README.md)

本表跟踪每份关键文档的责任角色、最后核验时间与陈旧信号。责任角色按[文档索引 §4 角色模型](README.md#4-责任与审批)落地，具体人名在评审时回填；`最后核验` 默认取文档头更新日期，核验后更新该字段。文档体系总览与权威顺序见[文档索引](README.md)。

| 文档编号 | 文档 | 责任角色（人名待定） | 最后核验 | 核验节奏 | 陈旧信号 |
|---|---|---|---|---|---|
| `AVX-PRD-001` | [PRD](PRD.md) | 产品负责人 | 2026-08-24 | 每次版本立项 / G0 | CAP 范围或优先级变更未建立 `CR-*` |
| `AVX-SRS-001` | [SRS](requirements/SRS.md) | 产品与模块负责人 | 2026-08-24 | G1 需求基线前 | 版本内 FR/BR/AC 变化未同步或未过 DoR |
| `AVX-SAD-001` | [架构设计](ARCHITECTURE.md) | 技术负责人 | 2026-08-24 | G2 评审 + 架构变更 | 新增 ADR/技术基线变化未同步 |
| `ADR-001~014` | [ADR 索引](architecture/adr/README.md) | 技术负责人（各 ADR 另有 Owner） | 2026-08-24 | G2 评审 + 决策变更 | 决策被 `Superseded/Rejected` 未登记 |
| `AVX-SPC-001` | [流式协议](contracts/STREAMING_PROTOCOL.md) | 技术负责人 | 2026-08-24 | OpenAPI/事件 schema 变更 | `packages/contracts` 版本高于文档描述 |
| `AVX-DB-001` | [数据库设计与双引擎契约](contracts/DATABASE.md) | 技术负责人 | 2026-08-24 | Schema/仓储接口/迁移计划变更 | 仓储接口签名或租户隔离模式/PG 切换计划与实现不一致 |
| `AVX-DATA-001` | [数据与隐私](DATA_PRIVACY.md) | 安全与隐私负责人 | 2026-08-24 | 每季度 + 数据流变更 | 新增数据实体/用途/保留未评审 |
| `AVX-AIQ-001` | [AI 质量与安全](AI_QUALITY_SAFETY.md) | AI 质量负责人 | 2026-08-24 | 模型/Prompt/算法变更 + AI 评估 | ModelRun/PromptVersion 更新未同步 |
| `AVX-SEC-001` | [威胁模型](security/THREAT_MODEL.md) | 安全与隐私负责人 | 2026-08-24 | 每季度 + 信任边界变更 | 新增数据流/信任边界未加入威胁模型 |
| `AVX-QA-001` | [测试策略](qa/TEST_STRATEGY.md) | QA 负责人 | 2026-08-24 | G1/G4 门禁 | AC/TC 状态变化未回填 |
| `AVX-OPS-001` | [运行与恢复手册](operations/RUNBOOK.md) | 运维/平台负责人 | 2026-08-24 | 每季度演练 + 每次发布 | 演练日期超期或告警/拓扑变化未更新 |
| `AVX-TRC-001` | [需求追踪与交付基线](REQUIREMENTS_TRACEABILITY.md) | 文档负责人（QA 复核） | 2026-08-24 | 版本立项 / G1 / G4 | CAP/AC/TC 状态或追踪关系变化未回填 |
| `AVX-GUIDE-001~006` | [操作指南](how-to/) | 文档负责人 | 2026-08-24 | 规则变更或季度评审 | 与追踪/ADR/门禁流程表述不符 |
| `AVX-ONC-001` | [值班与升级矩阵](operations/ONCALL.md) | 运维/平台负责人（安全复核） | 2026-08-24 | 每次值班变更 + 季度 | 联系人/升级时限变更未同步 |
| `AVX-DRL-001` | [演练证据模板](operations/DRILL_TEMPLATE.md) | 运维/平台负责人 | 2026-08-24 | 每季度演练后 | 演练项/通过标准与运行手册不符 |
| `AVX-MOD-001` | [可选功能模块化方案](architecture/optional_modules.md) | 技术负责人 | 2026-08-24 | G2 评审 + 模块机制变更 | 模块清单/接口边界与 `modules/*` 实际不符 |
| `CR-002` | [Fairy Agent Electron 桌面端](changes/CR-002-fairy-desktop-module.md) | 产品与技术负责人 | 2026-08-24 | CAP-018 桌面端实现或安全边界变更 | Electron 端目录、契约边界、测试证据或回滚条件与实现不符 |
| `CR-003` | [SQLite 业务真源与 PG 兼容](changes/CR-003-sqlite-primary-pg-compat.md) | 技术负责人 | 2026-08-24 | 数据真源 / 仓储抽象变更 | 仓储接口或 PG 切换计划与实现不符 |
| `AVX-DOC-001` | [文档索引](README.md) | 文档负责人 | 2026-08-24 | 每季度 + 每次文档集变更 | 事实源映射与仓库实际不符 |

## 维护规则

- 每份文档创建/改版时，在此登记或更新对应条目（编号、负责人、核验日期、陈旧信号）；
- 新增文档后同步[文档索引](README.md)的体系表与[从哪开始](README.md#8-从哪开始)入口；
- 核验时更新 `最后核验` 日期；长期未核验或陈旧信号命中时按[更新与评审节奏](README.md#5-更新与评审节奏)处置。
