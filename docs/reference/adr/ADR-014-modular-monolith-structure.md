# ADR-014 演进式模块化单体：apps/api 目录结构

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-31

- 状态：Accepted（2026-08-31）
- 日期：2026-08-25

- 关联：`CAP-001～035`、`ADR-001`（模块化单体决策的细化）、`AVX-SAD-001 §3`

> 更新日期：2026-08-31

## Context

ADR-001 已确定"模块化单体 + 独立 Worker"的总体方向，但未细化 `apps/api` 内部的代码组织方式。当前 API 层采用早期单体结构：路由文件扁平放在 `routes/` 目录，通过全局 `RepoContainer` 向所有路由注入仓储。随着业务模块增多（对话、学习、日记、反馈、隐私、埋点、内容、通知共 8 个领域），这种结构会导致：

1. **模块边界模糊**：任何路由可以引用任意仓储，无法在代码层面保证"对话模块不能写记忆表"等架构约束；
2. **依赖方向无约束**：全局容器模式允许任意文件引用任意 repo，未来拆分时难以定位影响范围；
3. **演进受阻**：当某个模块需要独立部署时（如 AI 模块未来可能单独扩缩容），需要大规模重构才能拆分。

## Decision drivers

- 需要在当前单进程内建立**接近微服务的模块边界**，但不引入微服务的分布式复杂度；
- 每个模块自管自己的 routes/service/repository，模块间通过受控的事件或接口通信；
- 为未来"按需拆分"保留 seam：当且仅当某个模块满足拆分条件（团队边界、扩缩容需求、部署独立性）时，迁移成本最小化；
- 保持对现有 `@aervox/database` 仓储层的兼容，不改变数据库层接口。

## Considered options

1. **保持当前扁平 routes/ + 全局 RepoContainer**：零改动，但无法建立模块边界；
2. **nested routing（Fastify register 模式）**：用 Fastify 自带的 `register` 建立路由前缀分组，但仓储仍通过全局容器注入，边界约束弱；
3. **演进式模块化单体（本决策）**：每个模块有独立的 `index.ts` 作为对外入口，模块内部自管仓储实例，跨模块通过进程内事件总线通信；
4. **直接微服务化**：每个模块拆成独立进程。复杂度高，违反 ADR-001 的"MVP 不采用微服务"决策。

## Decision

采用**演进式模块化单体**。`apps/api/src/` 按以下结构组织：

```text
src/
├── modules/                        # 业务模块（每个自管 routes + 依赖注入）
│   ├── conversation/
│   │   ├── routes.ts               #   路由处理（函数接收具体 repo，而非全局容器）
│   │   └── index.ts                #   模块入口：注册路由 + 实例化仓储
│   ├── learning/
│   │   ├── routes.ts
│   │   └── index.ts
│   ├── diary/
│   │   ├── routes.ts
│   │   └── index.ts
│   ├── feedback/
│   │   ├── routes.ts
│   │   └── index.ts
│   ├── privacy/
│   │   ├── routes.ts
│   │   └── index.ts
│   ├── analytics/
│   │   ├── routes.ts
│   │   └── index.ts
│   ├── content/
│   │   ├── routes.ts
│   │   └── index.ts
│   └── notification/
│       ├── routes.ts
│       └── index.ts
├── shared/                         # 跨模块共享（严格限制：只放真正通用的工具）
│   ├── tenant.ts                   #   租户上下文解析
│   ├── event-bus.ts                #   进程内事件总线（pub/sub，未来可替换为消息队列）
│   └── errors.ts                   #   共享错误类型
├── app.ts                          # Fastify 应用工厂（注册模块而非路由）
└── index.ts                        # 入口
```

### 核心规则

| 规则 | 说明 |
|---|---|
| **模块自管仓储** | 每个 `modules/*/index.ts` 内部实例化该模块需要的仓储，不引用全局容器 |
| **路由函数签名** | `routes.ts` 中的导出函数接收**该模块专属的仓储实例**，而非 `RepoContainer` |
| **shared 严格受限** | `shared/` 只放跨 2 个以上模块的通用工具。禁止将业务逻辑放入 shared |
| **跨模块通信** | 通过 `shared/event-bus.ts` 的进程内 pub/sub；直接函数调用仅限 `shared/` 中的纯工具函数 |
| **单一数据库** | 仍是一个 SQLite/PostgreSQL 实例，通过表前缀（`conversation_*`、`learning_*` 等）做逻辑分区 |
| **对外入口唯一** | 每个模块只有 `index.ts` 是对外可见的。`routes.ts` 内部的函数不被其他模块引用 |

