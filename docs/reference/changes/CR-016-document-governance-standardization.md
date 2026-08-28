---
id: CR-016
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: proposed
delivery_status: implemented
version: 0.1.0
updated_at: 2026-08-28
reviewed_at: 2026-08-28
review_interval_days: 90
review_triggers:
  - docs/**
  - scripts/docs-governance.mjs
  - mise.toml
  - .github/workflows/docs.yml
sources:
  - docs/reference/document-governance.md
  - docs/reference/standards/doc-standards.md
---

# CR-016 文档治理与事实源标准化

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

关联：[文档治理规范](../document-governance.md)、[文档写作规范](../standards/doc-standards.md)、[生命周期登记表](../../DOC_REGISTRY.md)、[文档索引](../../README.md)

## 变更原因

当前文档体系已经采用 Diátaxis，但存在元数据格式不统一、同一 CR 内多种状态混写、索引/登记/正文重复维护、代码实现先于规范更新等问题。Markdown lint 和 Vale 可以检查格式与术语，却不能发现重复 ID、失效本地锚点、登记日期漂移或“当前实现/目标设计”冲突。

本 CR 建立一套兼容现有文档的治理基线：先引入事实源矩阵、状态分层、机器策略和校验任务，再按触碰原则逐批迁移历史文档，不以一次大规模目录搬迁制造新的断链。

## 目标行为

- 新增 [AVX-DOC-GOV-001](../document-governance.md)，统一分类、事实源、元数据、状态、owner、复核触发器和迁移阶段；
- 新增 `docs/_meta/document-policy.json`，把目录类型、允许状态、事实源边界和复核触发器提供给机器读取；
- 新增 `scripts/docs-governance.mjs` 和 `mise tasks run docs-validate`，检查唯一 ID、签名、本地链接/锚点、registry 路径/日期及策略文件；
- `ci-docs` 同时运行 Markdown、Vale 和治理校验；
- 修复本轮已经确认的失效锚点、registry 日期差异、CR 状态混用和 Agent Loop 现状漂移；
- `docs/README.md`、`DOC_REGISTRY.md` 与 getting-started 只保留导航/登记责任，治理规则链接到 AVX-DOC-GOV-001。

## 范围外

- 本 CR 不立即移动 PRD、DATABASE、SRS、ADR 或 CR 的物理路径；
- 不一次性把所有历史文档转换为 YAML front matter；
- 不自动删除 Superseded/Retired 文档；
- 不把生成目录或校验脚本作为业务产品能力；
- 不修改 Agent Loop、数据库或客户端运行时代码。

## 兼容与迁移

校验器默认处于兼容模式，继续识别现有 blockquote 元数据、ADR/CR bullet 状态和按文件名派生的 `ADR-###`/`CR-###`。设置 `DOCS_GOVERNANCE_STRICT=1` 后，新格式缺失会作为错误；严格模式在核心 Reference 完成迁移后再成为 CI 默认。

目录迁移遵循“先生成目录、再双写比对、最后切换”的顺序。任何文件移动必须保留迁移链接并由本地锚点检查通过，不在本 CR 中批量执行。

## 验证与回滚

- 验证：`mise tasks run ci-docs`、`mise tasks run docs-validate`、治理脚本自检和 `git diff --check`；
- 回滚：移除治理脚本、机器策略和 AVX-DOC-GOV-001，并恢复 `ci-docs` 原命令；正文修正可以独立保留；
- 数据影响：无数据库、API、用户数据或运行时迁移；
- 安全影响：减少旧文档误导 Agent 的风险，不扩大任何权限或外部运行时边界。
