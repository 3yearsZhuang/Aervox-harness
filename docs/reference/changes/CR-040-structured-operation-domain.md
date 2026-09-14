---
id: CR-040
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: proposed
delivery_status: planned
version: 0.1.0
updated_at: 2026-09-14
reviewed_at: 2026-09-14
review_interval_days: 90
sources:
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
  - docs/reference/changes/CR-022-full-access-tool-permission.md
---

# CR-040 结构化操作域与工具白名单

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

- 状态：Proposed / Planned
- 关联能力：`CAP-002/020/033`

## 提案范围

建立独立的结构化操作目录，只允许显式白名单内、存在受管 handler、输入 Schema 已验证的本地工具进入。`read_only` 不视为主动操作；`write_with_approval` 必须逐次确认；`privileged` 与不可逆操作默认排除，需单独安全评审。

本 CR 不批准像素级自主操作、不批准任意系统脚本、不批准插件绕过工具注册表。批准前必须完成威胁建模、注入防御评审、平台原语清单、授权撤销传播和审计保留方案。

回滚总开关为 `operation_catalog`；关闭后目录为空，既有工具仍仅可通过原有被动调用路径使用。
