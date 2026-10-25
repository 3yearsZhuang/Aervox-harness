---
id: AVX-DOC-001
---

# 文档导航

按当前任务选入口。需要安装和首次运行时，从[从哪开始](getting-started.md)开始；开发与写作规则见[贡献指南](../CONTRIBUTING.md)，迭代排序见[当前计划](../plan.md)。

## 按任务查阅

| 要解决的问题 | 入口 |
|---|---|
| 产品面向谁、为什么做、哪些能力在范围内 | [产品需求](reference/PRD.md) |
| 功能应如何表现、怎样验收 | [SRS](reference/SRS.md) |
| 能力做到哪一步、还有哪些阻断 | [需求追踪与发布门槛](reference/REQUIREMENTS_TRACEABILITY.md) |
| 模块职责、参考项目学习和演进取舍 | [架构](reference/ARCHITECTURE.md)、[ADR](reference/adr/README.md)、[能力组合](reference/capability-composition.md) |
| 数据、事务、迁移和删除 | [数据库契约](reference/DATABASE.md)、[迁移演练](how-to/run-database-migration-drill.md) |
| 开发或演进 HTTP API | [API 约定](reference/API_CONVENTIONS.md) |
| 执行、取消、恢复与事件流 | [Agent Harness Loop](reference/agent-harness-loop.md)、[流式协议](reference/STREAMING_PROTOCOL.md) |
| 开发插件、Page、Tool 或 UI 扩展 | [扩展指南](how-to/develop-plugin-ui-extension.md)、[插件契约](reference/plugin-config-and-pages.md) |
| 接入微信私聊、QQ 群及运行常驻 Bot | [连接机器人](how-to/connect-bots.md)、[Bot 架构决定](reference/adr/ADR-029-bot-platform-adapters.md) |
| AI 质量、安全威胁、隐私责任 | [AI 质量与安全](reference/AI_QUALITY_SAFETY.md)、[威胁模型](reference/THREAT_MODEL.md)、[数据隐私](reference/DATA_PRIVACY.md) |
| 设计、测试与运行维护 | [交互设计](reference/DESIGN.md)、[测试策略](reference/TEST_STRATEGY.md)、[运行手册](reference/operations.md) |
| 执行具体工程操作 | [操作指南](how-to/README.md) |
| 理解研究背景与未来方案 | [解释与研究](explanation/README.md) |

<a id="2-权威顺序与冲突处理"></a>

## 事实源与历史

产品范围由 PRD 定义，可观察行为由 SRS 定义，技术决定由架构与 ADR 说明，机器契约由代码及 Schema 提供。测试和 PR 证明实现情况，不能反向修改需求或法律、安全、隐私承诺；文档冲突按[贡献指南](../CONTRIBUTING.md#documentation)处理。

版本变更与验证证据通过 [Pull Requests](https://github.com/3yearsZhuang/Aervox-harness/pulls) 和 Git 历史追溯，能力状态与剩余发布门槛以[需求追踪](reference/REQUIREMENTS_TRACEABILITY.md)为准。代码合并、验收通过和正式发布分别取证，不在导航页复制交付流水。

既有稳定编号用于追溯。已归档的 CR 与退役记录仍见 [Aervox-docs-archive](https://github.com/3yearsZhuang/Aervox-docs-archive)，主仓原 CR-055/057/060/061/062/063 已并入 [ADR](reference/adr/README.md)。架构设计、参考项目版本、许可证与演进研究统一维护在[架构与参考学习](reference/ARCHITECTURE.md#reference-learning)。

已完成的卫生审计及整理前的计划、架构详细证据见[归档包](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation)；旧 CR-030 D2 目标 ERD 另见[历史图](https://github.com/3yearsZhuang/Aervox-docs-archive/blob/397d4b4bc924d1315205577ed4fb88a4df2c0619/archive/database-sqlite-erd-cr030-target.md)，现行表结构以 Schema 源码为准。活动计划保留原编号、剩余验收和交付链接，归档不改变需求或发布状态。

第一方根界面与平台装配见 [ADR-025](reference/adr/ADR-025-ui-surface-hosts.md)，第三方界面开放的未决提案见 [ADR-026](reference/adr/ADR-026-ui-surface-open-ecosystem.md)。
