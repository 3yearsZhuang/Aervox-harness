---
id: ADR-021
type: reference
scope: decision
owner: platform
doc_status: review-candidate
decision_status: accepted
delivery_status: planned
version: 1.0.0
updated_at: 2026-10-03
reviewed_at: 2026-10-03
review_interval_days: 90
review_triggers:
  - packages/core/**
  - packages/agent-loop/**
  - packages/host-agent/src/cli-approval.ts
sources:
  - docs/reference/adr/README.md
  - docs/reference/agent-harness-loop.md
  - docs/explanation/reference-design-transfer.md
---

# ADR-021 Aervox Core 独立内核包与最小发行边界

- 提出人：3yearszhuang · 2026-10-03
- 修改人：3yearszhuang · 2026-10-03

## Status

已接受（2026-10-03）。实现载体为 ITER-035；Provider 统一面由 ITER-033 在本包内落地。

## Context

Aervox Core 的解耦工作经历了一次完整的搁浅与重启：PR #231（CR-056 / 已回退的 ADR-020）首次落地后按用户要求回退（#232），后续演进在已关闭的 PR #235 分支上完成；PR #241（ITER-034）将其高优先级内核切片（ControlContext、abortable 原语、ApprovalPolicyPort SPI、executor 接线）重落 main，并达成 `@aervox/agent-loop` **运行时零外部依赖**（contracts 降级为 type-only devDependency）。

对照 pi（`PI-01`，参考登记定位为"自研重写、不作运行时依赖"）的发行形态——发布的 npm 包 + 零依赖 + 统一 Provider 层 + loop + tools——Aervox 内核在架构能力上已对齐甚至更强（账本优先的可审计、可恢复、幂等副作用回路），差距集中在工程与决策层：

1. **包边界**：CLI TTY 审批（`cli-approval`）位于 `packages/host-agent`，该包依赖 `@libsql/client` 与 `@aervox/repositories`，轻量消费者被迫整包安装；
2. **构件缺口**：工具沙箱运行时（内存版无 SQLite 依赖）与轻量出口仍搁浅在 PR #235 分支；
3. **Provider 面**：两套模型栈（agent-loop OpenAI-compat 与 apps/api model-runtime Driver SPI）尚未统一（ITER-033）；
4. **许可证**：主仓源码 AGPLv3，对闭源下游不友好，与"最小发行版本"的定位冲突。

用户于 2026-10-03 裁决三项决策：包边界采用方案 A（新建 core 渐进吸收）、内核采用 Apache-2.0 许可、现在入队且 Provider 统一在包内做。

## Decision

1. **新建 `packages/core`（`@aervox/core`），渐进吸收（方案 A）**。吸收范围：
   - `packages/agent-loop` 全部内容（executor、ControlContext、审批 SPI、abortable、tool-input-safe、context-builder、InMemoryExecutionStore、OpenAI-compat Provider、adapter-sim、subagent-contribution、lease-heartbeat 等）；
   - `cli-approval` 自 `packages/host-agent` 迁入（消除 libsql 拖拽）；
   - HostToolRuntime **内存版**（含 InMemoryToolRegistry、definitionKey 代际指纹、门禁算子）自 PR #235 分支移植；SQLite 注册表实现仍留 apps/api 生态模块；
   - `core.ts` 轻量出口（明确不引入 SQLite/LibSQL/Drizzle 的纯内存管线组合）。
2. **`packages/agent-loop` 降级为 re-export 壳**（`export * from "@aervox/core"`），过渡一个迭代后移除；过渡期内 diary / host-agent / api / worker 四个下游零改动。
3. **许可证分层**：`packages/core` 采用 **Apache-2.0**（单一版权人对自研内核的再许可），主仓其余源码维持 AGPLv3；README 双语许可说明同步更新，包内附 Apache-2.0 许可文本。
4. **ITER-033（Provider 统一）在 core 包内落地**：统一模型调用面是 core 的公共 API，core 包即 ITER-033 的交付载体；避免"先统一后立包"造成的出生即破坏。
5. **发布（public npm）延后决策**：core 先以 private workspace 包确立身份与边界，public 发行（包名、版本化、CHANGELOG、API 文档）另行决策；headless 冒烟脚本作为独立性的可执行证明随 ITER-035 交付。
6. **产品边界不变**：core 是库不是宿主；连接版 CLI 的"不引入独立宿主"门禁（ITER-029）不受影响。

## Alternatives

| 方案 | 内容 | 拒绝理由 |
| --- | --- | --- |
| B：直接改名升格 | `agent-loop` 改名 `@aervox/core`，四下游 import 一次性改完 | 一次性改动面大（diary/host-agent/api/worker 及全部 src import），历史断裂，无法分步回退 |
| C：子路径出口 | host-agent 增加 `./core` exports 子路径（PR #235 原设计） | 只解决出口不解决依赖——安装仍拖 `@libsql/client`，不满足"彻底独立" |
| 先统一 Provider 后立包 | ITER-033 完成后再建 core | 统一过程落在两个旧包内，core 出生即 API 不稳定；反转后 core 成为统一的自然载体 |

## Consequences

**正面**：

- 内核获得独立包身份与依赖闭包（运行时零外部依赖已达成），成为 pi 式"思隅最小发行版本"的候选载体；
- Apache-2.0 内核对闭源与商业下游友好，与 AGPL 主仓形成"内核宽松、产品护城"的分层许可结构，利于外部贡献；
- cli-approval 迁入消除 host-agent 的 libsql 拖拽，轻量消费者（headless、测试、未来离线宿主）只装 core；
- HostToolRuntime 内存版入库后，工具注册/代际防护/门禁不再仅存在于 HTTP 耦合的 apps/api 实现。

**负面与风险（含缓解）**：

- 过渡期 agent-loop 与 core 双包并存，存在双真源漂移风险——以 re-export 壳（不含任何实现）消除，并在一个迭代内移除；
- 仓库进入双许可状态，README 许可说明与包级 LICENSE 文件需持续维护；
- ADR-020 编号随 #232 回退退役（原文存于归档仓库），本 ADR 不复用该编号以保留可考的历史空缺；
- host-agent 公共导出面在 cli-approval 迁出后需以 re-export 保持兼容，随壳移除一并清理；
- Provider 面统一（ITER-033）完成前，core 与 pi 的发行形态仍有差距——统一前的 public 发布无意义，故发布延后。

## Evidence

ITER-035 验收口径（实现切片）：

- `packages/core` 建立，运行时依赖为空（`dependencies: {}`），contracts 为 type-only devDependency；
- headless 冒烟脚本在无 Fastify / 无 SQLite / 无 apps/api 的进程内跑通完整多步工具回路（含 ControlContext 预算与审批路径）；
- `agent-loop` 为纯 re-export 壳，四下游包零改动、全量增量门禁通过；
- `./aervox ci` 与 `plan-check` 全绿，追踪基线 §4.2 登记锚点就位。

## 关联

- ITER-034（内核切片重落，PR #241）、ITER-035（本 ADR 实现载体）、ITER-033（Provider 统一，在 core 内落地）；
- `PI-01` 参考登记（自研重写 + Adapter 翻译，外部仓库不作运行时依赖）；
- BTD-05 统一控制规范（`docs/reference/agent-harness-loop.md` §10）；
- 历史脉络：PR #231 / #232 / #235（已关闭，构件来源）。
