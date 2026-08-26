# AGENTS.md — AI 协作指南（薄入口）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-26

本文件是 AI 编码 Agent 的进入点：只索引、不复制，权威内容一律深链至 `docs/`，避免双源漂移。详细规则见 [从哪开始](docs/getting-started.md)（面向新成员或 Agent 的完整 onboarding）与[文档写作规范](docs/reference/standards/doc-standards.md)。

## 这是什么仓库

Aervox｜思隅：更好上手的"主动智能" Agent——以桌宠为入口，视觉小说 + 工作台双形态交互，承载陪伴与学习双重任务。TypeScript 全栈 monorepo（Vue 全栈单栈，ADR-015）：Fastify API（:3000）+ Worker（Outbox / 复习 / 日记 / 删除）+ 桌面端 / Web + SQLite 真源（PostgreSQL 双引擎切换规划中，CR-003）。

## 必读顺序（按需取读，不必通读）

1. [docs/README.md](docs/README.md) — 文档索引、权威顺序与冲突处理；
2. [从哪开始](docs/getting-started.md) — 仓库结构、阅读顺序、写作硬规则与 Docs CI 自检（完整 onboarding）；
3. [教程：构建并运行第一个对话](docs/tutorials/first-conversation.md)；
4. [文档写作规范](docs/reference/standards/doc-standards.md)（Diátaxis 四分类、文档头 schema、Vale 门禁）与[术语表](docs/reference/standards/terminology.md)；
5. 按需深入：PRD / 架构与 ADR / 契约（流式协议·数据库）。

## 硬约束（违反即打回）

- 工具版本以 [mise.toml](mise.toml) 为唯一真源（node 24 / pnpm / vale）；不要用系统自带 Node 跑 `.ts` 脚本，统一 `mise x -- <cmd>`；
- 中间件一律 async/await、不用回调式；路由文件在中间件重构期间不许改动；
- 依赖安装：新增依赖统一 `pnpm add -w <pkg>`（开发依赖 `-Dw`）装到根 workspace，禁止子包单独加依赖造成版本分裂；
- SQLite/libsql 事务与读一致：写操作走写者连接；事务提交后其它连接存在读快照滞后，测试断言须用写者连接自身；事务内不嵌套、不长时间持锁；libsql 0.4.x 事务 BEGIN 阶段不会自动重试（详见 [ADR-003](docs/reference/adr/ADR-003-postgres-retrieval.md) 与 `packages/database`）；
- OpenAPI 契约：`zod-to-openapi` 固定 v9，用 `OpenApiGeneratorV31` 而非 `generateDocument`；`extendZodWithOpenApi` 必须在任何 schema 定义前调用，否则 `.openapi()` 不可用（生成逻辑在 `packages/contracts`）；
- 修改文档前先读[文档写作规范](docs/reference/standards/doc-standards.md)：标注 `类型` 与文档头字段，并在标题下第一位置维护 `- 提出人：<账号> · <日期>` / `- 修改人：<账号> · <日期>` 点阵签名；每次改动文档必须更新 `修改人` 账号与日期（提出人填首次建立者，修改人填最近变更者），禁止只改内容不动签名（见[文档写作规范 §2](docs/reference/standards/doc-standards.md#2-文档头元数据)）。仅结构性改动（新增文档、目录迁移、编号/类型/事实源变更）须同步 [DOC_REGISTRY.md](docs/DOC_REGISTRY.md) 与[文档索引](docs/README.md)，编辑性/内容更新只过 ci-docs 并更新核验日期（登记强度见[改动等级 §3.1](docs/reference/standards/doc-standards.md#31-改动等级与同步要求)）；
- 术语唯一：以术语表「规范写法」为准；提交文档前跑 `mise tasks run ci-docs`（markdownlint + Vale，链接检查在 CI）；
- 代码门禁：`mise tasks run ci-code`（install + build + typecheck + test）；
- 文档目录即类型：`tutorials/` `how-to/` `explanation/` `reference/`（含 `adr/ changes/ standards/ diagrams/`），根层只放索引与登记表；
- 变更一律走功能分支 + PR 合入 `main`，禁止直接向 `main` 推送或提交：分支按 `feat/` `fix/` `docs/` 命名；推送前本地过对应门禁（`ci-code` / `ci-docs`）；PR 描述须引用落地登记（见下条）；
- 一切落地改动必须在[落地追踪基线 §4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)登记完成情况（关联 CAP、实现位置、日期、验证方式），未登记视为未闭环、提交打回：
  - 借鉴参考项目（`T-*` / `AST-*` / `PET-*`）：`来源` 列标注参考编号（查询指引见[参考设计迁移文档 §6.1](docs/explanation/reference-design-transfer.md#61-落地登记唯一真源)；第三方代码须记录来源与版权声明，见 PRD §15.1）；
  - 原生功能/基础设施：登记关联 CAP、实现位置、日期与验证方式；
  - 结项以对应登记表为准。

## 常用命令

```bash
./aervox setup            # mise 工具链 + 依赖安装
./aervox dev              # 全栈：API(:3000) + Web(:5173) + Desktop + Worker
./aervox ci               # 本地双门禁：ci-code + ci-docs
mise tasks run ci-docs    # 改动 docs/** README.md AGENTS.md 后必跑
mise x -- pnpm test       # 测试（在 mise 环境内执行）
```

## 需要介入时

文档冲突 / 生产问题 / 变更请求的处理路径见 [从哪开始 §5](docs/getting-started.md#5-需要介入时)；修改已批准文档先建 `CR-*`（见 [追踪基线 §11](docs/reference/REQUIREMENTS_TRACEABILITY.md#11-变更控制)）。
