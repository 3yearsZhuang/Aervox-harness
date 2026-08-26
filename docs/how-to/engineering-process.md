# 操作指南：工程与发布流程（How-to）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-26

> 文档编号：AVX-GUIDE-001（合并 AVX-GUIDE-001/003/004）  
> 版本：v0.1  
> 更新日期：2026-08-26  
> 状态：Draft  
> 关联：[需求追踪与交付基线](../reference/REQUIREMENTS_TRACEABILITY.md) · [运行、值班与演练手册](../reference/operations.md) · [文档写作规范](../reference/standards/doc-standards.md)

本指南合并《新增与修改需求》《过发布门禁 G0~G6》《执行季度恢复演练》三份操作指南：§1 回答如何把 CAP 拆成可开发的原子需求并过 DoR；§2 回答每个版本/能力如何按 G0~G6 推进到发布；§3 回答如何按季度执行恢复演练并留证。规则与字段以[追踪基线](../reference/REQUIREMENTS_TRACEABILITY.md)为准。

## 1. 新增与修改需求

### 1.1 适用场景

- 为 `Mapped` 的 CAP（如 `CAP-001/007/010~032`）补齐详细行为；
- 为既有能力新增、修改或废弃需求。

### 1.2 步骤

1. **定位能力**：确认 `CAP-*` 与所属领域代码（`LRN/PRC/REV/MEM/DIA/CONV/DESK/PLG/EXT/...`），标题变化不改 ID。
2. **写需求**：按[原子需求字段模板](../reference/REQUIREMENTS_TRACEABILITY.md#5-原子需求字段模板)逐字段填写，无影响的字段写“不适用”，不得留空。
   - 需求陈述用“当……时，系统必须……”；区分 `必须/应当/可以`；
   - 异常覆盖：正常、空态、失败、取消、重试、撤销、并发、删除。
3. **写验收**：每个 `AC-*` 用 Given/When/Then 原子化，可由非作者独立判定；正常/边界/失败各至少一条。
4. **关联测试与证据**：`AC-*` → `TC-*` → CI/人工证据；AI 需求挂版本化评估集。
5. **过 DoR**：逐项核对[Definition of Ready](../reference/REQUIREMENTS_TRACEABILITY.md#6-definition-of-ready)，阻塞型 `EXP/RISK/DEC/ADR` 需关闭或获批准豁免。
6. **登记状态**：在追踪矩阵把需求从 `Specified` 推进到 `Ready`，并更新[文档生命周期登记表](../README.md#11-文档生命周期登记表核验节奏与陈旧信号)的核验日期。

### 1.3 变更既有需求

- 基线前：直接更新属性，状态回退到 `Specified`。
- 基线后（已批准/已发布）：创建 `CR-*`，按[变更流程](../reference/REQUIREMENTS_TRACEABILITY.md#113-变更流程)审批后同步修订。
- 拆分/合并：原 ID 标 `Deprecated` / `supersededBy`，不删除行。

### 1.4 门禁提醒

- `Mapped` 不代表可开发；未过 DoR 不得标 `Ready`。
- `Verified/Released` 必须有测试证据与发布记录，不能只改状态。

## 2. 过发布门禁 G0~G6

门禁定义与证据要求以[追踪基线 §9](../reference/REQUIREMENTS_TRACEABILITY.md#9-发布门禁)为准。

### 2.1 门禁速查

| Gate | 触发时点 | 关键退出条件 |
|---|---|---|
| `G0` | 范围立项 | 用户问题、目标指标、CAP、范围外、风险假设明确 |
| `G1` | 需求基线 | 版本内需求全部 `Ready`，追踪完整，无未处理阻塞决策 |
| `G2` | 架构与数据 | 架构、威胁模型、数据生命周期、迁移、成本与回滚评审通过 |
| `G3` | 构建完成 | 代码、迁移、静态检查与规定自动化测试通过 |
| `G4` | Release Candidate | 产品验收、AI 评估、安全、隐私、性能、无障碍、恢复测试通过 |
| `G5` | 生产发布 | 监控告警、灰度、值班、回滚、备份恢复与支持方案就绪 |
| `G6` | 发布后验证 | 关键路径、数据写入、指标、告警与错误预算正常 |

### 2.2 推进步骤

1. **确认当前 Gate** 及其强制退出条件（见[追踪基线 §9](../reference/REQUIREMENTS_TRACEABILITY.md#9-发布门禁)）。
2. **准备最低证据**：CI/覆盖报告、验收报告、评估报告、威胁模型、运行维护手册、回滚演练等，证据需含构建号/版本/环境/执行时间/执行人。
3. **对照阻断项**：任一[发布阻断项](../reference/REQUIREMENTS_TRACEABILITY.md#9-发布门禁)存在时不得放行，不得以“已知问题”通过。
4. **G5 前置**：完成[季度演练](../reference/operations.md#10-演练与证据)并回填[演练证据模板](../reference/operations.md#12-季度恢复演练证据模板)，无演练证据不能过 G5。
5. **记录结果**：在每个 Gate 更新追踪矩阵状态与证据链接。

### 2.3 回滚与灰度

- 应用回滚不能回滚数据库到丢失新数据，使用 expand/contract 与兼容开关（见[运行手册 §9](../reference/operations.md#9-发布与回滚)）；
- 灰度分级与逐级检查项见[运行手册 §9](../reference/operations.md#9-发布与回滚)。

## 3. 执行季度恢复演练

演练范围与要求以[运行手册 §10](../reference/operations.md#10-演练与证据)为准，记录用[演练证据模板](../reference/operations.md#12-季度恢复演练证据模板)。

### 3.1 演练范围（每季度）

- SQLite/Litestream 备份恢复与完整性校验；
- `RecoveryControlLedger` 不可用/缺口/重复/乱序及 reconciler 重放；
- Redis 丢失后 Outbox/ScheduledJob 重建；
- S3/对象恢复与 checksum 校验；
- 模型供应商中断与备用切换；
- 删除传播与零召回验证；
- 插件/外部集成 kill switch；
- 日记跨 DST 与多日停机补跑。

### 3.2 步骤

1. **声明演练**：在[演练证据模板](../reference/operations.md#12-季度恢复演练证据模板)登记日期、环境、版本、演练项与目标（RPO/RTO）。
2. **通知值班**：按[值班与升级联系矩阵](../reference/operations.md#11-值班与升级联系矩阵)确认演练联系与审批。
3. **执行并记录**：逐项执行，记录账本水位、fail-closed 结果、偏差与耗时。
4. **留证回填**：完成每个演练项的证据（结果、偏差、改进项）。
5. **复盘**：偏差项建立跟进（CR/RISK），确认下季度前关闭。

### 3.3 门禁提醒

- 无演练证据不能通过 G5（见[运行手册 §10](../reference/operations.md#10-演练与证据)）；
- 恢复演练必须验证删除/撤权数据在 PITR 后不复活（fail closed 优先）。
