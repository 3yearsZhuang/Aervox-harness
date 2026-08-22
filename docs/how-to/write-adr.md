# 操作指南：撰写与批准 ADR（How-to）

> 文档编号：AVX-GUIDE-002  
> 版本：v0.1  
> 更新日期：2026-08-24  
> 状态：Draft  
> 关联：[ADR 索引](../architecture/adr/README.md)

本指南回答“何时写 ADR、怎么写、如何推进到 Accepted”。模板与状态规则以[ADR 索引](../architecture/adr/README.md)为准。

## 何时写 ADR

- 决策难以逆转、影响多个模块，或改变数据/运维边界（见[架构基线 §11](../ARCHITECTURE.md#11-首批-adr)）；
- 与现有 ADR 冲突、替代或扩展时；
- 不确定是否该写：先按“是否不可逆/跨模块/改变边界”判断，拿不准时按 ADR 处理。

## 写作步骤

1. **取号**：在 [ADR 索引](../architecture/adr/README.md) 登记下一个 `ADR-###`，编号一经分配不复用。
2. **按 8 节模板写**：
   - `Context`：背景与问题；
   - `Decision drivers`：促成决策的 2~4 条驱动因素；
   - `Considered options`：编号 + 取舍理由，标注选定项；
   - `Decision`：明确决策与边界；
   - `Positive consequences` / `Negative consequences and risks`；
   - `Migration / rollback`：如何落地与回退；
   - `Verification evidence`：状态改为 `Accepted` 前至少提供的证据。
3. **关联 ID**：挂 `CAP/NFR/DATA/SEC/PRIV/RISK/CR`，标题变化不改 ADR 编号。
4. **提交评审**：以 `Proposed` 提交，记录 Owner（当前人名待定）与评审人。

## 状态推进

- `Proposed` → `Accepted`：补齐 Owner、评审人、备选方案、后果、迁移/回滚与验证证据，并通过 G2 评审。
- `Accepted` → `Superseded` / `Rejected`：保留原文并标记，不得复用编号。
- 未批准的技术建议不得写成已承诺架构（与[架构 §11](../ARCHITECTURE.md#11-首批-adr)一致）。

## 门禁提醒

- 决策接受或通过对应 `CR-*` 后，同步[架构基线摘要表](../ARCHITECTURE.md#11-首批-adr)，不能只改独立记录。
