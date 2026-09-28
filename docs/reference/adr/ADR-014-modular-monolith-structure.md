---
id: ADR-014
type: reference
scope: decision
owner: maintainers
doc_status: approved
decision_status: accepted
version: 0.3.1
updated_at: 2026-09-28
reviewed_at: 2026-09-28
review_interval_days: 90
---

# ADR-014 演进式模块化单体：apps/api 目录结构

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-28

- 状态：Accepted（2026-08-31；2026-09-16 修订 0.3.0，见修订记录与 `CR-052`（已归档））
- 日期：2026-08-25

- 关联：`CAP-001～035`、`ADR-001`（模块化单体决策的细化）、`AVX-SAD-001 §3`、`CR-052 模块领域分组`（已归档）

## Context

ADR-001 已确定"模块化单体 + 独立 Worker"的总体方向，但未细化 `apps/api` 内部的代码组织方式。当前 API 层采用早期单体结构：路由文件扁平放在 `routes/` 目录，通过全局 `RepoContainer` 向所有路由注入仓储。随着业务模块增多（对话、学习、日记、反馈、隐私、埋点、内容、通知共 8 个领域），这种结构会导致：

1. **模块边界模糊**：任何路由可以引用任意仓储，无法在代码层面保证"对话模块不能写记忆表"等架构约束；
2. **依赖方向无约束**：全局容器模式允许任意文件引用任意 repo，未来拆分时难以定位影响范围；
3. **演进受阻**：当某个模块需要独立部署时（如 AI 模块未来可能单独扩缩容），需要大规模重构才能拆分。

**2026-09-16 修订背景（0.3.0）**：本 ADR 定稿时 API 层为 8 个模块，现已增长至 25 个扁平模块——单层目录失去领域语义，注册顺序发散，与 `apps/worker`（A 档已按 `proactive/` 分组）及 `packages/repositories`（`sqlite/conversation/`、`sqlite/proactive/`）的领域子目录组织不一致。经 `CR-052`（已归档） 立项，目录演进为两层领域分组结构；核心规则不变。

## Decision drivers

- 需要在当前单进程内建立**接近微服务的模块边界**，但不引入微服务的分布式复杂度；
- 每个模块自管自己的 routes/service/repository，模块间通过受控的事件或接口通信；
- 为未来"按需拆分"保留 seam：当且仅当某个模块满足拆分条件（团队边界、扩缩容需求、部署独立性）时，迁移成本最小化；
- 保持对 `@aervox/repositories` Repository Port 的稳定边界；CR-030 D2 完成后不再提供 `@aervox/database` 兼容包。

## Considered options

1. **保持当前扁平 routes/ + 全局 RepoContainer**：零改动，但无法建立模块边界；
2. **nested routing（Fastify register 模式）**：用 Fastify 自带的 `register` 建立路由前缀分组，但仓储仍通过全局容器注入，边界约束弱；
3. **演进式模块化单体（本决策）**：每个模块有独立的 `index.ts` 作为对外入口，模块内部自管仓储实例，跨模块通过进程内事件总线通信；
4. **直接微服务化**：每个模块拆成独立进程。复杂度高，违反 ADR-001 的"MVP 不采用微服务"决策。

## Decision

采用**演进式模块化单体**。`apps/api/src/` 按以下结构组织（0.3.0 修订：模块按 6 个业务域两层分组，域归属表见 `CR-052 §3.1`（已归档））：

