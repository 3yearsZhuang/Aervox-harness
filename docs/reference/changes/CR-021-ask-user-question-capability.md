---
id: CR-021
type: reference
scope: change
owner: architecture
doc_status: review-candidate
decision_status: proposed
delivery_status: implemented
version: 0.1.0
updated_at: 2026-08-28
reviewed_at: 2026-08-28
review_interval_days: 90
sources:
  - docs/reference/agent-harness-loop.md
  - docs/reference/STREAMING_PROTOCOL.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-021 向用户询问（ask_user_question）能力接入

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

关联：[Agent Harness Loop](../agent-harness-loop.md)、[流式协议](../STREAMING_PROTOCOL.md)、[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)

## 变更原因

在模型推理与智能体执行过程中，遇到需要用户确认、关键分支选择、缺失信息补充或计划评审（Plan Review）的场景时，此前缺乏标准化的人机交互回环机制。模型只能单向输出最终文本或失败退出。借鉴 `reference/deepseek-harness` 的 `dsh-tool-ask-user` 与 `dsh-user-questions` 架构，为 Aervox 构建从模型侧工具、Loop 调度挂起、API 协调队列到双形态前端呈现（工作台卡片 + 桌宠/VN 选择肢）的完整提问交互能力。

## 目标行为

- **模型工具契约**：在 `@aervox/agent-loop` 中内建 `ask_user_question` 只读工具，接受 `questions: [{ id, question, header, detail, options, multiSelect, intent }]` 参数；
- **Loop 执行与挂起**：Executor 识别提问请求，通过 `UserQuestionPort` 挂起当前 Step 等待用户交互，并配置 120s 交互防死锁超时；
- **子 Agent 隔离原则**：被委托的 Subagent 角色禁止直接向用户提问（拒绝并报错 `DELEGATED_CALLER`），保证提问统一收敛到主 Agent；
- **流式协议与持久化**：下发 `user_question_required` 流事件，作答后记录 `user_question_answered` 事件；
- **API 协调与回答接收**：`POST /v1/turns/:turnId/questions/answers` 校验并唤醒挂起的 Loop Step，`GET /v1/turns/:turnId/questions/pending` 提供待作答状态查询；
- **双形态前端交互**：
  - 工作台：渲染 `UserQuestionComposer` 交互卡片，支持多选、单选与自定义补充输入；
  - 桌宠/VN：在独立桌宠气泡中呈现选项胶囊分支，联动 Live2D 动作，点击一键作答。

## 范围外

- 不自动伪造用户偏好；用户未作答且无推荐选项时严格超时报错；
- 不允许 Subagent 直接向用户界面派发交互事件。

## 数据、契约与回滚

- 契约扩展：在 `@aervox/contracts` 中定义 `askUserQuestionItemSchema`、`userQuestionRequiredEventDataSchema`、`submitQuestionAnswersRequestSchema` 等；
- 回滚策略：若需禁用，只需在组合根中不注入 `UserQuestionCoordinator`，模型请求将 fail-closed 拦截，现有会话数据与核心流程不受影响。

## 验证与决策

- 验证：`@aervox/contracts` OpenAPI 重新生成与校验；`@aervox/agent-loop` 单元测试（4 个针对提问、超时、意图防御与 Subagent 拦截的测试用例全部通过）；全仓 `pnpm typecheck` 与 `pnpm build` 通过；
- 决策：Review Candidate，功能已完整落地。
