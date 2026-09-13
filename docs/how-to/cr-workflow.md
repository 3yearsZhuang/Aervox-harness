---
id: AVX-GUIDE-005
type: how-to
scope: guide
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.0.0
updated_at: 2026-09-13
reviewed_at: 2026-09-13
review_interval_days: 90
review_triggers:
  - docs/reference/changes/**
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
sources:
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/reference/document-governance.md
  - docs/reference/standards/doc-standards.md
---

# 操作指南：提出、撰写与闭环变更请求（CR）

- 提出人：3yearszhuang · 2026-09-13
- 修改人：3yearszhuang · 2026-09-13

关联：[需求追踪与交付基线](../reference/REQUIREMENTS_TRACEABILITY.md#11-变更控制) · [文档治理规范](../reference/document-governance.md) · [文档写作规范](../reference/standards/doc-standards.md) · [CR 索引表](../README.md#变更请求速览)

本指南指导开发者和 AI Agent 如何为 Aervox 提出、撰写、实施并闭环一个变更请求（Change Request，简称 CR）。变更控制的判定规则与事实源以[需求追踪基线 §11](../reference/REQUIREMENTS_TRACEABILITY.md#11-变更控制)为准，本页聚焦操作步骤。

## 目标与前置条件

- **适用场景**：涉及已批准需求调整、架构假设修正、破坏性数据迁移、端形态演进或外部生态连接变更；
- **环境要求**：Node.js 24 + pnpm 11 + Vale 3.18.0（统一通过 `mise` 管理）；
- **核心铁律**：一切落地改动走功能分支 + PR 合入，禁止直接向 `main` 推送；变更实施后必须在[落地追踪基线 §4.2](../reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)登记。

## 步骤

### 第一步：判断变更等级与立项

根据改动性质确定是否需要建立 CR（见追踪基线 §11.2）：

| 变更类型 | 范围示例 | 是否需要 CR | 决策审批人 |
|---|---|---|---|
| **重大变更（Major）** | 修改 CAP 优先级、增删核心实体、破坏性数据库迁移、流式契约变更 | **必须建 CR** | 产品 + 架构 Maintainers |
| **功能扩展（Minor）** | 新增可选能力、增加端点/工具、界面预设设置项 | **必须建 CR** | 领域模块负责角色 |
| **缺陷修复（Patch）** | 代码 Bug、文档错别字、单测补全 | 不需要 CR | 提交 PR 走标准 Review |

确认需要提 CR 后，查询 `docs/reference/changes/` 获取下一个未使用的稳定编号（例如 `CR-032`）。编号一经分配不得因废弃或合并而复用。

### 第二步：创建 CR 变更文件

在 `docs/reference/changes/` 目录下创建文件，文件名严格遵守命名规范 `CR-###-kebab-case.md`：

```bash
touch docs/reference/changes/CR-032-example-feature.md
```

在文件头部写入标准 YAML Front Matter 与点阵签名：

```markdown
---
id: CR-032
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: proposed
delivery_status: planned
version: 0.1.0
updated_at: 2026-09-13
reviewed_at: 2026-09-13
review_interval_days: 90
sources:
  - docs/reference/PRD.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-032 <清晰动宾短语标题>

- 提出人：<账号> · 2026-09-13
- 修改人：<账号> · 2026-09-13

关联：[PRD](../PRD.md) · [需求追踪基线](../REQUIREMENTS_TRACEABILITY.md)

- 状态：Proposed / Planned
- 提出人 / 日期：<姓名或账号> / 2026-09-13
- 目标版本：<如 R1 MVP / R2 学习深化>
- 关联能力：`CAP-###`
```

### 第三步：编写变更差量与影响分析

CR 正文需回答以下 5 个核心问题（可参考 [CR-030](../reference/changes/CR-030-pure-local-sqlite-database.md) 或 [CR-031](../reference/changes/CR-031-turn-stream-pubsub-optimization.md)）：

1. **变更原因与证据**：为什么现有基线无法满足需求？有哪些性能指标、用户反馈或设计假设被证伪？
2. **当前行为 vs 目标行为**：明确修改前的运行逻辑与修改后的预期逻辑，禁止模棱两可；
3. **受影响范围与契约**：列出受波及的 Package/App（如 `@aervox/contracts`、`@aervox/schema`、`apps/api`）、OpenAPI 端点与数据表；
4. **验证与测试标准**：如何证明变更已正确落地？提供具体命令与验收测试套件；
5. **回滚条件与应急方案**：若变更上线后引发异常，如何停用、降级或回滚（如 Feature Flag、换库脚本、版本恢复）。

### 第四步：同步生命周期登记表与索引

CR 文件创建后属于 L3 结构性改动，需执行以下同步：

1. **同步 `docs/DOC_REGISTRY.md`**：追加一行登记记录；
2. **同步 `docs/README.md`**：在「变更请求速览」表格中追加对应行；
3. **自动对齐核验日期**：

   ```bash
   mise tasks run docs-sync
   ```

### 第五步：代码实现与落地登记（闭环）

代码编写与单测完成后，执行最终的闭环步骤：

1. **更新 CR 状态**：
   - 将 Front Matter 的 `decision_status` 改为 `accepted`，`delivery_status` 改为 `implemented`；
   - 更新点阵签名日期与正文 `- 状态：Accepted / Implemented`；
2. **回填落地登记表**：
   - 打开 `docs/reference/REQUIREMENTS_TRACEABILITY.md`；
   - 在 **§4.2 落地实现登记** 表格中追加落地行（登记关联 CAP、实现文件路径、完成日期、验证命令及参考来源）；
3. **更新需求矩阵**（若适用）：若推进了对应 CAP 的生命周期，更新 §4 矩阵状态。

## 验证与门禁

提交 PR 前必须在本地通过双门禁自检：

```bash
# 1. 运行文档与治理门禁（Markdownlint + Vale + docs-validate --strict）
mise tasks run ci-docs

# 2. 运行代码与单测门禁（build + boundary + typecheck + test）
mise tasks run ci-code
```

门禁要求：

- `docs-validate` 检查 `0 duplicate_ids, 0 missing_links, 0 broken_anchors, 0 registry_date_mismatches`；
- Vale 散文与术语检查 `0 errors`。

## 常见问题与陷阱

1. **正文状态与 Front Matter 冲突**：Front Matter 已变更为 `accepted`，但正文遗留 `- 状态：Proposed`。请确保两处同步更新。
2. **忘记在 §4.2 登记**：这是仓库最严硬约束，未登记视为未闭环、PR 会被直接打回。
3. **在 CR 正文中大段复制基线规则**：CR 是**差量单**，只写“变了什么与如何迁移”，不要复制整份 PRD 或架构设计。
4. **静默变更**：禁止在代码中偷偷修改业务规则而不立项 CR。
