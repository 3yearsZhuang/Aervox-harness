---
id: CR-065
type: reference
scope: change
owner: frontend
doc_status: review-candidate
decision_status: accepted
delivery_status: planned
version: 0.1.0
updated_at: 2026-10-13
reviewed_at: 2026-10-13
review_interval_days: 90
sources:
  - docs/reference/changes/CR-063-ui-surface-plugins.md
  - docs/reference/PRD.md
---

# CR-065 命名模型分层：思隅为空间，陪伴角色有自己的名字

## 1. 决策与范围

维护者于 2026-10-13 授权：纠正产品设计早期的命名失误——「思隅」是软件名（陪伴角色所在的空间与交互介质），不是陪伴角色的名字。角色拥有自己的名字（用户可改），角色对用户的称呼也由用户自定义。

**命名模型三层**：

1. **空间名「思隅」**：固定软件名，不作任何字段配置；
2. **角色名 `companionName`**：陪伴角色的名字，默认「小隅」，用户可改；当前人格名（persona.name）即角色名的服务端形态，UI 设置层的 `assistantName` 字段语义更名为 `companionName`；
3. **用户称呼 `userAddress`**：角色称呼用户的方式，默认「你」，用户可改。

## 2. 行为差量

- 设置「对话」分类的「助手称呼」字段拆为两个：「TA 的名字」与「TA 怎么称呼你」；
- 工作台与各替代界面（主动陪伴 / 素简文档）的问候语、署名、对话提及统一使用角色名与用户称呼；
- 客户端每轮发送在 turn metadata 携带 `companionName` / `userAddress`（宿主显式元数据，插件不得覆盖）；
- 提示词策略身份段改为「你是 {角色名}——住在『思隅』这间屋子里的陪伴角色」，并声明对用户的称呼；人格设定仍可覆盖（既有优先级不变）；
- 旧设置里自定义过的 `assistantName` 迁移为 `companionName`；值恰为「思隅」时回到默认「小隅」（纠正误命名）。

## 3. 验证与回滚

- 单元测试：身份读写迁移（含旧值迁移与「思隅」纠正）、提示词身份段、设置双字段保存；
- 回归：工作台与各界面插件测试全绿；
- 回滚：回退本切片代码即可，无数据迁移（旧 localStorage 字段保留可读）。
