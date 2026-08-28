---
id: CR-018
type: reference
scope: change
owner: learning
doc_status: review-candidate
decision_status: proposed
delivery_status: implemented
version: 0.2.0
updated_at: 2026-08-28
reviewed_at: 2026-08-28
review_interval_days: 90
sources:
  - docs/reference/SRS.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-018 错题错因记录工作流

- 提出人：kikoyida · 2026-08-28
- 修改人：kikoyida · 2026-08-28

关联：[SRS](../SRS.md#fr-prc-001-练习判定与错题)、[需求追踪](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)、[CR-009](CR-009-mistake-book-dismissal.md)

## 变更原因

错题本当前只能展示题目、最近错误答案和处置状态。用户不能记录本次错误属于概念不清、计算失误、粗心、审题偏差或其他原因，也不能按错因回顾并选择重练范围。

## 目标行为

- 用户可以为自己的错题保存一个标准错因和可选补充说明；说明去除首尾空白后最长 500 个字符；
- 错因元数据以工作区、数据主体和题目为边界，读取和写入均不得跨租户；
- 错因可以在不改变 `active`、`mastered` 或 `dismissed` 处置状态的情况下单独更新；
- 错题列表返回错因并允许按错因筛选；筛选只影响展示与重练选择，不删除或改写 `QuestionAttempt`、判定、掌握度和复习项；
- 工作台提供错因选择、说明编辑、保存和筛选入口。

## 范围外

- 不自动推断错因，也不把模型推断写入学习事实；
- 不自动或手动合并不同题目。合并会改变错题计数和题目归属，必须在后续 CR 中定义 canonical 题目、可逆性、历史展示和重练语义；
- 不修改题目答案、作答记录、服务端判题、知识点掌握度或复习调度。

## 数据、契约与回滚

- 新增按 `(workspace_id, subject_user_id, question_id)` 唯一的错因记录，保存 `reasonCode` 与可选 `note`；
- `PATCH /v1/mistakes/{questionId}` 扩展为可同时更新处置状态、错因和说明；请求必须至少包含一个字段；
- `GET /v1/mistakes` 增加可选 `reasonCode` 查询参数，OpenAPI 与客户端 DTO 同步更新；
- 回滚时删除错因展示/编辑入口和新表；原始作答及既有错题处置不受影响。

## 验证与决策

- 验证：错因归一化单元测试；数据库/API 集成测试覆盖保存、清空说明、筛选、处置并存、跨租户隔离和学习事实不变；API Client/UI 类型检查与工作台冒烟；
- 决策：Review Candidate。实现已完成；以单元测试、API 集成测试、OpenAPI 契约测试与 API Client/UI 类型检查作为 `CAP-004` 后续 Ready 评审输入。
