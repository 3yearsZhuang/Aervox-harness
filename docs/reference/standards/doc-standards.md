# 文档写作规范（Docs-as-Code × Diátaxis）

> 文档编号：AVX-STD-001
> 类型：Reference
> 版本：v0.1
> 更新日期：2026-08-25
> 状态：Review Candidate
> 责任角色：文档负责人
> 关联：[文档索引](../../README.md)、[生命周期登记表](../../DOC_REGISTRY.md)、[术语表](terminology.md)

本规范定义每类文档回答什么问题、文档头怎么填、放哪个目录、用什么命名，以及提交前如何被自动校验。它是 [docs/README.md §1 文档体系](../../README.md#1-文档体系与事实源) 的写作层配套规则。

## 1. 文档分类（Diátaxis 四分类）

| 类型 | 读者意图 | 回答的问题 | 现有目录 | 体例 |
|---|---|---|---|---|
| Tutorials | 学习 | 从 0 跑起来的第一课 | `docs/tutorials/` | 可跟做步骤 + 前置条件 + 可验证结果 |
| How-to | 完成任务 | 怎么做某件事 | `docs/how-to/` | 明确目标 + 步骤 + 门禁/陷阱提醒 |
| Reference | 查信息 | 准确事实是什么 | `docs/reference/`（含 `adr/`、`changes/`、`standards/`、`diagrams/`） | 定义/契约/清单，机器可验证优先 |
| Explanation | 理解 | 为什么这样设计、如何运转 | `docs/explanation/`（含实现规划与可选模块方案） | 概念、因果与权衡，少用命令 |

规则：

- 一份文档只服务一种类型，混写时拆分；
- 目录可归属类型的文档，类型由目录推断；`docs/` 根层只保留导航/登记类文档（文档索引、生命周期登记表）；
- 导航/登记类（[文档索引](../../README.md)、[生命周期登记表](../../DOC_REGISTRY.md)）不属于四分类，登记编号即可，不标 `类型`；
- ADR 整体属于 Reference（决策事实），其单篇的 Context/Consequences 承担讲解职责，不再另设类型。

## 2. 文档头元数据

必填字段：

| 字段 | 示例 | 说明 |
|---|---|---|
| 文档编号 | `AVX-DB-001` | `AVX-###-###`、`ADR-###` 或 `CR-###`；编号一经分配不复用 |
| 类型 | `Reference` | `Tutorials`/`How-to`/`Reference`/`Explanation`，取第 1 节四分类之一 |
| 版本 | `v0.1` | 语义化主.次 |
| 更新日期 | `2026-08-25` | 与登记表「最后核验」同步更新 |
| 状态 | `Review Candidate` | `Draft`/`Review Candidate`/`Approved`/`Superseded`/`Retired`，含义见 [文档索引 §3](../../README.md#3-文档状态) |

示例：

```markdown
> 文档编号：AVX-STD-001
> 类型：Reference
> 版本：v0.1
> 更新日期：2026-08-25
> 状态：Review Candidate
```

可选字段：`责任角色`（角色名）、`关联`（相对链接，逗号分隔）。

## 3. 目录与命名

- 新增文档优先放入第 1 节表中可归属类型的目录；
- 文件名一律 kebab-case、ASCII 小写（如 `doc-standards.md`）；`ADR-`/`CR-` 编号类文件例外，采用 `类型-###-kebab-case`；
- 文档迁移后旧路径自动失效：任何跨文档引用一律用相对链接，由链接检查（CI lychee + 本地相对链接检查）兜底；
- 新增文档后必须同步 [DOC_REGISTRY.md](../../DOC_REGISTRY.md) 与 [文档索引](../../README.md) 体系表。

### 3.1 改动等级与同步要求

为降低每次改动的登记摩擦，登记强度按改动等级分级（对齐 [追踪基线 §11.2 变更分类](../../reference/REQUIREMENTS_TRACEABILITY.md#112-变更分类与批准)）：

| 等级 | 改动类型 | 示例 | 同步要求 |
|---|---|---|---|
| L1 编辑性 | 无语义变化 | 拼写、格式、链接修复 | 仅过 ci-docs，不登记 |
| L2 内容更新 | 不改文档编号/类型/目录 | 补数据、改结论、修订规则 | 更新 [DOC_REGISTRY.md](../../DOC_REGISTRY.md) 「最后核验」日期 |
| L3 结构性 | 改变编号/类型/目录/事实源 | 新增文档、目录迁移、文档拆分合并 | 同步 DOC_REGISTRY 条目 + [文档索引](../../README.md) 体系表 + 导航入口 |

规则：

- 编辑性（L1）与内容更新（L2）不需要改动 DOC_REGISTRY 条目本身，也不强制同步文档索引；
- 结构性（L3）必须全量同步三处：登记表、索引体系表、[从哪开始](../../getting-started.md) 入口（若影响导航）；
- 修改已批准文档（`Approved`/`Review Candidate` 状态）仍按 [追踪基线 §11](../../reference/REQUIREMENTS_TRACEABILITY.md#11-变更控制) 先建 `CR-*`，分级只决定登记强度，不豁免变更控制。

## 4. 写作风格基线

- 正文使用中文；代码、标识符、命令与术语表中的规范写法保留原文；
- 结论先行：每节第一句给出结论或目标，再展开；
- 术语唯一：以 [术语表](terminology.md) 为准，交由 Vale 自动校验（第 5 节）；
- 禁用形容词验收（"智能、自然、友好"等），用可验证描述表达（对齐 [文档索引 §6](../../README.md#6-专业基线自检)）；
- 引用同仓库文档一律使用相对链接，锚点变更须同步更新引用；不引用外部临时链接充当事实源。

## 5. Vale 术语门禁

- 配置：根目录 [.vale.ini](../../../.vale.ini) + `.vale/styles/`（Vocab 词典 + `Project/Terms.yml` 检查规则）；
- 本地：`mise tasks run docs-lint-prose`（等价 `vale --minAlertLevel=error docs README.md`）；
- CI：并入 `mise tasks run ci-docs`，改动 `docs/`、`README.md`、`.vale/` 或 `.vale.ini` 的 PR 与 main 推送都会执行；
- 新增术语：先在 `Vocab/Aervox/accept.txt` 登记（缩写/产品名），再考虑追加 `Terms.yml` 检查规则。

## 6. 模板族

| 文档类 | 模板 | 场景 |
|---|---|---|
| How-to | [../../templates/how-to.md](../../templates/how-to.md) | 操作指南 |
| Reference | [../../templates/reference.md](../../templates/reference.md) | 契约、策略、数据库等规范 |
| Explanation | [../../templates/explanation.md](../../templates/explanation.md) | 概念讲解、数据流总览 |
| ADR | [写 ADR 指南](../../how-to/write-adr.md) + [ADR 索引](../adr/README.md) | 架构决策记录 |

- 提交前自检第 3 步会校验全部相对链接，任何目录迁移后先跑链接检查再推送。

## 7. 提交前自检

1. `npx markdownlint-cli2 --config .markdownlint-cli2.jsonc "docs/**/*.md" "README.md"`；
2. `mise tasks run docs-lint-prose`（Vale 0 错误）；
3. 相对链接逐一存在；CI 另有 lychee 全量检查（排除 `reference/`、`demos/`）；
4. 新增/改版文档后在 [DOC_REGISTRY.md](../../DOC_REGISTRY.md) 与 [文档索引](../../README.md) 同步编号、类型、核验日期。
