---
id: AVX-STD-002
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.1.0
updated_at: 2026-09-17
reviewed_at: 2026-09-17
review_interval_days: 90
---

# 代码与 API 命名规范（Naming Conventions）

- 提出人：3yearszhuang · 2026-09-16
- 修改人：3yearszhuang · 2026-09-17

关联：[文档写作规范](doc-standards.md)（AVX-STD-001）、[术语表](terminology.md)、[产品需求 PRD](../PRD.md) §14.2、[演进式模块化单体架构](../adr/ADR-014-modular-monolith-structure.md)、SQLite 本地单用户去租户化（已归档）

本规范固化 Aervox 代码与 OpenAPI 事实层面的统一命名约定，消除历史残留并作为新增代码的强制门禁。变更一律走 CR/ADR 流程，新增命名规则须先登记再落地，禁止在功能分支里引入第三套约定。

## 1. 上下文与状态对象命名

CR-030 已去租户化，上层统一使用本地上下文 `LocalContext`，**禁止**再引入 `tenant`/`TenantContext`/`tenantId` 等名义（含变量名、参数名、字段名）：

| 约定 | 说明 | 允许 |
|---|---|---|
| 函数参数携带上下文 | 签名首参 `ctx: LocalContext`，函数体内引用统一 `ctx` | `ctx` |
| 局部上下文常量 | `const ctx: LocalContext = { workspaceId: "local", subjectUserId: "local" }` | `ctx` |
| 历史残留 | `tenant` 作为参数名/局部变量（类型已为 `LocalContext`）属于待清理残留 | 清理为 `ctx` |
| 保留场景 | 迁移/审计文本中描述**旧库结构**的字符串、注释与 `listByTenant` 之类既有方法名 | 原文不动，随演进另行处理 |

判定基准：凡是承载 `LocalContext` 的绑定一律命名 `ctx`；承载其它语义（如数据库 client、执行快照）不使用 `ctx`，避免语义混用。

## 2. TypeScript 标识符与文件分层

- **变量/函数**：`camelCase`；**类/接口/类型**：`PascalCase`；**常量宏**：`UPPER_SNAKE_CASE`；模块内部私有函数不加 `_` 前缀。
- **模型与输入类型**：仓储模型以 `Model` 结尾（`MemoryRecordModel`），输入以 `Input` 结尾（`SubagentRunCreateInput`），Port 接口不写 `I` 前缀（`MemoryRepository`，不是 `IMemoryRepository`）。
- **文件命名**：路由 `routes.ts`、模块入口 `index.ts`（见 ADR-014）；同领域多个 worker 文件按领域前缀分组收拢进子目录后**去重复前缀**（`apps/worker/src/proactive/*`）。
- **Repository Port 边界**：仓储接口与 `LocalContext` 类型一律来自 `@aervox/repositories`；禁止在 schema 层声明业务 Port。

## 3. API 路由与 HTTP 语义

对现有 80+ 端点盘点后，事实层已经统一，本规范将其固化为强制标准：

| 语义 | 约定 | 示例 |
|---|---|---|
| 资源名 | **复数 kebab-case** | `/v1/sessions`、`/v1/diaries`、`/v1/study-materials` |
| 集合读取 | `GET /v1/资源`，分页走 query | `GET /v1/sessions?limit=&cursor=` |
| 单资源读取 | `GET /v1/资源/:id` | `GET /v1/sessions/:id` |
| 创建 | `POST /v1/资源` → `201` + `Location`；幂等键 `X-Idempotency-Key` | `POST /v1/memories` |
| 局部更新 | `PATCH /v1/资源/:id` | `PATCH /v1/diaries/:id` |
| 删除 | `DELETE /v1/资源/:id` → `204` | `DELETE /v1/memories/:id` |
| 动作端点 | `POST /v1/资源/:id/动词`（不落到 `:/动作名` 查询参数） | `/v1/sessions/:id/attempts`、`/v1/reviews/:id/completions` |
| 嵌套子资源 | `POST /v1/:父资源/:父Id/子资源` | `/v1/projects/:projectId/materials` |
| 任务型异步 | `202` + `Location` 轮询 | 附件/异步生成 |
| 版本前缀 | `/v1` 统一版本前缀，契约变更先升版 | `/v1/...` |

- 路由文件按模块挂在 `apps/api/src/modules/*/routes.ts`，每个模块 `index.ts` 注册（ADR-014）；跨模块事件进进程内总线，不直接 import 对方仓储。
- 契约 schema 由 `zod-to-openapi` v9 + `OpenApiGeneratorV31` 生成后统一提交 `@aervox/contracts`。

## 4. 包名与目录组织

- **包名**：内部包一律 `@aervox/*`，目录用 kebab-case（`packages/practice-review`）；包清单与演进意图以 `PRD §14.2` 为唯一事实源，**实际包列表以 `packages/*` 为准**，两者出现分歧时先修订 PRD 再动包。
- **Monorepo 分层**：`apps/*`（部署单元）与 `packages/*`（可复用包）分离；`scripts/` 只放被 CI/工具链引用的脚本；`docs/` 按 Diátaxis 归属（doc-standards §1）。
- **依赖方向**：`packages/schema` → `packages/repositories` → `apps/*`；禁止反向依赖或 `apps` 间平级互引。
- **临时/生成物**：生成代码与签入物（OpenAPI、Catalog）与手写代码分目录存放，生成来源标注在头部注释；无主零引用文件不得滞留仓库根层。

## 5. 禁止项与术语开关

- **多租户词汇**：`tenant`、`TenantContext`、`organization` 等租户语义在业务代码里禁止出现（见 §1）；`LocalContext` 是唯一上下文形态。
- **已拆包名**：`@aervox/database` 已拆分为 `@aervox/schema` + `@aervox/repositories`，头注释与文档不得再引用旧包名。
- **缩写与大小写**：`SQLite`、`Node.js`、`TypeScript`、`Vue`、`Electron`、`Fastify` 等专有名词按[术语表](terminology.md)大小写书写，禁用全小写正文形态。

## 6. 门禁与校验

- 新增/修改代码提交前本地过 `ci-code` 与 `ci-docs`；路由与 OpenAPI 变更必须同步 `packages/contracts` schema 并重新生成契约文档。
- 全仓抽样命令：`rg "\btenant\b" packages apps`（期望命中仅剩注释/字符串/历史方法名）、`rg "@aervox/database"`（期望零命中）。
- 新增命名规则必须先更新本文档（升版 + 修改人签名 + 注册表核验）再落地实现，防止规则先行、实现滞后。
