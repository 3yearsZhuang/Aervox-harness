---
id: CR-059
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 0.1.0
updated_at: 2026-09-30
reviewed_at: 2026-09-30
review_interval_days: 90
sources:
  - docs/reference/STREAMING_PROTOCOL.md
  - packages/api-client/src/transport.ts
  - packages/contracts/src/stream-projection.ts
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-059 共享客户端传输加固与客户端侧事件投影

- 提出人：3yearszhuang · 2026-09-30
- 修改人：3yearszhuang · 2026-09-30

## 1. 授权与范围

本 CR 从原 PR #235 中拆出**与终端宿主无关**的共享客户端改动。该 PR 因把 25/27 个提交用于重放 main 已在 #232 回退的 CR-056/ADR-020 架构线而被关闭；其中 `@aervox/api-client` 的传输加固本身与 CLI 无关、且为桌面端与 Web 端共用，故独立立项与评审。

接受范围为 `packages/api-client` 与 `packages/contracts` 的客户端传输与投影能力：可选传输配置、类型化 HTTP 错误、Fetch 扩展接口（`watchTurn`/`cancelTurn`）、纯传输构建出口，以及客户端侧事件投影与游标重连。

**不在范围内**：服务端实时与历史回放的白名单投影（其对应改动随 PR #231 被 #232 回退，服务端仍按原样下发事件）、服务端路由与授权口径、数据库 Schema、Electron 主进程自动重连、终端宿主（`apps/cli`，由并行提案 CR-058 承接，本 CR 不含其代码与文档）。

## 2. 接口与行为

- `createFetchTransport(apiBase, config?)` 新增可选配置：`headers`、`requestTimeoutMs`、`streamIdleTimeoutMs`、`redirect`。原单参数调用不要求迁移；
- 新增 `AervoxHttpError`（携带 `status` 与请求路径），供调用方按状态码决定重试、鉴权或终止；
- 新增 `FetchTransport` 扩展接口：`watchTurn(turnId, callbacks, signal?)` 与 `cancelTurn(turnId, signal?)`。二者**仅由 Fetch 传输提供**，不强制 Electron IPC 传输实现，因此桌面桥接路径不受影响；
- `submitQuestionAnswers` 与 `decideToolApproval` 增加可选 `AbortSignal`；
- 新增子路径导出 `@aervox/api-client/transport`：由 `tsconfig.transport.json` 只产出 `transport` 与 `projector`，**不加载 Vue composables**，供非 Vue 宿主（终端、脚本、无头运行）复用同一传输实现；根导出保持原有 composables 表面；
- 客户端侧投影：`packages/contracts/src/stream-projection.ts` 提供事件白名单投影（嵌套 DTO 同样移除未声明字段），`packages/api-client/src/projector.ts` 的 `TurnStreamProjector` 负责按 `sequence` 去重、丢弃乱序与终态后事件；
- Fetch 传输在三次连接尝试内保留**同一 Turn、同一 Projector 与最后已投递事件游标**，`HTTP 410` 明确失败而不静默新建 Turn；
- Electron IPC 传输改为复用同一 `TurnStreamProjector`，并在终态后丢弃迟到消息；其原先内联的事件分发逻辑被删除，回调表面不变。

## 3. 兼容与迁移

新增字段、方法与导出均为**可选或新增**，既有调用方无需迁移：单参数 `createFetchTransport(apiBase)` 继续有效，根导出路径与既有 hook 不变，IPC 桥接协议未变。`desktop-transport.ts` 的事件分发改为经投影器转发，属**行为变更**：重复、乱序与终态后事件不再下发。该行为变更随本 CR 一并进入桌面端，验证范围见 §5。

## 4. 实现边界与决策

- 服务端白名单投影不在本 CR：服务端仍按原样下发事件，客户端侧投影是**防御性**的，不构成对服务端字段的信任声明；
- 不新增服务端路由、授权口径、恢复合同或数据库 Schema；
- 子路径导出使用独立 `tsconfig.transport.json` 产出，避免把 Vue composables 拉进非 Vue 宿主的依赖闭包；包级 `build` 由 `tsc -p tsconfig.json && tsc -p tsconfig.transport.json` 组成，`tsconfig.json` 保持 `noEmit`；
- 不改变 `packages/api-client` 的包边界规则：它仍不得反向依赖任何宿主 Shell 包。

## 5. 验证与剩余差量

已执行：`@aervox/api-client` 11 个文件 60 项测试（含投影器顺序/去重/终态与传输配置、错误类型、取消与重连用例）、`packages/contracts` 全量测试、`./aervox ci all` 全量门禁（18 包构建/类型/测试与全量文档严格检查）。测试同步工程化验证由依赖本 CR 的 CR-058 集成用例覆盖（真实 API + 文件 SQLite 下的流式与终态）。

**未验证并如实保留**：真实跨进程 SSE 断线/半开连接场景的游标续传、Electron IPC 传输在 Windows/Linux 桌面端的投影行为、主进程自动重连（本次未纳入）、与服务端未来白名单投影的字段一致性对账（服务端侧改动尚未重新立项）。

## 6. 回滚

本 CR 全部改动为纯客户端：回退后既有调用方仍按旧接口工作，服务端与数据库无需任何回滚动作；子路径导出被移除时，依赖该出口的宿主（CR-058 的终端）需一并回退。没有数据迁移或持久化状态，卸载不保留额外数据。
