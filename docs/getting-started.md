---
id: AVX-DOC-002
type: tutorial
scope: guide
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.4.0
updated_at: 2026-10-08
reviewed_at: 2026-10-08
review_interval_days: 90
---

# 从哪开始（新成员 / AI Agent 入口）

关联：[文档索引](README.md)（AVX-DOC-001）

面向新成员或首次接触本仓库的 AI Agent：仓库里有什么、从哪里看、提交前自检什么。规则详情以各专项文档为准。

## 1. 仓库结构

| 路径 | 用途 |
|---|---|
| `apps/`、`packages/`、`plugins/`、`modules/` | 宿主、共享包与扩展；实际拓扑见[架构设计](reference/ARCHITECTURE.md) |
| `plan.md` | 当前迭代入口，条目由 `docs/_meta/plan-queue.json` 生成 |
| `docs/` | 导航、教程、指南、契约与解释；目录职责见[治理规范 §2](reference/document-governance.md#2-文档分类与目录职责) |
| `reference/` | 固定版本的外部设计输入；清单与许可证见 [PRD §15](reference/PRD.md#prd-reference-manifest) |
| `scripts/`、`mise.toml` | 自动化检查、生成任务与工具链真源 |

## 2. 阅读顺序

1. 先读 [plan.md](../plan.md)，核对当前条目与依赖；用户本次授权优先。
2. 按[文档索引](README.md)进入所需事实源：产品范围查 PRD，行为查 SRS，边界查 ARCHITECTURE/ADR，交付查追踪基线。
3. 本地启动按[第一个对话](tutorials/first-conversation.md)操作；贡献流程查 [CONTRIBUTING](../CONTRIBUTING.md)。外部参考子模块按需初始化，不作为默认构建前置条件；专项适配测试的要求见贡献指南。
4. 开发扩展先读[插件规范](reference/plugin-config-and-pages.md)及[开发指南](how-to/develop-plugin-ui-extension.md)；执行、取消与恢复查 [Agent Harness Loop](reference/agent-harness-loop.md)。
5. 修改文档先读[治理规范](reference/document-governance.md)与[写作规范](reference/standards/doc-standards.md)。硬件、移动、HLS 等探索从[解释索引](explanation/README.md)进入，实施状态回到队列核实。

## 3. 写作与改动的硬性规则

硬性规则以专项文档为事实源，先读再改：

- ID/优先级/阶段语义与不可改动原则：[追踪基线 §1](reference/REQUIREMENTS_TRACEABILITY.md#1-目的与使用方式)；
- 文档分类、状态、事实源与复核触发：[文档治理规范 §2-5](reference/document-governance.md#2-文档分类与目录职责)；
- 新增/改版文档的头字段、Git 留痕与模板：[文档写作规范 §1-2/§6](reference/standards/doc-standards.md#1-文档分类diátaxis-四分类)；
- 已批准文档的变更（含 `CR-*`）与变更豁免：[追踪基线 §11](reference/REQUIREMENTS_TRACEABILITY.md#11-变更控制)；
- 登记强度分级（L1/L2/L3）与登记表同步：[文档写作规范 §3.1](reference/standards/doc-standards.md#31-改动等级与同步要求)、[生命周期登记表](DOC_REGISTRY.md)；
- 参考仓库使用边界：[PRD §15](reference/PRD.md#15-参考项目与借鉴边界)。

## 4. 提交前自检（Docs CI 门禁）

文档修改后运行 `mise tasks run ci-docs`；提交前运行 `./aervox ci all`。前者组合 Markdownlint、Vale、治理、架构拓扑与计划校验，任务内容以 [mise.toml](../mise.toml) 为准。需要修复排版时使用 `mise exec -- markdownlint-cli2 --fix <files>`，避免绕开固定工具版本。

队列变更先运行 `mise tasks run plan-render`；文档日期变更用 `mise tasks run docs-sync` 同步登记表。其余生成视图与校验入口见[治理规范 §6](reference/document-governance.md#6-索引登记和生成视图)。

## 5. 需要介入时

- 文档冲突：停止相关发布，按[文档索引的权威顺序](README.md#2-权威顺序与冲突处理)仲裁；
- 生产问题：按[运行、值班与演练手册](reference/operations.md)升级；
- 变更请求：走[变更流程](reference/REQUIREMENTS_TRACEABILITY.md#113-变更流程)。

## 6. 下一步

按[第一个对话](tutorials/first-conversation.md)完成启动与验证，再从 [plan.md](../plan.md)认领具体工作。历史评估只用于理解证据，最新实现以代码、测试和[交付基线](reference/REQUIREMENTS_TRACEABILITY.md)核实。

## 7. 常用开发环境变量

启动参数与默认值见根 [README](../README.md) 的使用说明和[第一个对话](tutorials/first-conversation.md)；可配置键见 [.env.example](../.env.example)，数据库路径规则见 [DATABASE §3](reference/DATABASE.md#3-本地存储拓扑)。本入口不再复制一张可能与代码漂移的默认值表。
