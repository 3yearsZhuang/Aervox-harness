# `packages/database` 拆分规划（W-19）

- 提出人：3yearszhuang · 2026-09-09
- 修改人：3yearszhuang · 2026-09-09

> 文档编号：AVX-EXPL-009
> 类型：Explanation
> 版本：v0.2
> 更新日期：2026-09-09
> 状态：Review Candidate
> 关联：[文档索引](../README.md)、[需求追踪与交付基线](../reference/REQUIREMENTS_TRACEABILITY.md)、[ADR-014 演进式模块化单体](../reference/adr/ADR-014-modular-monolith-structure.md)

本文是 REFACTOR-PLAN 中 W-19（`packages/database` 拆分）的规划产物，回答"这个 23,813 行的持久层包该怎么拆、按什么顺序拆、有哪些前置调研"。它只做拆分方案设计与落点梳理，**不包含代码改动**；实际拆分另起 `feat/` 分支分阶段推进，每一阶段独立 PR、独立可回滚。

## 1. 现状与规模

`packages/database`（`@aervox/database`）是 SQLite + Drizzle ORM 数据持久层与多租户仓储抽象，当前 23,813 行，约占 packages 自研代码的 38%。

| 子目录 | 文件数 | 说明 |
|---|---|---|
| `src/schema/` | 37（35 表定义 + `index.ts` + `init.ts`） | Drizzle 表定义 + DDL 初始化 |
| `src/repositories/` | 37（`types.ts` + `index.ts` + `sqlite/` 35 个） | 仓储接口 + SQLite 实现 |
| `src/search/` | 4 | FTS / 混合检索 / 向量端口 |
| `src/sync/` | 2 | git 快照同步 |
| `src/migration/` | 2 | 迁移服务 |
| 根散件 | 7 | `client.ts` `errors.ts` `tenant.ts` `write-retry.ts` `session-lock.ts` `token-usage.ts` `proactive-vault-{crypto,auth}.ts` |

**两个巨型文件**（合计 5,959 行，约占 25%）：

- `repositories/types.ts` — **3,378 行**：全部仓储接口定义
- `schema/init.ts` — **2,581 行**：DDL 初始化

**消费方**（`workspace:*` 依赖 `@aervox/database`）：`apps/api`、`apps/worker`、`packages/diary`、`packages/host-agent`（含自身）。

## 2. 拆分目标与约束

**目标**：把「表结构定义」与「仓储访问」从单一大包中解耦，降低巨型文件心智负担，为未来按模块渐进拆分预留 seam。

**硬约束（来自 AGENTS.md + ADR-014）**：

