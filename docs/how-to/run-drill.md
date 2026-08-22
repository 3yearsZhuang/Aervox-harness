# 操作指南：执行季度恢复演练（How-to）

> 文档编号：AVX-GUIDE-004  
> 版本：v0.1  
> 更新日期：2026-08-24  
> 状态：Draft  
> 关联：[运行与恢复手册](../operations/RUNBOOK.md) · [演练证据模板](../operations/DRILL_TEMPLATE.md) · [值班与升级联系矩阵](../operations/ONCALL.md)

本指南回答“如何按季度执行恢复演练并留证”。演练范围与要求以[运行手册 §10](../operations/RUNBOOK.md#10-演练与证据)为准，记录用[演练证据模板](../operations/DRILL_TEMPLATE.md)。

## 演练范围（每季度）

- PostgreSQL PITR 与完整性校验；
- `RecoveryControlLedger` 不可用/缺口/重复/乱序及 reconciler 重放；
- Redis 丢失后 Outbox/ScheduledJob 重建；
- S3/对象恢复与 checksum 校验；
- 模型供应商中断与备用切换；
- 删除传播与零召回验证；
- 插件/外部集成 kill switch；
- 日记跨 DST 与多日停机补跑。

## 步骤

1. **声明演练**：在[演练证据模板](../operations/DRILL_TEMPLATE.md)登记日期、环境、版本、演练项与目标（RPO/RTO）。
2. **通知值班**：按[值班与升级联系矩阵](../operations/ONCALL.md)确认演练期间联系人与审批。
3. **执行并记录**：逐项执行，记录账本水位、fail-closed 结果、偏差与耗时。
4. **留证回填**：完成每个演练项的证据（结果、偏差、Owner、改进项）。
5. **复盘**：偏差项建立跟进（CR/RISK），确认下季度前关闭。

## 门禁提醒

- 无演练证据不能通过 G5（见[运行手册 §10](../operations/RUNBOOK.md#10-演练与证据)）；
- 恢复演练必须验证删除/撤权数据在 PITR 后不复活（fail closed 优先）。