```text
src/
├── modules/                        # 业务模块（按领域分组，每个自管 routes + 依赖注入）
│   ├── companion/                  #   陪伴与对话域
│   │   ├── conversation/           #     routes.ts + index.ts（每个模块同构，下略）
│   │   ├── persona/
│   │   ├── memory/
│   │   ├── inbox/
│   │   └── branch/
│   ├── learning/                   #   学习与练习域
│   │   ├── learning/
│   │   ├── study-materials/
│   │   ├── terms/
│   │   └── diary/
│   ├── knowledge/                  #   知识与内容域
│   │   ├── knowledge/
│   │   ├── content/
│   │   └── project/
│   ├── ecosystem/                  #   扩展生态域
│   │   ├── plugins/
│   │   ├── tools/
│   │   ├── mcp/
│   │   ├── skills/
│   │   └── llm/
│   ├── proactive/                  #   主动智能域
│   │   ├── proactive/
│   │   └── notification/
│   └── platform/                   #   平台基础域
│       ├── preferences/
│       ├── privacy/
│       ├── safety/
│       ├── voice/
│       ├── feedback/
│       └── analytics/
├── shared/                         # 跨模块共享（严格限制：只放真正通用的工具）
│   ├── local-context.ts            #   本地上下文解析
│   └── errors.ts                   #   共享错误类型
├── app.ts                          # Fastify 应用工厂（按域聚合注册模块）
└── index.ts                        # 入口
```

### 核心规则

| 规则 | 说明 |
|---|---|
| **领域分组（0.3.0）** | `modules/<domain>/<module>/` 两层组织；域目录**不承载任何代码**，只承载子模块；域归属以 `CR-052 §3.1`（已归档） 归属表为准，调整须同步修订本 ADR 与该表 |
| **模块自管仓储** | 每个 `modules/<domain>/<module>/index.ts` 内部实例化该模块需要的仓储，不引用全局容器 |
| **路由函数签名** | `routes.ts` 中的导出函数接收**该模块专属的仓储实例**，而非 `RepoContainer` |
| **shared 严格受限** | `shared/` 只放跨 2 个以上模块的通用工具。禁止将业务逻辑放入 shared |
| **跨模块通信** | 同步 Query/Command 通过窄公开 Port；可靠事实和后台工作通过持久 Outbox；可丢通知仅作唤醒或表现，不承担提交证明（CR-056 D1） |
| **单一数据库** | 一个本地 SQLite 实例；通过领域表命名和 `@aervox/schema` 文件分区，不引入 PostgreSQL 或共享数据库多租户 |
| **对外入口唯一** | 每个模块只有 `index.ts` 是对外可见的。`routes.ts` 内部的函数不被其他模块引用 |

### 模块 index.ts 示例

```typescript
// src/modules/conversation/index.ts
import { SqliteConversationRepository } from "@aervox/repositories";
import { registerConversationRoutes } from "./routes.js";
import type { FastifyInstance } from "fastify";
import type { AervoxDatabase } from "@aervox/repositories";

export function registerConversationModule(
  app: FastifyInstance,
  db: AervoxDatabase,
): void {
  const conversationRepo = new SqliteConversationRepository(db);
  registerConversationRoutes(app, conversationRepo);
}
```

### 路由函数签名变化

```typescript
// Before（全局容器）
export function registerConversationRoutes(app: FastifyInstance, c: RepoContainer): void {
  // 使用 c.conversation、c.learning 等任意仓储
}

// After（模块专属仓储）
export function registerConversationRoutes(
  app: FastifyInstance,
  conversationRepo: SqliteConversationRepository,
): void {
  // 只能使用 conversationRepo
  // 跨模块命令注入公开 Port；需要可靠后台处理时由领域命令同事务写入 Outbox
}
```

### 公开 Port 与原子性（CR-056）

每个模块仍以 `index.ts` 为唯一公开入口；入口导出实际消费者需要的 Query/Command Port。组合根显式构造实现并注入；普通消费者不得导入私有文件。禁止 import 时注册全局实例、启动定时器或进程。临时兼容边必须精确到源文件和目标文件，并登记 Owner 与删除条件。

领域命令负责其业务原子性和 Outbox 写入；消费者不得拼接跨模块事务。可丢通知可以触发重新读取权威状态，不能代替事务提交证据。试点先收敛 MemoryStore 贡献与本地模型 Driver；其余遗留装配逐边迁移，不能宣称现有包级检查已覆盖全部模块边界。

### app.ts 注册方式变化

