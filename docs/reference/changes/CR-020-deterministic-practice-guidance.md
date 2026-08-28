---
id: CR-020
type: reference
scope: change
owner: learning
doc_status: review-candidate
decision_status: implemented
delivery_status: delivered
version: 0.1.0
updated_at: 2026-08-28
reviewed_at: 2026-08-28
review_interval_days: 90
sources:
  - docs/reference/PRD.md
  - docs/reference/SRS.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-020 确定性练习反馈与下一轮建议

- 提出人：kikoyida · 2026-08-28
- 修改人：kikoyida · 2026-08-28

关联：[PRD](../PRD.md#prd-cap-014-019)、[需求追踪](../REQUIREMENTS_TRACEABILITY.md#4-cap-001cap-032-覆盖矩阵)、[CR-008](CR-008-practice-session-contract.md)

## 变更原因

现有练习报告只汇总判题结果并给出复习状态。它没有记录用户主动提供的答题用时和提示使用次数，也没有把可观察数据转换为可解释的下一轮练习建议，无法满足 CAP-016 的自适应刷题反馈。

## 目标行为

- 作答可选提交 `elapsedSeconds` 与 `hintsUsed`；缺失时保持未知，不把未知值伪装为零；
- 会话报告分别返回观测值（正确、错误、待确认、平均用时、提示次数）与确定性建议；
- 建议仅基于本次会话已判定作答、平均用时和提示次数：冷启动或待确认优先保持；正确率低于 50% 建议降低难度；正确率至少 80%、无提示且平均用时不超过 60 秒建议提高难度；其余保持当前难度；
- 每个建议返回稳定的原因码和用户可读说明。模型不可参与判定、统计或建议生成；
- 同一会话重复读取或重复结束必须得到相同报告，不新增学习事实或复习项；跨租户读取仍返回 404。

## 范围外

- 不自动生成题目、不改变题目难度字段、不重写历史作答；
- 不把该规则视为长期掌握度算法，阈值升级、冷启动策略和偏差校准另行评审；
- 不新增模型调用或模型失败恢复链路。

## 契约、数据与回滚

- `POST /v1/questions/{questionId}/attempts` 扩展可选的用时和提示数；二者必须为非负整数；
- `GET /v1/practice/sessions/{sessionId}/report` 与结束端点扩展报告观测值和 `guidance`；OpenAPI、API Client 与工作台同步更新；
- 回滚时停止写入和展示这两个可选观测字段及 `guidance`；既有作答、会话、错题和复习项保持可读。

## 验证与决策

- 验证：建议规则单元测试（边界/零作答/精确阈值/未知数据 7+ 用例）；API 集成测试覆盖输入校验、低正确率降低难度、高正确率快速无提示提高难度、稳定表现保持、用时未知不升级、幂等重试保留首值、重复结束一致性、租户隔离；OpenAPI 契约自动同步；API Client 与 UI 类型检查；工作台报告展示 guidance 与平均用时。
- 决策：Review Candidate。实现完成后将作为 CAP-016 从 `Mapped` 进入 `Specified` 的评审输入。
