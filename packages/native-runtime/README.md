# @aervox/native-runtime

原生运行时客户端：只读 SQLite 向量缓存、音频预处理、Activity 租约与进程主管。

- 平台二进制品按固定摘要校验，`native:build` 生成；缺失或摘要不符时拒绝。
- IPC 协议类型由 `native/protocol` 生成，见 `mise tasks run native-protocol-generate`。
- 边界与生命周期差量见 [ADR-024](../../docs/reference/adr/ADR-024-native-runtime-boundaries.md)。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
