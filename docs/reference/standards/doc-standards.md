# 文档写作规范（Docs-as-Code × Diátaxis）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-28

> 文档编号：AVX-STD-001
> 类型：Reference
> 版本：v0.2
> 更新日期：2026-08-28
> 状态：Review Candidate
> 关联：[文档治理与事实源规范](../document-governance.md)、[文档索引](../../README.md)、[生命周期登记表](../../DOC_REGISTRY.md)、[术语表](terminology.md)

本规范定义文档如何套用模板、维护标题下签名、命名、写作并通过门禁。文档分类、唯一事实源、状态模型、owner 与复核触发器以[文档治理与事实源规范](../document-governance.md)为唯一事实源；本文不重复定义这些治理规则。

## 1. 文档分类（Diátaxis 四分类）

| 类型 | 读者意图 | 回答的问题 | 现有目录 | 体例 |
|---|---|---|---|---|
| Tutorials | 学习 | 从 0 跑起来的第一课 | `docs/tutorials/` | 可跟做步骤 + 前置条件 + 可验证结果 |
| How-to | 完成任务 | 怎么做某件事 | `docs/how-to/` | 明确目标 + 步骤 + 门禁/陷阱提醒 |
| Reference | 查信息 | 准确事实是什么 | `docs/reference/`（含 `adr/`、`changes/`、`standards/`、`diagrams/`） | 定义/契约/清单，机器可验证优先 |
| Explanation | 理解 | 为什么这样设计、如何运转 | `docs/explanation/`（含实现规划与可选模块方案） | 概念、因果与权衡，少用命令 |

