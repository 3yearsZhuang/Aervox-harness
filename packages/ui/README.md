# @aervox/ui

平台中立的 Vue 组件、工作台组合式函数、陪伴视觉核心与主题令牌。

- 桌面端与 Web 共用同一套组件与主题，两端不各自维护副本。
- **必须通过子路径导入**（`@aervox/ui/primitives`、`@aervox/ui/workbench`、
  `@aervox/ui/material3` 等，共 21 个）。裸写 `@aervox/ui` 会解析失败。
- 主题与设计约定见 [交互设计](../../docs/reference/DESIGN.md)。

## 破坏性变更：根 barrel 已移除（2026-11-27）

`packages/ui/src/index.ts` 与 `package.json` 的 `"."` 出口已删除。

**原因**：该 barrel 在生产代码中零消费者——桌面端、Web 与所有插件都走子路径。
留着它意味着每次增删组件都要维护一份无人读取的导出清单，而 `MessageBubble`、
`SpritePet` 这类零引用组件正是靠它挂在那里「看起来还在用」。

**影响**：`import { X } from '@aervox/ui'` 从「可用」变为解析失败。本仓内没有
这种导入（`check:boundary` 的边界用例也已改用子路径）。

**迁移**：按组件所在位置换成对应子路径。常用对照：

| 原导入 | 改为 |
|---|---|
| `AervoxButton` 等基座控件 | `@aervox/ui/primitives` |
| `WorkbenchHeader`、`ConversationConsole`、`useWorkbench*` | `@aervox/ui/workbench` |
| `Material Web` 注册与主题 | `@aervox/ui/material3` / `@aervox/ui/material3/register` |
| Markdown 渲染 | `@aervox/ui/markdown` |

主题样式不受影响：根 barrel 里那 5 个 CSS 导入由 `@aervox/ui/workbench` 经
`theme/workbench-all.css` 完整装载同一套链，行为等价。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
