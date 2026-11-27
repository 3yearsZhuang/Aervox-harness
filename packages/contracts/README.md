# @aervox/contracts

Aervox 的机器可验证契约事实源：Turn/SSE 流式协议、领域 Schema 与 OpenAPI。

- Zod Schema 与派生 DTO 是唯一类型来源；消费方不得重复声明同名契约（`check-type-boundary` 守卫）。
- OpenAPI 基线在 `openapi.json` 与 `compatibility/`，由 `pnpm check:standards` 校验向后兼容。
- 流式协议的事件 envelope、重连与持久化规则见 [文档](../../docs/reference/STREAMING_PROTOCOL.md)。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
