# @aervox/ui

平台中立的 Vue 组件、工作台组合式函数、陪伴视觉核心与主题令牌。

- 桌面端与 Web 共用同一套组件与主题，两端不各自维护副本。
- 消费方通过子路径导入（`@aervox/ui/primitives` 等）；根 barrel 只为兼容保留。
- 主题与设计约定见 [交互设计](../../docs/reference/DESIGN.md)。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
