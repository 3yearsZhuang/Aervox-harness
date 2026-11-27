# @aervox/public

共享静态资源真源：品牌标识与介绍页，供消费端构建期拷贝。

- `aervox-intro/` 与 `aervox-mark.svg` 是唯一真源，`apps/*/public/` 下的是构建产物（已 gitignore）。
- 第三方资产在 `aervox-intro/vendor-manifest.json` 固定版本与校验和，由 `vendor-assets.mjs --verify` 校验。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
