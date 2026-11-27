# @aervox/live2d

共享 Live2D 模型资产与消费端调用的拷贝操作。

- `mizuki/` 是模型唯一真源，`apps/*/public/live2d/` 下的是构建期拷贝。
- 拷贝用同目录暂存再 rename；中断残留由下次构建清理（`.mizuki-stage-*`）。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
