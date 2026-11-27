# @aervox/host-runtime

API 与 Worker 共用的产品宿主组合与执行编排。

- `buildHostRuntime` 是装配入口；组合根之外不得直接 import 模块内部文件。
- 宿主必须保持领域纯净：插件领域概念只通过 `host-plugin-api` 端口进入（`check-host-domain-purity` 守卫）。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
