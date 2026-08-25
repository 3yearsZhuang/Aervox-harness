# ADR-002 React/Vite + Fastify + OpenAPI/SSE

> **Superseded by [ADR-015](ADR-015-vue-full-stack.md)**：Web 层基线改为 Vue 全栈单栈；本记录保留原文，仅备案历史决策。

- 状态：Superseded by ADR-015（原为 Proposed）
- 日期：2026-08-23（2026-08-25 标记 Superseded）
- Owner：待指定
- 关联：`NFR-PERF-001`、`NFR-COMPAT-001`、`CAP-001/002/009/018`

## Context

首发是登录后的流式工作台，需要复用到 Electron/移动端，并保留 P2 插件和非 TypeScript 消费者的可能性。SSR 和 tRPC 会把后端/客户端边界绑定到单一框架；核心对话是服务端到客户端单向流。

## Decision drivers

- Web/Electron/移动端需要复用契约和领域规则，客户端不应被单一框架锁定；
- 对话是服务端到客户端单向流，不需要 MVP 阶段的双向协作连接；
- 接口需要被非 TypeScript 消费者（P2 插件、外部集成）稳定消费；
- 破坏性变更需要可评审、可兼容的演进路径。

## Considered options

1. **React/Vite + Fastify/OpenAPI/SSE**：客户端复用、契约可生成、流式路径简单（选定）。
2. **Next.js 全栈**：SSR 能力强，但把后端/客户端边界绑定到单一框架；公开网页属 P3 需求。
3. **React + tRPC/WebSocket**：类型端到端便利，但 WebSocket 增加连接状态与恢复复杂度，tRPC 会锁定消费者类型。
4. **传统 REST + 长轮询**：实现简单，但无法提供流式低延迟体验。

## Decision

采用 React 19/Vite 7、Fastify 5、Zod 4、OpenAPI 3.1 和 POST Turn + GET SSE（客户端用 Fetch streaming 消费）。Zod schema 生成/校验 OpenAPI；API 版本和错误契约由 `contracts` 包维护。未来双向协作需求再单独引入 WebSocket，不让 MVP 承担其复杂度。

## Positive consequences

- Web/Electron/移动端复用同一 UI 与契约，降低多端成本；
- OpenAPI/Zod 生成契约，服务端校验与客户端类型一致；
- SSE 单向流简单，便于实现重连/取消语义；
- 非 TypeScript 消费者可通过契约接入。

## Negative consequences and risks

- 需长期维护 OpenAPI 与 SSE 重连/取消语义（细节由 ADR-012 承载）；
- 核心页面 SEO/公开分享需在 P3 单独增加 SSR 应用；
- Fetch 消费 SSE 需自行处理 heartbeat、去重与断点恢复。

## Migration / rollback

API 使用 `/v1` 和兼容窗口；破坏性变化先新增字段/端点，再迁移客户端。SSE 不可用时降级为已持久化结果轮询；切换框架不改变领域端口或数据库。

## Verification evidence

状态改为 `Accepted` 前至少提供：

- OpenAPI/JSON Schema diff 检查（`TC-CONTRACT-STREAM-001`）；
- SSE 断线重连、`Last-Event-ID` 重放与重复去重测试（`TC-RES-STREAM-001`）；
- 取消、重复提交与游标过期测试（`TC-E2E-STREAM-001`）；
- 上一版本客户端兼容与 Playwright 核心流程测试（`TC-E2E-COMPAT-001`）。
