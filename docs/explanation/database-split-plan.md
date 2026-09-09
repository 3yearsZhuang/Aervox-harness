# `packages/database` 拆分规划（W-19）

- 提出人：3yearszhuang · 2026-09-09
- 修改人：3yearszhuang · 2026-09-09

> 文档编号：AVX-EXPL-009
> 类型：Explanation
> 版本：v0.4
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

### 阶段 0：立项 + 冻结基线

- 立项：本规划文档（AVX-EXPL-009）合入 `main`，W-19 正式立项。§4.2 的落地登记留待阶段 2 起实际平移时逐阶段补记（§4.2 只登记已落地改动，不登记规划）。
- 冻结基线：记录拆分起始 commit（本阶段合入后 `main` 的 HEAD），并确认 `CI` 全绿作为拆分前基线。无代码改动。

### 阶段 1：建包壳 + 依赖图梳理

- 新建 `packages/schema`（`@aervox/schema`）与 `packages/repositories`（`@aervox/repositories`），`pnpm-workspace.yaml` 已覆盖 `packages/*`。
- 摸清依赖方向（见第 5 节），据此确定两个新包的 `dependencies`。

### 阶段 2：迁移 `schema/`（平移，不改逻辑）

- 把 `packages/database/src/schema/` 整体平移到 `@aervox/schema`，文件内容不变。
- `@aervox/database` 以 `export * from "@aervox/schema"` 做 re-export，**消费方 import 不变**。
- `schema/init.ts` 不随 schema 平移（见 5.3：它依赖 `search/fts.ts`，归 `@aervox/repositories` 侧）。

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

## 5. 依赖方向调研结论（阶段 1 输入）

> 2026-09-09 实测，基于对 `packages/database/src` 全量 import 方向的静态分析，取代原「待调研点」。

### 5.1 依赖方向图

依赖方向统一自上而下（上层依赖下层），整体**无环**：

```text
L0 叶子/工具层   errors · write-retry · session-lock · token-usage · proactive-vault-*
                 ▲                        ▲
L1 类型/表结构    tenant ──▶ errors        schema/*.ts（35 表 + common，仅依赖 drizzle-orm）
                 ▲                        ▲          ▲
L2 组合/服务      search/* ──▶ tenant     client ──▶ schema/index + write-retry
                 ▲                        ▲
L3 建表          schema/init.ts ──▶ search/fts.ts（越层边）+ @libsql/client(type)
                 ▲
L4 数据访问       repositories/sqlite/* ──▶ schema/index + client(type) + tenant + errors
                 sync/* · migration/* ──▶ @libsql/client(type)（独立，仅此依赖）
```

### 5.2 四个调研点结论

1. **schema ↔ contracts 耦合：不存在**。`@aervox/contracts` 在 `src` 内 **0 处 import**（仅 `skills.ts`、`proactive.ts` 两处注释提及），但 `package.json` 仍声明 `workspace:*` —— **声明未用的死依赖**，阶段 1 顺手移除。schema 是纯 Drizzle 表定义层，只依赖 `drizzle-orm/sqlite-core` 与同级 `common.js`。

2. **search / sync / migration 归属**：三者都**不依赖 schema 对象**，仅依赖 `@libsql/client`（`type Client`）；search 额外依赖 `tenant.js`。它们是与仓储同层的「原生 SQL / FTS / 迁移」能力，随 `@aervox/repositories` 一起走，**不留在 schema 侧**。

3. **client.ts 注入面**：`AervoxDatabase = LibSQLDatabase<typeof schema>`，client 在**类型层面依赖 schema**，同时被 35 个仓储以 `type AervoxDatabase` 引用。client 是「schema 之上、仓储之下」的组合根，归属 `@aervox/repositories`，**不属 schema**（否则构成 schema → client → schema 环）。

4. **循环依赖风险**：表文件（`schema/*.ts` 除 `init.ts`）零反向依赖，无环。**唯一越层边是 `schema/init.ts → search/fts.ts`**（`initFtsTables`）——非环，但属「schema 反向依赖 search」的越层引用，拆分时须处理（见 5.3）。

### 5.3 拆分边界（方案 A 落定后）

| 目标包 | 内容 | 依赖 |
|---|---|---|
| `@aervox/schema` | `schema/*.ts`（35 表 + `common.ts` + `index.ts`） | `drizzle-orm` |
| `@aervox/repositories` | `repositories/` + `client.ts` + `errors.ts` + `tenant.ts` + `write-retry.ts` + `session-lock.ts` + `token-usage.ts` + `search/` + `sync/` + `migration/` + `schema/init.ts` | `@aervox/schema` + `drizzle-orm` + `@libsql/client` |

**关键处理点**：`schema/init.ts` 依赖 `search/fts.ts`（建 FTS 表），故 `init.ts` **不随 schema 平移**，改归 `@aervox/repositories` 侧（与 client/search 同层），消除 schema → search 越层反向边。

**附**：`@aervox/contracts` 死依赖在阶段 1 移除（或按 §4.2 另行登记）。

## 6. 决策待办

| # | 事项 | 结论 |
|---|---|---|
| 1 | 拆分方向 | ✅ 已定：A（两包） |
| 2 | `@aervox/database` 是否保留为兼容组合包 | ✅ 已定：保留为过渡态兼容包，阶段 6 清理退出 |
| 3 | 巨型文件拆分是否纳入本次 | ✅ 已定：纳入本次（阶段 4 去巨型文件） |
| 4 | 是否与 ADR-014 `modules/` 迁移联动 | ✅ 已定：与 ADR-014 `modules/` 迁移联动推进 |

## 7. 下一步建议

1. 阶段 0：立项登记（§4.2 新增 W-19 行）+ 基线冻结（`mise tasks run ci-code` 全绿）。
2. 阶段 1：建包壳 + 落地依赖方向图结论（含移除 `@aervox/contracts` 死依赖、`init.ts` 归 repositories 侧）。
3. 阶段 2 起：按 5.3 边界平移 schema（`init.ts` 除外）→ 平移 repositories → 去巨型文件 → 切消费面 → 清理兼容包，与 ADR-014 `modules/` 迁移联动推进（阶段 5 与之并收口）。
