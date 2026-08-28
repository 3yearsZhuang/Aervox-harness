---
id: AVX-DOC-GOV-001
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.1.0
updated_at: 2026-08-28
reviewed_at: 2026-08-28
review_interval_days: 90
review_triggers:
  - docs/**
  - README.md
  - AGENTS.md
  - CONTRIBUTING.md
sources:
  - docs/reference/standards/doc-standards.md
  - docs/DOC_REGISTRY.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# 文档治理与事实源规范

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

关联：[文档索引](../README.md)、[文档写作规范](standards/doc-standards.md)、[生命周期登记表](../DOC_REGISTRY.md)、[需求追踪基线](REQUIREMENTS_TRACEABILITY.md)、[工程与发布流程](../how-to/engineering-process.md)

本文规定 Aervox 文档如何分类、归档、标记事实源、维护状态、触发复核并由工具校验。目标是让文档数量可控、同一事实只有一个维护入口，并能在代码变化后尽早发现描述漂移。

本文是治理规则的唯一事实源；`docs/README.md`、`docs/DOC_REGISTRY.md`、ADR 索引和其它速览表是导航或派生视图，不得在其中重新定义规则。

## 1. 当前基线与主要问题

截至 2026-08-28，治理改造前的仓库基线为 64 份 Markdown 文档和 3 份 Mermaid 图，其中 45 份 Markdown 位于 `docs/reference/`；本分支新增治理规范与 CR 后为 66 份 Markdown。篇幅最长的 10 份文档约占基线正文的一半以上。目录数量本身不是阻断项，真正的维护风险来自以下四类不一致：

| 风险 | 当前表现 | 造成的后果 |
|---|---|---|
| 元数据格式不统一 | 部分文档使用 blockquote 字段，部分 ADR/CR 使用 bullet 字段，部分字段缺失 | 无法可靠生成索引、状态统计和过期提醒 |
| 状态语义混用 | `Review Candidate`、`Proposed`、`Implemented`、`More Evidence Required` 有时出现在同一份文档中 | 读者无法判断文档是否可用、决策是否批准、代码是否完成 |
| 事实源重复 | README、索引、登记表、CR 和专题文档重复描述同一规则 | 修改一处后其它位置容易过期 |
| 代码与文档异步 | 代码已经进入下一阶段，规范仍保留旧的“尚未实现”描述 | Agent 按旧文档修改错误层或重复实现 |

本分支只建立治理基线和校验入口，不在一次变更中搬迁全部文件。目录搬迁、历史文档整理和内容拆分按第 7 节分阶段执行。

## 2. 文档分类与目录职责

文档类型仍采用 Diátaxis 四分类；`proposals/` 和 `_meta/` 是生命周期或机器数据目录，不是新的第五类内容。

| 目录 | 类型 | 允许回答的问题 | 不应承载 |
|---|---|---|---|
| `docs/tutorials/` | Tutorial | 新成员如何从起点完成一条可验证路径 | 完整规范、长期状态清单 |
| `docs/how-to/` | How-to | 如何完成一个具体维护、开发或发布任务 | 产品决策和大段背景说明 |
| `docs/explanation/` | Explanation | 为什么这样设计、有哪些权衡、系统如何运作 | 可执行 API/数据库字段的第二份定义 |
| `docs/reference/` | Reference | 准确契约、状态、规则和清单是什么 | 面向新人的逐步教程 |
| `docs/reference/adr/` | Reference / ADR | 哪个不可逆技术决策被提出或接受 | 一般性操作步骤 |
| `docs/reference/changes/` | Reference / CR | 某次变更的差量、影响、迁移和回滚 | 复制整份目标规范 |
| `docs/templates/` | Template | 新文档应有的最小结构 | 真实项目结论 |
| `docs/_meta/` | Machine data | 校验器和生成器需要哪些机器配置 | 面向用户的叙述 |
| `docs/proposals/`（后续） | 暂存提案 | 尚未进入基线的方案是什么 | 已批准规则或实现承诺 |

目录规则：

1. `docs/` 根层只保留导航、登记和入口文件；新主题不得直接堆到根层。
2. 一个文件只选择一个主类型；若同时需要“为什么”和“怎么做”，拆成 Explanation + How-to，并互相链接。
3. ADR 和 CR 使用稳定编号；编号不因目录搬迁、合并或状态变化而复用。
4. 被替代的文档保留原路径或保留明确的迁移 stub，至少一个发布周期后才能物理删除。
5. 参考项目 `reference/` 是只读设计输入，不属于产品文档事实源；其子目录规则由各自的 `AGENTS.md` 管理。

## 3. 事实源矩阵

一条事实只能有一个编辑入口；其它文档只写摘要、链接和适用范围。

| 事实 | 唯一维护入口 | 允许的派生视图/引用 |
|---|---|---|
| 产品目标、用户场景、CAP、优先级和生命周期 | `docs/reference/PRD.md` | `README.md`、roadmap、索引摘要 |
| 可测试业务行为、FR/BR/AC | `docs/reference/SRS.md` | 需求追踪矩阵、教程中的步骤说明 |
| 需求状态、DoR/DoD、测试证据、代码落地状态 | `docs/reference/REQUIREMENTS_TRACEABILITY.md` | `docs/README.md`、PR 描述、发布说明 |
| 当前系统边界、部署和模块所有权 | `docs/reference/ARCHITECTURE.md` | 数据流说明、README 架构速览 |
| 不可逆技术决策 | 对应 `docs/reference/adr/ADR-*.md` | `docs/reference/adr/README.md`、架构摘要 |
| API、SSE 和事件契约 | `packages/contracts/` 及其生成物；行为补充见 `STREAMING_PROTOCOL.md` | API 客户端、教程、测试 |
| 数据表、仓储 Port、迁移和删除传播 | `packages/database/` 及 `DATABASE.md` | ERD、数据流、CR 影响说明 |
| 模型质量、安全和评估门槛 | `AI_QUALITY_SAFETY.md`、`THREAT_MODEL.md`、`DATA_PRIVACY.md` 各自负责的章节 | SRS/架构中的边界摘要 |
| 变更差量、迁移和回滚 | 对应 `docs/reference/changes/CR-*.md` | PR、发布说明；不反向定义基线规则 |
| 文档路径、核验日期和陈旧信号 | `docs/DOC_REGISTRY.md` | 文档索引、健康报告 |
| 分类、字段、状态和校验规则 | 本文 + `docs/_meta/document-policy.json` | 校验脚本和模板 |

`docs/README.md` 只回答“去哪里找”；`DOC_REGISTRY.md` 只回答“何时核验、什么信号表示陈旧”；两者都不再承担完整规则正文。

## 4. 元数据和状态模型

### 4.1 新文档的规范字段

新建文档采用 YAML front matter。现有 blockquote/bullet 头在迁移期仍可读取，但不得为新文档继续增加第三种格式。

```yaml
id: AVX-HAR-001
type: reference
scope: baseline
owner: platform
doc_status: review-candidate
decision_status: proposed
delivery_status: planned
version: 0.2.0
updated_at: 2026-08-28
reviewed_at: 2026-08-28
review_interval_days: 90
review_triggers:
  - packages/agent-loop/**
  - apps/api/src/modules/conversation/**
sources:
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
```

最低必填字段：`id`、`type`、`scope`、`owner`、`doc_status`、`version`、`updated_at`、`reviewed_at`。标题以 front matter 后的首个 H1 为准；ADR 另填 `decision_status`；CR 另填 `decision_status` 与 `delivery_status`。没有适用状态时显式写 `not-applicable`，不留空。

### 4.2 三种状态必须分开

| 状态维度 | 允许值 | 回答的问题 |
|---|---|---|
| `doc_status` | `draft` / `review-candidate` / `approved` / `superseded` / `retired` | 这份文档能否作为相应类型的阅读材料 |
| `decision_status` | `proposed` / `accepted` / `rejected` / `deferred` / `more-evidence-required` | 这个决策或变更是否已批准 |
| `delivery_status` | `planned` / `implemented` / `verified` / `released` | 代码或能力交付到哪一步 |

需求矩阵的 `Mapped`、`Specified`、`Ready` 等是需求生命周期状态，只在追踪基线中使用，不替代上述三个文档状态。

规则：

- `doc_status=approved` 不自动代表 `delivery_status=released`。
- CR 的 `decision_status` 和 `delivery_status` 不得只写在正文中；必须各有一个机器字段。
- `superseded` 文档必须填写 `superseded_by`，并在旧文档顶部放迁移链接。
- “More Evidence Required”只能作为决策状态，不能同时当作文档类型状态。

## 5. 维护责任和更新触发器

每个基线文档指定一个 `owner`（团队角色而非临时个人）。作者可以变化，owner 不因一次提交而漂移。

| 变更信号 | 最少需要复核的文档 | 责任动作 |
|---|---|---|
| PRD/CAP/发布阶段变化 | PRD、SRS、追踪基线、roadmap | 建立或更新 CR，核对 CAP 状态和验收 |
| `apps/**/src/**` 领域行为变化 | 架构、SRS、相关 CR、追踪基线 | 说明文档是否仍反映当前行为；无影响也要在 PR 说明 |
| `packages/contracts/**` | 流式协议、SRS、API 教程、OpenAPI 产物 | 先改 schema，再生成产物和契约测试 |
| `packages/database/**` | DATABASE、数据隐私、ERD、相关 ADR/CR | 记录迁移、删除传播和回滚影响 |
| `packages/agent-loop/**` 或对话执行器 | Agent Harness Loop、流式协议、AIQ、安全、追踪基线 | 更新阶段、终止语义、证据和缺口 |
| `modules/**`、插件或技能运行时 | 能力组合、能力注册表、插件规范、迁移教程 | 更新来源、权限、生命周期和撤权边界 |
| Worker、部署、备份或恢复变化 | 架构、operations、威胁模型、数据隐私 | 更新 SLO、演练项和恢复证据 |

文档核验日期和代码提交日期是两个概念：`updated_at` 记录内容变更，`reviewed_at` 记录责任人确认内容仍与事实源一致。没有内容变化但完成核验时只更新 `reviewed_at`。

## 6. 索引、登记和生成视图

推荐的维护方向是“一个结构化目录，多个只读视图”：

```text
docs/_meta/document-policy.json       # 分类、状态、校验策略
docs/_meta/document-catalog.json      # 后续作为文档目录唯一输入
        │
        ├── docs/README.md             # 阅读导航
        ├── docs/DOC_REGISTRY.md       # 生命周期视图
        └── docs/reference/adr/README.md  # ADR 状态视图
```

在 `document-catalog.json` 落地前，`DOC_REGISTRY.md` 仍是人工维护的过渡事实源；任何生成器上线后必须先在 CI 中做双写比对，连续两个版本一致后再切换为单向生成。

索引的最小字段为：`id`、标题、路径、类型、owner、doc_status、reviewed_at、review_interval_days、review_triggers。正文摘要不进入目录数据，避免索引复制规范。

## 7. 分阶段迁移

### 阶段 A：不搬目录，先止血

- 新增文档必须有唯一 ID、owner、状态和核验日期；
- 修复失效本地链接和重复状态字段；
- 把“当前实现”和“目标形态”分成明确小节；
- 由 `mise tasks run docs-validate` 检查重复 ID、路径、链接和过渡期元数据；兼容期历史格式只报告迁移 warning，canonical 文档结构错误阻断。

### 阶段 B：统一元数据和状态

- 将 ADR/CR/核心 Reference 逐批转换为 front matter；
- 对 ADR 使用 `decision_status`，对 CR 使用 `decision_status` + `delivery_status`；
- 将 `DOC_REGISTRY.md` 与文档头的核验日期做机器比对；
- 清理 `README`、索引、CR 中重复的完整规则。

### 阶段 C：生成派生视图

- 建立 `document-catalog.json`；
- 自动生成 `docs/README.md` 的核心导航、`DOC_REGISTRY.md` 和 ADR/CR 索引；
- CI 阻止手工修改生成区，生成差异必须在同一提交中更新；
- 代码路径命中 review trigger 而文档未更新时，要求填写可审计的 `docs-impact: none`。

### 阶段 D：按触碰原则拆分和归档

- 优先拆分超过 500 行且同时承担两个以上职责的文档；
- 先拆 `DATABASE.md`、`PRD.md`、`REQUIREMENTS_TRACEABILITY.md` 的附录/清单，再移动路径；
- 旧文档保留迁移 stub 和 `superseded_by`，至少一个发布周期后再删除；
- 将长期未采用的探索方案移入 `docs/proposals/` 或标记 `retired`，不混入生产 Reference。

## 8. 文档健康指标

每周或每次 Release Candidate 生成一次报告，至少包含：

- 有效 ID 覆盖率和重复 ID 数量；
- 标准元数据覆盖率（新格式/过渡格式/缺失字段）；
- 失效链接和失效锚点数量；
- registry 与文档头日期不一致数量；
- 超过 `review_interval_days` 未核验的文档数；
- 代码触发后未复核的文档数；
- 同一主题出现多个“唯一事实源”声明的数量；
- `Approved` 但没有关联 ADR/CR/测试证据的文档数。

建议目标：重复 ID 为 0、失效本地链接为 0、核心 Reference 的标准元数据覆盖率达到 100%、过期未核验文档为 0。指标未达标时生成阻断项或风险项，不通过手工修改统计数字绕过门禁。

## 9. 本轮改造的验收边界

本轮分支完成以下治理基线即可合并：

1. 本文和 `document-policy.json` 成为文档治理规则的单一入口；
2. `docs/README.md`、`DOC_REGISTRY.md`、getting-started 和文档写作规范均链接到本文，而不是复制其完整规则；
3. `docs-validate` 能在无额外服务的情况下检查路径、ID、链接、登记关系和过渡期元数据；
4. Agent Loop、能力组合和近期代码实现的“当前/目标”状态不互相矛盾；
5. 现有目录结构不因本轮治理发生不可逆搬迁，后续迁移有明确阶段和回滚路径。

本规范不批准自动删除历史文档、不批准把 `reference/` 外部项目作为运行时依赖，也不把治理脚本本身视为产品能力。
