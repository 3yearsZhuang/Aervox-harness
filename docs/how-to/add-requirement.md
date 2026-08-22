# 操作指南：新增与修改需求（How-to）

> 文档编号：AVX-GUIDE-001  
> 版本：v0.1  
> 更新日期：2026-08-24  
> 状态：Draft  
> 关联：[需求追踪与交付基线](../REQUIREMENTS_TRACEABILITY.md)

本指南回答“如何把一个 CAP 能力拆成可开发的原子需求，并通过 DoR 进入 Ready”。所有规则与字段以[追踪基线](../REQUIREMENTS_TRACEABILITY.md)为准，本文件只给操作步骤。

## 适用场景

- 为 `Mapped` 的 CAP（如 `CAP-001/007/010~032`）补齐详细行为；
- 为既有能力新增、修改或废弃需求。

## 步骤

1. **定位能力**：确认 `CAP-*` 与所属领域代码（`LRN/PRC/REV/MEM/DIA/CONV/DESK/PLG/EXT/...`），标题变化不改 ID。
2. **写需求**：按[原子需求字段模板](../REQUIREMENTS_TRACEABILITY.md#5-原子需求字段模板)逐字段填写，无影响的字段写“不适用”，不得留空。
   - 需求陈述用“当……时，系统必须……”；区分 `必须/应当/可以`；
   - 异常覆盖：正常、空态、失败、取消、重试、撤销、并发、删除。
3. **写验收**：每个 `AC-*` 用 Given/When/Then 原子化，可由非作者独立判定；正常/边界/失败各至少一条。
4. **关联测试与证据**：`AC-*` → `TC-*` → CI/人工证据；AI 需求挂版本化评估集。
5. **过 DoR**：逐项核对[Definition of Ready](../REQUIREMENTS_TRACEABILITY.md#6-definition-of-ready)，阻塞型 `EXP/RISK/DEC/ADR` 需关闭或获批准豁免。
6. **登记状态**：在追踪矩阵把需求从 `Specified` 推进到 `Ready`，并更新[文档生命周期登记表](../README.md#11-文档生命周期登记表owner-指派与核验)的核验日期。

## 变更既有需求

- 基线前：直接更新属性，状态回退到 `Specified`。
- 基线后（已批准/已发布）：创建 `CR-*`，按[变更流程](../REQUIREMENTS_TRACEABILITY.md#113-变更流程)审批后同步修订。
- 拆分/合并：原 ID 标 `Deprecated` / `supersededBy`，不删除行。

## 门禁提醒

- `Mapped` 不代表可开发；未过 DoR 不得标 `Ready`。
- `Verified/Released` 必须有测试证据与发布记录，不能只改状态。