目录职责的完整规则见[文档治理规范 §2](../document-governance.md#2-文档分类与目录职责)。写作时遵守：

- 一份文档只服务一种类型，混写时拆分；
- 目录可归属类型的文档，类型由目录推断；`docs/` 根层只保留导航/登记类文档（文档索引、生命周期登记表）；
- 导航/登记类（[文档索引](../../README.md)、[生命周期登记表](../../DOC_REGISTRY.md)）不属于四分类，登记编号即可，不标 `类型`；
- ADR 整体属于 Reference（决策事实），其单篇的 Context/Consequences 承担讲解职责，不再另设类型。

## 2. 文档头元数据

新建文档使用 YAML front matter；历史 blockquote/bullet 元数据在迁移期继续兼容，但不得为新文档引入第三种格式。字段语义与允许状态见[文档治理规范 §4](../document-governance.md#4-元数据和状态模型)。

最低必填字段：

| 字段 | 示例 | 说明 |
|---|---|---|
| `id` | `AVX-DB-001` | `AVX-###-###`、`ADR-###` 或 `CR-###`；编号一经分配不复用 |
| `type` | `reference` | `tutorial` / `how-to` / `reference` / `explanation`，与目录一致 |
| `scope` | `baseline` | 文档在治理生命周期中的作用域 |
| `owner` | `platform` | 稳定团队角色，不使用临时个人作为长期 owner |
| `doc_status` | `review-candidate` | 只表达文档可用性；决策与交付状态另列 |
| `version` | `0.2.0` | 语义化版本，不加 `v` 前缀 |
| `updated_at` | `2026-08-28` | 正文或元数据最近变更日期 |
| `reviewed_at` | `2026-08-28` | owner 最近确认内容仍与事实源一致的日期 |

示例：

```yaml
---
id: AVX-STD-001
type: reference
scope: baseline
owner: docs
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.2.0
updated_at: 2026-08-28
reviewed_at: 2026-08-28
review_interval_days: 90
---
```

front matter 后写标题与点阵签名：

```markdown
# 文档标题

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28
```

**文档签名（强制）**：每份文档标题下第一位置必须带两行点阵签名 `- 提出人：<GitHub 账号> · <日期>` 与 `- 修改人：<GitHub 账号> · <日期>`（提出人填文档首次建立者，修改人填最近一次内容变更者，两者可相同）。内容或文档头字段每次变更都必须更新 `修改人` 账号与日期，禁止只改正文不动签名（对应 [AGENTS.md 硬约束](../../../AGENTS.md)）。导航/登记类文档同样适用。

ADR 另填 `decision_status`；CR 同时填写 `decision_status` 与 `delivery_status`。不适用时显式写 `not-applicable`。关联事实源使用 `sources`，正文中的同仓库引用继续使用相对链接。

## 3. 目录与命名

- 新增文档优先放入第 1 节表中可归属类型的目录；
- 文件名一律 kebab-case、ASCII 小写（如 `doc-standards.md`）；`ADR-`/`CR-` 编号类文件例外，采用 `类型-###-kebab-case`；
- 文档迁移后旧路径自动失效：任何跨文档引用一律用相对链接，由链接检查（CI lychee + 本地相对链接检查）兜底；
- 新增文档后必须同步 [DOC_REGISTRY.md](../../DOC_REGISTRY.md) 与 [文档索引](../../README.md) 体系表。

### 3.1 改动等级与同步要求

为降低每次改动的登记摩擦，登记强度按改动等级分级（对齐 [追踪基线 §11.2 变更分类](../REQUIREMENTS_TRACEABILITY.md#112-变更分类与决策)）：

| 等级 | 改动类型 | 示例 | 同步要求 |
|---|---|---|---|
| L1 编辑性 | 无语义变化 | 拼写、格式、链接修复 | 仅过 ci-docs，不登记 |
| L2 内容更新 | 不改文档编号/类型/目录 | 补数据、改结论、修订规则 | 更新 [DOC_REGISTRY.md](../../DOC_REGISTRY.md) 「最后核验」日期 |
| L3 结构性 | 改变编号/类型/目录/事实源 | 新增文档、目录迁移、文档拆分合并 | 同步 DOC_REGISTRY 条目 + [文档索引](../../README.md) 体系表 + 导航入口 |

规则：

- 编辑性（L1）不更新登记；内容更新（L2）只更新既有 DOC_REGISTRY 条目的「最后核验」，不新增条目也不强制同步文档索引；
- 结构性（L3）必须全量同步三处：登记表、索引体系表、[从哪开始](../../getting-started.md) 入口（若影响导航）；
- 修改已批准文档或已接受决策仍按 [追踪基线 §11](../REQUIREMENTS_TRACEABILITY.md#11-变更控制) 先建 `CR-*`，分级只决定登记强度，不豁免变更控制。

## 4. 写作风格基线

- 正文使用中文；代码、标识符、命令与术语表中的规范写法保留原文；
- 结论先行：每节第一句给出结论或目标，再展开；
- 术语唯一：以 [术语表](terminology.md) 为准，交由 Vale 自动校验（第 5 节）；
- 禁用形容词验收（"智能、自然、友好"等），用可验证描述表达（对齐 [文档索引 §5](../../README.md#5-专业基线自检)）；
- 引用同仓库文档一律使用相对链接，锚点变更须同步更新引用；不引用外部临时链接充当事实源。

## 5. Vale 术语门禁

- 配置：根目录 [.vale.ini](../../../.vale.ini) + `.vale/styles/`（Vocab 词典 + `Project/Terms.yml` 检查规则）；
- 本地：`mise tasks run docs-lint-prose`（等价 `vale --minAlertLevel=error docs README.md CONTRIBUTING.md AGENTS.md`）；
- CI：并入 `mise tasks run ci-docs`，改动 `docs/`、`README.md`、`CONTRIBUTING.md`、`AGENTS.md`、`.vale/` 或 `.vale.ini` 的 PR 与 main 推送都会执行；
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

1. `mise tasks run docs-validate`：重复 ID、签名、本地路径/锚点、登记路径与日期 0 错误；
2. `mise tasks run docs-lint-prose`：Vale 0 错误；
3. `mise tasks run ci-docs`：一次执行 Markdown、Vale 与治理校验；CI 另有 lychee 检查（排除 `reference/`、`demos/`）；
4. L3 新增/改版文档后在 [DOC_REGISTRY.md](../../DOC_REGISTRY.md) 与 [文档索引](../../README.md) 同步编号、类型、核验日期和导航入口。