### 模块 index.ts 示例

```typescript
// src/modules/conversation/index.ts
import { SqliteConversationRepository } from "@aervox/database";
import { registerConversationRoutes } from "./routes.js";
import type { FastifyInstance } from "fastify";
import type { AervoxDatabase } from "@aervox/database";

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
  // 如需触发其他模块操作，通过 eventBus.publish("conversation.created", payload)
}
```

### 事件总线示例

```typescript
// src/shared/event-bus.ts
type DomainEvent = { type: string; payload: unknown; occurredAt: string };

type EventHandler = (event: DomainEvent) => void;

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  subscribe(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
    return () => this.handlers.get(eventType)?.delete(handler);
  }

  publish(eventType: string, payload: unknown): void {
    const handlers = this.handlers.get(eventType);
    if (!handlers) return;
    const event: DomainEvent = {
      type: eventType,
      payload,
      occurredAt: new Date().toISOString(),
    };
    for (const handler of handlers) {
      handler(event);
    }
  }
}

export const eventBus = new EventBus();
```

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

当某模块满足拆分条件时，只需：

1. 将该模块的 `index.ts` 改为创建独立 Fastify 实例 + HTTP 服务；
2. 将 `eventBus.publish` 替换为消息队列（NATS/Redis Streams）的发布调用；
3. 将消费方的 `eventBus.subscribe` 替换为消息队列订阅；
4. 其他模块的 `index.ts` 中调用改为 HTTP 客户端调用。

无需修改 `routes.ts` 的业务逻辑代码。

## Positive consequences

- **代码层面的模块边界**：路由函数签名静态限制了可用仓储范围，ESLint import 规则可以进一步强制；
- **降低认知负荷**：每个模块的开发/修改只需关注 2~3 个文件（routes.ts + index.ts + shared 引用），不需要理解全局；
- **演进成本低**：未来拆分单个模块为独立服务时，业务逻辑代码零改动；
- **与 Worker 层对齐**：Worker 中的 Memory/Diary/Notification 处理天然是按模块组织的，API 层采用相同的模块化结构后，两端领域边界一致。

## Negative consequences and risks

- **初期多一层间接**：每个模块多了一个 `index.ts` 文件，对 8 个小模块来说略显冗余；
- **事件总线需维护**：进程内 EventBus 虽然简单，但需要确保所有模块都用它而非直接调用，防止隐式耦合；
- **与 ADR-001 的 Worker 层协作需对齐**：当前 Worker 层尚未模块化，后续需同步演进。

## Migration / rollback

迁移步骤（一次性，预计 1~2 小时）：

1. 创建 `modules/`、`shared/` 目录；
2. 逐模块迁移：将 `routes/*.ts` 移到 `modules/*/routes.ts`，改写函数签名为接收单一仓储；
3. 为每个模块创建 `index.ts`（包含仓储实例化和路由注册）；
4. 创建 `shared/tenant.ts`（从根目录迁移）、`shared/event-bus.ts`、`shared/errors.ts`；
5. 重构 `app.ts`，替换路由注册为模块注册；
6. 删除 `container.ts`；
7. 验证 `pnpm build` + `pnpm typecheck` + `pnpm test` 全部通过。

回滚：Git 历史回溯到变更前的 commit，恢复原 `routes/`、`container.ts`、`tenant.ts` 结构。

## Verification evidence

- [x] `pnpm build`：TypeScript 编译无错误（2026-08-31 `ci-code` 全量通过）；
- [x] `pnpm typecheck`：类型检查零 warning（2026-08-31 `ci-code` 全量通过）；
- [x] `pnpm test`：集成测试全部通过（2026-08-31 复核；同日登记修复的 diary `todayWindow` 时区缺陷与本文结构证据无关）；
- [x] `mise tasks run ci-docs`：文档 lint 0 issue（2026-08-31 全仓文档元数据清账后 0 warning）；
- [x] 依赖边界机器校验：`node scripts/import-boundary.mjs` 零违规（5 条规则，常驻 `ci-code` 的 `check:boundary`；模块 `routes.ts` 不得 import 其他模块仓储由 AST 规则强制）。

五项证据均为常驻 CI 门禁而非一次性演练：`modules/*` 自管仓储与边界规则已固化于每日门禁，结构回退会被 CI 拦截。2026-08-31 决策状态置为 `Accepted`（ADR 索引与架构摘要表同步）。
