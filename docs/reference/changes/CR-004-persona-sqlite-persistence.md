# CR-004 人格插件 SQLite 持久化（复用主仓 @aervox/database）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-26

- 状态：Proposed
- 提出人 / 日期：KashiwagiEri233 / 2026-08-25
- 目标版本：当前开发阶段（MVP 前，本地开发 / 集成测试优先）
- 关联：`CAP-019`、`CAP-020`、`CR-003`、`ADR-003`、`AVX-MOD-001`、`AVX-DB-001`

## 变更原因与证据

`modules/persona-plugin`（`@aervox/mod-persona`）此前仅提供内存仓储，重启即丢失；主项目已按 `CR-003`
落地 SQLite 业务真源（`@aervox/database` + Drizzle + Repository Port）。人格/Skills/MCP 属于可选功能但同样需要
持久化，应按同一数据库契约接入，而不是在模块内自建 SQLite 旁路。

## 当前行为 / 目标行为

- 当前：人格模块使用 `InMemoryPersonaRepository` / `InMemorySkillRegistry` / `InMemoryMcpRegistry`，API 未接入。
- 目标：
  - 主仓 `@aervox/database` 新增 6 张表：`personas`、`persona_revisions`、`persona_selections`、`workspace_skills`、`mcp_tools`、`persona_turn_contexts`；
  - 新增 `IPersonaRepository` / `ISkillRepository` / `IMcpToolRepository` 与 SQLite 实现；
  - 模块 `@aervox/mod-persona` 定义异步领域 Port（`PersonaRepository` / `SkillRepository` / `McpToolRepository`）并保留内存实现供测试；
  - `apps/api` 新增 persona 模块：CRUD/激活/导出导入/Skills/MCP/语音，通过适配器连接 SQLite 仓储与模块 Port；
  - 模块内 `importPersonaBundle` 承担导入编排（预览 → Skills 入库 → 创建人格）。

## 范围外

- 不改变模块对“可选功能”的定位；不把人格数据写入权下沉到模块；
- 不导出 MCP 凭据、GPT-SoVITS 权重或用户业务正文；
- 不实现人格记忆隔离/共享（后续单独扩展 CAP-019）。

## 迁移与向后兼容

新增表全部 `CREATE TABLE IF NOT EXISTS`；已有 SQLite 库自动建表，无破坏性迁移。模块接口由同步改为异步 Port，
仅影响主仓 API 适配层与模块测试，不改变对外 HTTP 契约语义。

## 测试、埋点和验收影响

- `packages/database/test/persona-domains.test.ts`：CRUD、修订 CAS、激活、Skills/MCP/上下文快照与租户隔离；
- `apps/api/test/persona-api.test.ts`：创建/激活/导入导出 Bundle/Skills/语音降级；
- `pnpm build` / `pnpm typecheck` / `pnpm test` 全绿。

## 决策

- 修改人 / 日期：