1. **不改变数据库层对外接口** —— ADR-014 Decision driver 明确「保持对现有 `@aervox/database` 仓储层的兼容，不改变数据库层接口」。拆分后消费方 `import { SqliteConversationRepository } from "@aervox/database"` 的既有导入路径必须继续可用（通过 re-export 兼容层保持）。
2. 依赖装根 workspace（`pnpm add -w`），禁止子包单独加依赖造成版本分裂。
3. 变更走 `feat/` 分支 + PR，落地改动在[追踪基线 §4.2](../reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 登记。
4. 一次只推进一个变更点，每步独立可回滚。

## 3. 拆分方向选项对比

REFACTOR-PLAN 给出的自然切分是 `@aervox/schema` + `@aervox/repositories`。在此基础上整理三个可选方向：

| 方向 | 切分 | 优点 | 代价 / 风险 |
|---|---|---|---|
| **A. 两包最小拆（已选定）** | `@aervox/schema`（表定义 + `init.ts`）/ `@aervox/repositories`（仓储接口 + SQLite 实现；search/sync/migration 视调研归位） | 贴合 REFACTOR-PLAN 原方案；schema 与 repository 天然分层；改动面集中在两个巨型文件 | 需建立 `@aervox/database` 兼容 re-export 层，避免消费方全部改 import |
| **B. 三包拆** | `@aervox/schema` / `@aervox/repositories` / `@aervox/database-core`（client/errors/tenant 等基础设施） | 职责最纯粹 | 包数增加，`database-core` 内容少而杂、边界难划清；性价比低 |
| **C. 按业务域拆** | 每域一包（`@aervox/schema-conversation`、`@aervox/repo-conversation` …） | 最贴合 ADR-014「按模块拆分」终态 | 与 ADR-014 的 `apps/api/src/modules/` 拆法重复（模块层在 api 侧，不在 database 侧）；包爆炸、跨域 schema 外键耦合难解；**现阶段不建议** |

**已选定 A**（2026-09-09）：REFACTOR-PLAN 既定方向的最小实现，schema/repository 分层是共识边界，且能用兼容 re-export 把消费方改动压到最低。兼容包 `@aervox/database` 定位为**拆分期间的过渡态**，最终在阶段 6 清理退出，非长期驻留。

## 4. 方向 A 的分阶段落点

> 顺序原则：先「无行为的结构平移」，再「去巨型文件」，再「切消费面」，最后「清理兼容包」。任一步都可停在绿 CI 状态。

### 阶段 0：冻结基线 + 立项登记

- 在追踪基线 §4.2 新增 W-19 行（状态：规划中）。
- 无代码改动；确认 `mise tasks run ci-code` 全绿作为拆分前基线。

### 阶段 1：建包壳 + 依赖图梳理

- 新建 `packages/schema`（`@aervox/schema`）与 `packages/repositories`（`@aervox/repositories`），`pnpm-workspace.yaml` 已覆盖 `packages/*`。
- 摸清依赖方向（见第 5 节），据此确定两个新包的 `dependencies`。

### 阶段 2：迁移 `schema/`（平移，不改逻辑）

- 把 `packages/database/src/schema/` 整体平移到 `@aervox/schema`，文件内容不变。
- `@aervox/database` 以 `export * from "@aervox/schema"` 做 re-export，**消费方 import 不变**。
- `schema/init.ts`（2,581 行）建议先平移后拆分，避免「平移 + 拆分」混在一个变更点。

### 阶段 3：迁移 `repositories/`（平移）

- 把 `packages/database/src/repositories/` 平移到 `@aervox/repositories`，同样用 re-export 保持对外接口不变。

### 阶段 4：去巨型文件

- `repositories/types.ts`（3,378 行）按仓储域拆分，与 `schema/` 表文件一一对应。
- `schema/init.ts`（2,581 行）按表域拆分 DDL，或抽 `migrations/` 目录。
- 风险最高，需单独立 PR，配足类型 / 测试回归。

### 阶段 5：切消费面（清理兼容包的前置）

- 逐步把 `apps/api` 等消费方 import 从 `@aervox/database` 收窄到 `@aervox/schema` / `@aervox/repositories`，直至 `@aervox/database` 零消费。
- 仅在阶段 4 稳定后启动；若 ADR-014 的 `modules/` 迁移同步推进，此步可与之一并收口。

### 阶段 6：清理兼容包（过渡态收尾）

- 当 `@aervox/database` 对消费方零引用后，删除该兼容组合包及其 re-export 层，仓库只保留 `@aervox/schema` + `@aervox/repositories`。
- 此阶段是兼容包的**退出条件**：兼容包仅用于拆分期间的平滑过渡，最终态不含 `@aervox/database`。此阶段启动前须 `grep` 全仓确认无 `@aervox/database` 残留 import，并更新 `pnpm-workspace.yaml` / 相关 `package.json`。

## 5. 待调研点（阶段 1 前置）

1. **schema ↔ contracts 耦合**：`schema/*.ts` 对 `@aervox/contracts` 的 import 数量与方向，是否形成 `contracts → schema → repositories` 干净依赖链。
2. **search / sync / migration 归属**：三者依赖 schema 还是 repository？决定归 `@aervox/repositories`、`@aervox/schema`，还是保留在 `@aervox/database` 作组合包。
3. **client.ts 注入面**：`AervoxDatabase` / client 是否被 schema 或 repository 反向引用（决定是否触发方向 B 的 `database-core`）。
4. **循环依赖风险**：平移后是否出现 `schema` ↔ `repositories` 双向 import（Drizzle 下 schema 通常不依赖 repository，但需确认 `init.ts` / 触发器等边界）。

## 6. 决策待办

| # | 事项 | 选项 |
|---|---|---|
| 1 | 拆分方向 | ✅ 已定：A（两包） |
| 2 | `@aervox/database` 是否保留为兼容组合包 | ✅ 已定：保留为过渡态兼容包，阶段 6 清理退出 |
| 3 | 巨型文件拆分是否纳入本次 | 纳入（阶段 4）/ 先只做结构平移，巨型文件后续另立 |
| 4 | 是否与 ADR-014 `modules/` 迁移联动 | 独立推进 / 等 ADR-014 落地后联动 |

## 7. 下一步建议

1. 阶段 0（立项登记 + 基线冻结）。
2. 跑第 5 节依赖调研，产出一份依赖方向图，作为阶段 1 输入。
3. 方向已定：A（两包）+ 保留过渡态兼容包（阶段 6 清理）；巨型文件是否纳入本次（#3）待定，确认后进入阶段 1。
