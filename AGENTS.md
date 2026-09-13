# AGENTS.md — AI 协作指南（薄入口）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-13

本文件是所有 AI 编码助手（包括 Antigravity、Claude Code、Cursor、GitHub Copilot、Roo Code、Windsurf 等）的进入点与协作底线协议：
**只索引，不复制**：权威技术规范、产品定义与架构事实源一律深链至 `docs/`，严禁在入口复制可能变更的业务逻辑，杜绝双源漂移。
详细协作指南见 [从哪开始](docs/getting-started.md)（新成员与 Agent 完整 onboarding）、[文档治理规范](docs/reference/document-governance.md) 与 [文档写作规范](docs/reference/standards/doc-standards.md)。

---

## 1. 这是什么仓库（架构现状速览）

Aervox｜思隅：更好上手的“主动智能” Agent——以桌宠为入口，视觉小说 + 工作台双形态交互，承载陪伴与学习双重任务。

- **技术族**：TypeScript 全栈 monorepo（Vue 全栈单栈，[ADR-015](docs/reference/adr/ADR-015-vue-full-stack.md)）：Fastify 5 API（:3000）+ 独立 Worker 进程（Outbox / 复习排期 / 日记提炼 / 证据清理）+ Electron 桌面端（Fairy）+ Vue 3 Web 工作台（:5173）。
- **存储真源**：纯本地单用户真源（[CR-030](docs/reference/changes/CR-030-pure-local-sqlite-database.md)），永久本地 SQLite (WAL 模式) 单库存储。去租户化已完全落地，全面移除了历史 Postgres、Redis、BullMQ 和 S3 依赖。

---

## 2. AI 必读与寻路顺序（按需取读，不必通读）

在执行具体任务前，请按需顺着权威事实源树状深入，严禁仅凭猜测进行编码或修改：

1. **宏观上下文与目录全景**：
   - [docs/README.md](docs/README.md) — 8 大主题域分类索引与事实源权威顺序；
   - [从哪开始](docs/getting-started.md) — 仓库目录组织、阅读流向、写作硬规则与 Docs CI 自检。
2. **规范、契约与红线**：
   - [文档治理与事实源规范](docs/reference/document-governance.md) — 事实源矩阵、文档状态模型、所有权与复核触发器；
   - [文档写作规范](docs/reference/standards/doc-standards.md) — Diátaxis 四分类、Front Matter 规范、点阵签名与 Markdownlint 规则；
   - [术语表](docs/reference/standards/terminology.md) — 大小写规范与禁写词库（Vale 门禁基准）。
3. **架构与业务核心真源**：
   - [架构设计说明书](docs/reference/ARCHITECTURE.md) & [ADR 决策索引](docs/reference/adr/README.md) — 模块化单体边界、C4 模型与关键技术裁决；
   - [产品需求 PRD](docs/reference/PRD.md) & [能力注册表](docs/reference/capability-registry.md) — 业务功能定义与 CAP 能力验收准则；
   - [SQLite 数据库契约](docs/reference/DATABASE.md) — 数据模型拓扑、仓储层职责与变更流程；
   - [需求追踪与交付标准](docs/reference/REQUIREMENTS_TRACEABILITY.md) — CAP 覆盖矩阵与落地登记。
4. **高频实战操作指南**（遇到具体开发流转时查阅）：
   - [提出与闭环 CR 指南](docs/how-to/cr-workflow.md) (`AVX-GUIDE-005`) — 针对架构性改动的变更流程；
   - [SQLite 换库与回滚演练](docs/how-to/run-database-migration-drill.md) (`AVX-GUIDE-006`) — 数据库破坏性迁移演练；
   - [新增 CAP 业务能力](docs/how-to/add-capability.md) (`AVX-GUIDE-007`) — 端到端立项与规格化新业务能力。

---

## 3. 硬性开发约束（违反即打回）

以下规则为全仓库不可妥协的硬约束，任何违反都会在自动化门禁或人工 Code Review 中被直接拒绝：

- **工具链唯一真源**：工具版本以 [mise.toml](mise.toml) 为唯一真源（Node 24 / pnpm 11 / Vale 3.18）。严禁使用系统全局不受控的 Node 执行 `.ts` 脚本，统一运行 `./aervox <cmd>` 或 `mise exec -- <cmd>`。
- **纯本地单用户数据隔离**：CR-030 已全面去租户化。严禁在代码或契约中引入 `tenantId`、`TenantContext` 等多租户隔离概念，统一使用本地上下文 `LocalContext`。
- **SQLite / LibSQL 事务与读写一致性**：
  - 所有数据写入操作必须通过“写者连接”执行；
  - 由于 SQLite WAL 模式的快照隔离特性，事务提交后其它连接存在读快照滞后，测试用例断言必须使用写者连接自身；
  - 事务内严禁嵌套，严禁在事务内执行耗时 I/O 或长时间持锁；libsql 0.4.x 事务在 BEGIN 阶段不会自动重试（详见 [ADR-003](docs/reference/adr/ADR-003-postgres-retrieval.md) 与 `packages/repositories`）。