```typescript
// Before
registerConversationRoutes(app, container);
registerLearningRoutes(app, container);
// ... 8 个扁平注册

// After
registerConversationModule(app, db);
registerLearningModule(app, db);
// ... 8 个模块注册（每个模块自管仓储实例化）
```

### 可迁移性设计

模块拆分必须重新验证失败模式、幂等、延迟和事务边界。公开 Port 缩小替换范围，但不保证跨进程迁移时业务逻辑零改动；本轮保持模块化单体和本地 SQLite。

## Positive consequences

- **代码层面的模块边界**：路由函数签名静态限制了可用仓储范围，ESLint import 规则可以进一步强制；
- **降低认知负荷**：每个模块的开发/修改只需关注 2~3 个文件（routes.ts + index.ts + shared 引用），不需要理解全局；
- **演进成本低**：具体实现替换集中到公开 Port 和组合根，跨进程迁移另行评审；
- **与 Worker 层对齐**：Worker 中的 Memory/Diary/Notification 处理天然是按模块组织的，API 层采用相同的模块化结构后，两端领域边界一致。

## Negative consequences and risks

- **初期多一层间接**：每个模块多了一个 `index.ts` 文件，对 8 个小模块来说略显冗余；
- **边界需维护**：公开 Port、Outbox 和可丢通知的责任必须清楚，防止同步业务命令被隐藏在通知中；
- **与 ADR-001 的 Worker 层协作需对齐**：当前 Worker 层尚未模块化，后续需同步演进。

## Migration / rollback

迁移步骤（一次性，预计 1~2 小时）：

1. 创建 `modules/`、`shared/` 目录；
2. 逐模块迁移：将 `routes/*.ts` 移到 `modules/*/routes.ts`，改写函数签名为接收单一仓储；
3. 为每个模块创建 `index.ts`（包含仓储实例化和路由注册）；
4. 创建 `shared/local-context.ts`、`shared/errors.ts`；
5. 重构 `app.ts`，替换路由注册为模块注册；
6. 删除 `container.ts`；
7. 验证 `pnpm build` + `pnpm typecheck` + `pnpm test` 全部通过。

回滚：Git 历史回溯到变更前的 commit，恢复原 `routes/` 与 `container.ts` 结构。

## Verification evidence

- [x] `pnpm build`：TypeScript 编译无错误（2026-08-31 `ci-code` 全量通过）；
- [x] `pnpm typecheck`：类型检查零 warning（2026-08-31 `ci-code` 全量通过）；
- [x] `pnpm test`：集成测试全部通过（2026-08-31 复核；同日登记修复的 diary `todayWindow` 时区缺陷与本文结构证据无关）；
- [x] `mise tasks run ci-docs`：文档 lint 0 issue（2026-08-31 全仓文档元数据清账后 0 warning）；
- [x] 依赖边界机器校验：`node scripts/import-boundary.mjs` 零违规（5 条规则，常驻 `ci-code` 的 `check:boundary`；当时仅验证包级边界；模块内私有引用缺口由 CR-056 补齐）。

五项证据均为常驻 CI 门禁而非一次性演练：`modules/*` 自管仓储与边界规则已固化于每日门禁，包级反向依赖会被 CI 拦截，不能由此推定模块边界全部闭合。2026-08-31 决策状态置为 `Accepted`（ADR 索引与架构摘要表同步）。

## 修订记录

- **0.3.0（2026-09-16，`CR-052`（已归档））**：目录结构由 `modules/<module>/` 一层演进为 `modules/<domain>/<module>/` 两层（25 模块 → 6 域）；核心规则新增「领域分组」，其余规则语义不变；`shared/tenant.ts` 示例名修正为 `local-context.ts`（对齐 CR-030 去租户化后的实际文件名）；Decision 目录树与迁移指引同步两层结构。实施随 CR-052 PR-C1 落地。
- 0.2.1（2026-09-11）：维护性升版（元数据与关联补齐），无决策变更。
