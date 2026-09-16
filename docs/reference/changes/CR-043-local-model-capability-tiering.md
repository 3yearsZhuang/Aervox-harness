---
id: CR-043
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: verified
version: 1.0.0
updated_at: 2026-09-16
reviewed_at: 2026-09-16
review_interval_days: 90
sources:
  - docs/reference/changes/CR-034-local-model-fallback-ladder.md
  - docs/reference/changes/CR-042-local-model-routing-and-fallback.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
---

# CR-043 本地模型能力分级与服务端工具收紧

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-16

- 状态：Accepted / Verified
- 关联能力：`CAP-020/013/019`

## 1. 变更与边界

本 CR 为 CR-034 的 N2a 切片，针对本地端点（L1）多步 Tool Calling 可靠性弱的现状，确立能力分级模型与安全收紧规则：

1. **能力等级划分**：`full`（L0 全能力）→ `restricted`（L1 收紧工具白名单、生成预算下调至 2048、写操作 fail-closed 拦截）→ `minimal`（L2 零模型、确定性规则回应）；
2. **服务端工具过滤与执行防御**：在 Agent Loop 装配层依据生效 `CapabilityTier` 过滤高危写操作与敏感系统工具，模型清单仅开放只读工具（`readOnly: true`）；即便模型伪造调用写工具，在 `createRuntimeToolProvider` 侧统一拦截并安全阻断返回 `tool_restricted_in_tier_l1`；
3. **上下文生成预算下调**：进入 L1 限制层时自动将 `maxTokens` 严格收敛至最高 2048，保护本地轻量小模型推理稳定性；
4. **统一特性开关**：受 `capability_tiering` 特性开关受控管控，默认开启。

## 2. 落地实现与验证

- **契约与模型层**：`packages/contracts/src/model-routing-schemas.ts`（`capabilityTierSchema`）、`packages/config/src/index.ts`（`capability_tiering` 特性开关）；
- **服务端收紧与装配**：`apps/api/src/modules/companion/conversation/agent-executor.ts`（`createRuntimeToolProvider` 与 L1 动态工具过滤器包装）；
- **自动化测试验证**：`apps/api/test/capability-tiering.test.ts` 3/3 单测全部通过，验证只读工具放行与写工具 fail-closed 阻断。
