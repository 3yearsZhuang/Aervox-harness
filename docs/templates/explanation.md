---
id: AVX-EXPL-###
type: explanation
scope: baseline
owner: <team-role>
doc_status: draft
decision_status: not-applicable
delivery_status: not-applicable
version: 0.1.0
updated_at: YYYY-MM-DD
reviewed_at: YYYY-MM-DD
review_interval_days: 90
review_triggers:
  - <path-or-event>
sources:
  - <canonical-source-path>
---

# <概念>如何运作（Explanation 模板）

- 提出人：<账号> · YYYY-MM-DD
- 修改人：<账号> · YYYY-MM-DD

本文讲解"<概念>为什么这样设计、如何运转"。不重复 Reference 细节（字段、命令、接口），只讲因果与权衡；需要事实时引用对应契约。

## 一句话模型

- 用一段话说清该概念在系统中的位置与作用。

## 概念地图

- 参与组件、模块与文档清单及其职责边界；
- 用引用的形式指向 [ARCHITECTURE.md](../reference/ARCHITECTURE.md)、相关 ADR 与契约。

## 端到端视角

- 一个典型事件（如一次对话、一条记忆写入）如何流动；
- 关键时序与失败路径，引用相关契约的状态机。

## 设计权衡

- 曾考虑的替代方案与否决理由（关联 `ADR-*`/`EXP-*`）；
- 当前限制与已知副作用。

## 演进方向

- 下一步拟改变什么，触发什么 `CR-*`/`ADR-*`。