- **统一依赖治理**：新增依赖一律在根目录执行 `pnpm add -w <pkg>`（开发依赖 `-Dw`），严禁进入各个子包目录单独安装，坚决防止依赖版本分裂与幽灵依赖。
- **中间件与异步流**：Fastify 路由与中间件一律采用 `async/await`，严禁使用回调函数；中间件重构期间禁止随意修改路由文件。
- **OpenAPI 契约生成规范**：`zod-to-openapi` 固定版本为 v9，统一使用 `OpenApiGeneratorV31`（禁止使用 `generateDocument`）；在定义任何 Zod schema 之前，必须确保已调用 `extendZodWithOpenApi(z)`，否则 `.openapi()` 元数据注入失效。
- **文档签名与元数据维护（强制）**：
  - 每次修改任何 Markdown 文档或根层入口文件，**必须同步更新标题下第一位置的修改人点阵签名**：`- 修改人：<账号> · <日期>`（严禁只改内容不动签名，见 [文档写作规范 §2](docs/reference/standards/doc-standards.md#2-文档头元数据)）；
  - `docs/` 下受治文档必须采用 canonical YAML front matter，且同步更新 `updated_at` 与 `reviewed_at`；
  - 结构性变更（增删文档、路径迁移、编号变更）须同步 [DOC_REGISTRY.md](docs/DOC_REGISTRY.md) 与 [docs/README.md](docs/README.md)；日常修改可直接运行 `mise tasks run docs-sync` 自动对齐注册表日期。
- **Markdownlint 与 Vale 排版红线**：
  - 在列表项内书写代码块（Code Fence）时，代码块前后**必须各保留一行空行**，否则会触发 MD031 / MD032 语法门禁中断；
  - 正文散文中严禁使用全小写专有名词（如 `sqlite`、`vue`、`electron`、`fastify`、`zod` 等），必须严格使用规范大小写（如 `SQLite`、`Vue`、`Electron`）或用反引号包裹代码标识符（见 [术语表](docs/reference/standards/terminology.md)）。
- **代码与文档联动复核**：
  - 修改核心代码时，可运行 `mise tasks run docs-triggers` 检查是否命中相关受治文档的 `review_triggers`，评估是否需联动更新文档。
- **落地实现登记（闭环铁律）**：
  - 一切落地改动必须在 [落地追踪基线 §4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 登记完成情况（关联 CAP、实现位置、日期、验证方式），未登记者视为未闭环；
  - 借鉴参考项目（`T-*` / `AST-*` / `PET-*` / `DSH-01` / `PI-01`）需在“来源”列注明编号，并遵循开源版权声明（见 PRD §15.1）。
- **Git 功能分支工作流**：
  - 严禁直接向 `main` 分支提交或推送代码；
  - 所有变更必须按 `feat/`、`fix/`、`docs/` 前缀创建功能分支，提交前本地通过双门禁，经由 Pull Request 审查后合入 `main`。

---

## 4. AI 常用命令与工具箱速查

| 场景 | 推荐命令 | 说明 |
| ---------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 完整门禁自检 | `./aervox ci` | 本地双门禁：同时执行代码门禁与文档门禁 |
| 代码门禁 | `mise tasks run ci-code` | 依赖锁定安装 + 依赖边界检查 + 构建 + 类型检查 + 测试 |
| 文档门禁 | `mise tasks run ci-docs` | Markdownlint + Vale 术语检查 + 文档治理严格校验 |
| 单测调试 | `mise x -- pnpm test` | 在受控 mise 环境下执行 Vitest 单元测试 |
| 格式化修复 | `npx markdownlint-cli2 --fix <files>` | 自动修复 Markdownlint 可自愈的排版问题 |
| 术语检查 | `vale --minAlertLevel=error <files>` | 针对指定文件执行 Vale 散文与术语一致性检查 |
| 注册表自动同步 | `mise tasks run docs-sync` | 自动从文档 Front Matter 读取日期并回写 `docs/DOC_REGISTRY.md` |
| 机器目录生成 | `mise tasks run docs-catalog` | 重新生成标准化全量元数据 `docs/_meta/document-catalog.json` |
| 变更触发器排查 | `mise tasks run docs-triggers` | 比对 Git 改动与各文档触发规则，排查待联动复核文档 |
| 清理工作区 | `./aervox clean` | 清理编译产物与 Turborepo 缓存（保留 node_modules） |

---

## 5. 需要介入时的处理路径

在协作过程中若遇到以下情况，请遵循 [从哪开始 §5](docs/getting-started.md#5-需要介入时) 标准升级流程：

- **文档冲突 / 架构分歧**：若两份权威文档产生矛盾，以 `PRD.md`（业务范围）与 `ARCHITECTURE.md`（架构技术选型）为优先事实源，并向维护者提出澄清；
- **重大设计变更**：如需推翻或修正已批准的 ADR / 架构基线，必须先建立 `CR-###` 变更提案（遵循 [CR 工作流指南](docs/how-to/cr-workflow.md) 与 [追踪基线 §11](docs/reference/REQUIREMENTS_TRACEABILITY.md#11-变更控制)），禁止在未经评审的日常分支中直接更改架构核心。
