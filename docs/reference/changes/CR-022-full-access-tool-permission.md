---
id: CR-022
type: reference
scope: change
owner: architecture
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 0.2.0
updated_at: 2026-08-29
reviewed_at: 2026-08-29
review_interval_days: 90
sources:
  - docs/reference/SRS.md
  - docs/reference/agent-harness-loop.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-022 Turn 级完全访问工具权限开关

- 提出人：3yearszhuang · 2026-08-29
- 修改人：3yearszhuang · 2026-08-29

关联：[软件需求规格](../SRS.md#br-conv-001-代码执行边界)、[Agent Harness Loop](../agent-harness-loop.md#9-工具执行管线)、[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)

## 变更原因

当前 `write_with_approval` 工具每次都需命中显式授权，连续、可预期的本地任务会频繁中断。本变更增加一个默认关闭的「完全访问」开关，让用户在信任当前任务时减少普通写工具的确认步骤，同时保留原有管理员、租户、撤权、删除、超时和沙箱边界。经 CR-023 接受后，CAP-033 另提供用户确认的 `FullProfileActionGrant`，用于主动能模式的全动作授权，不改变普通 `full_access` 的默认语义。

## 决策与语义

- `CreateTurnRequest.toolApprovalMode` 取值为 `ask | full_access`，缺省 `ask`。客户端为每个 Turn 显式传递当前模式，服务端在执行开始前固化本次快照。
- `full_access` 只自动放行 `write_with_approval`，不修改工具注册表的固有 `safetyLevel`。
- 普通 `full_access` 下的 `privileged` 仍进入独立管理员审批通道；CAP-033 主动能模式若存在覆盖当前目标的用户 `FullProfileActionGrant`，可按该授权快照放行 `privileged`、外部和不可逆动作。租户隔离、Consent/撤权、删除水位、工具启停、参数校验、沙箱、超时和配额始终有效。
- 动态 ToolRuntime 与静态 Subagent/Workflow Contribution 的写工具共用同一授权决策，Provider 组合不得绕过审批门。
- 运行中的 Turn 禁止切换模式。关闭完全访问只影响后续 Turn，不撤回已开始的副作用。

## 授权快照与数据

本变更本身不新增 Turn 级数据表。每次自动放行仍通过 `tool_approvals` 记录 pending→granted 决策，并以 `decidedBy=permission:full_access:<actor>` 标识授权来源。普通显式授权查询排除该前缀，因此关闭开关后，同工具和同参数不会继续命中自动授权。CAP-033 的画像、动作和设备授权记录使用独立本地数据面，不复用该自动授权前缀。

客户端可以在本机记住用户选择，以支持 CAP-033 经授权的开机、自启和恢复；服务端仍要求每个新 Turn 显式携带 `toolApprovalMode`，设备级状态不能替代该快照。CAP-033 的画像和动作授权由独立 `FullProfileGrant`/persistence grant 管理，并在恢复和异常时向用户告知。

## 交互与契约

- 共享 Workbench 在输入区显示「操作需确认 / 完全访问」状态，收起后仍可见。
- 开启完全访问时显示风险弹窗，用户必须勾选确认项后才能启用；关闭时立即回到 `ask`。
- Web fetch 与 Electron IPC 传递同一字段；契约以 `packages/contracts` 及生成的 OpenAPI 为事实源。
- 对话路由在中间件重构期保持不变；API 通过 async `preValidation` 中间件固化请求策略。

## 风险、回滚与验证

- 风险：误开启或授权记录跨模式复用可导致未确认写操作；CAP-033 增加全动作授权和后台恢复后，仍追踪为 `RISK-012`，并由独立 revision/target/deny 校验降低风险。
- 灰度：默认 `ask`，只有客户端显式传入 `full_access` 才启用；旧客户端不传字段时行为不变。
- 回滚：前端隐藏开关并停止传递 `full_access` 即可恢复全量待授权；历史自动授权因查询排除规则保持惰性，无需数据清理。
- 验证：`conversation-approval.test.ts`、`conversation-privileged.test.ts`、`tool-approval-policy.test.ts`、API Client `transport.test.ts`、CAP-033 `proactive.test.ts`/`proactive-action-authorizer.test.ts`、Contracts/API/API Client/UI/Desktop typecheck、OpenAPI 生成、`ci-code`、`ci-docs`与双视口浏览器验收。

## 决策

变更已接受并实现。普通完全访问不等于撤销所有安全控制；CAP-033 的 `FullProfileActionGrant` 是用户显式确认的独立动作授权，可覆盖声明的 `privileged`、外部和不可逆动作，但仍必须通过当前授权修订、目标 scope、OS/身份、沙箱、撤权和审计校验。跨越工作区边界或关闭沙箱仍需单独建立新 CR 和安全评审。
