---
id: AVX-###-###
type: tutorial
scope: guide
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

# <教程名>（Tutorial 模板）

本教程带新成员从 0 完成一条可验证路径。只写"怎么做成"，不重复契约与规则正文；需要精确定义时链接对应 Reference 文档。

## 前置条件

- 环境与工具链以 [mise.toml](../../mise.toml) 为唯一真源（Node.js 24、pnpm 11 等）；
- 需要的数据、目录或服务：<…>；
- 完成后应看到的结果：<可验证的最终状态>。

## 步骤 1：<动作>

```bash
<可复制命令>
```

- 预期输出：<可观察结果>；
- 常见失败与定位：<…>。

## 步骤 2：<动作>

<按需增加步骤；每步都给出可验证结果，步骤之间不要隐藏隐式状态。>

## 验证

- <可执行校验命令或可观察状态>；
- 与规则、契约不一致时，以正文链接的 Reference 文档为准。

## 下一步

- 回到 [plan.md](../../plan.md) 认领具体工作，或继续阅读[文档索引](../README.md)。
