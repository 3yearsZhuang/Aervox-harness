---
id: CR-043
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: planned
version: 0.1.0
updated_at: 2026-09-14
reviewed_at: 2026-09-14
review_interval_days: 90
sources:
  - docs/reference/changes/CR-034-local-model-fallback-ladder.md
  - docs/reference/changes/CR-042-local-model-routing-and-fallback.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
---

# CR-043 本地模型能力分级与服务端工具收紧

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

- 状态：Accepted / Planned
- 关联能力：`CAP-020/013/019`

## 1. 变更与边界

本 CR 为 CR-034 的 N2a 切片，针对本地端点（L1）多步 Tool Calling 可靠性弱的现状，确立能力分级模型与安全收紧规则：

1. **能力等级划分**：`full`（L0 全能力）→ `restricted`（L1 收紧工具白名单、生成预算下调、教学模式入口建议云端）→ `minimal`（L2 零模型、规则回应）；
2. **服务端工具过滤**：在 Agent Loop 装配层依据生效 `CapabilityTier` 过滤高危写操作与敏感系统工具，仅开放只读工具；
3. **插件能力声明兼容**：插件 Manifest 增加 `tier_compatibility` 声明，拒绝低能力模型挂载高危操作工具。

## 2. 验收与回滚

- **Feature Flag 隔离**：由独立环境变量 `AERVOX_CAPABILITY_TIERING` 门控；
- **负向工具矩阵**：在 L1 下验证写工具与敏感工具一律 fail-closed；
- **回滚语义**：关闭开关即退回 L0 旧工具策略。
