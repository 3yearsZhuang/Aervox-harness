---
id: AVX-HOW-001
type: how-to
scope: guide
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.1.0
updated_at: 2026-09-10
reviewed_at: 2026-09-10
review_interval_days: 90
sources:
  - docs/how-to/engineering-process.md
  - docs/how-to/write-adr.md
  - docs/how-to/submodule-collaboration.md
  - docs/how-to/develop-plugin-ui-extension.md
---

# 操作指南（How-to Guides）索引

- 提出人：3yearszhuang · 2026-08-26
- 修改人：codex · 2026-09-10

关联：[文档索引](../README.md) · [从哪开始](../getting-started.md) · [文档治理规范](../reference/document-governance.md)

本目录归档 Aervox 项目的 **Diátaxis 操作指南（How-to Guides）**：以目标为导向、面向特定工程任务的一系列分步操作指南。回答“如何完成某项具体工程任务”。

## 指南列表

| 指南编号 | 指南文档 | 目标与适用场景 | 关键依赖与产出 |
|---|---|---|---|
| `AVX-GUIDE-001` | [工程与发布流程](engineering-process.md) | 新增/修改需求、执行发布门禁检查、演练与维护流程 | 需求分级、DoR 检查、Release Gate、演练留痕 |
| `AVX-GUIDE-002` | [撰写与批准 ADR](write-adr.md) | 针对关键不可逆或跨模块架构决策立项、起草并批准 ADR | MADR 模板、六阶段评审、状态迁移 |
| `AVX-GUIDE-003` | [submodule 初始化与协作规范](submodule-collaboration.md) | 管理与维护可选能力子模块（如 Live2D 资产等外部子仓库） | 初始化、更新工作流、脏状态防护、CI 构建 |
| `AVX-GUIDE-004` | [开发 Aervox 扩展插件](develop-plugin-ui-extension.md) | 开发可配置、可启停并能扩展 Turn 与工作台 UI 的插件 | Bundle、Server Turn Plugin、UI 插槽、组件替换与门禁 |

## 写作要求与指引

- 操作指南采用目标导向风格，步骤明确、结果可验证；
- 避免在指南中长篇阐述设计原理（原理请沉淀至 `docs/explanation/` 或 `docs/reference/`）；
- 新增指南文档须符合 [文档治理规范](../reference/document-governance.md) 的元数据规范，并在 [文档生命周期登记表](../DOC_REGISTRY.md) 及 [文档索引](../README.md) 中登记。
