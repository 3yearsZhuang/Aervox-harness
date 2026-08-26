# AGENTS.md — AI 协作指南（薄入口）

本文件是 AI 编码 Agent 的进入点：只索引、不复制，权威内容一律深链至 `docs/`，避免双源漂移。详细规则见 [docs/README.md §8 从哪开始](docs/README.md)（面向新成员或 Agent 的完整 onboarding）与[文档写作规范](docs/reference/standards/doc-standards.md)。

## 这是什么仓库

Aervox｜思隅：面向编程初学者的 AI 陪伴学习桌宠。TypeScript 全栈 monorepo（Vue 全栈单栈，见 ADR-015）：API（:3000，Fastify 模块化单体）+ Worker（Outbox/复习提醒/日记/删除）+ 桌面端/Web + SQLite 业务真源（PostgreSQL 双引擎切换规划中，CR-003）。

## 必读顺序（按需取读，不必通读全文）

1. [docs/README.md](docs/README.md) — 文档索引、权威顺序与冲突处理；§8 从哪开始是完整 onboarding；
2. [教程：构建并运行第一个对话](docs/tutorials/first-conversation.md)；
3. [文档写作规范](docs/reference/standards/doc-standards.md)（目录=Diátaxis 四分类、文档头 schema、命名、Vale 门禁）与[术语表](docs/reference/standards/terminology.md)；
4. 按需深入：PRD / 架构与 ADR / 契约（流式协议·数据库）。

## 硬约束（违反即打回）

- 工具版本以 [mise.toml](mise.toml) 为唯一真源（node 24 / pnpm / vale）；不要用系统自带 Node 跑 `.ts` 脚本，统一 `mise x -- <cmd>`；
- 中间件一律 async/await、不用回调式；路由文件在中间件重构期间不许改动；
- 修改文档前先读文档写作规范：标注 `类型` 与文档头字段，改完同步 [DOC_REGISTRY.md](docs/DOC_REGISTRY.md) 与 [文档索引](docs/README.md)；
- 术语唯一：以术语表「规范写法」列为准，提交文档前须 `mise tasks run ci-docs`（markdownlint + Vale，链接检查在 CI）；
- 代码 CI 门禁：`mise tasks run ci-code`（install + build + typecheck + test）；
- 文档目录即类型：`tutorials/` `how-to/` `explanation/` `reference/`（含 `adr/ changes/ standards/ diagrams/`），根层只放索引与登记表；
- 借鉴参考项目（`T-*` / `AST-*` / `PET-*`）落地的改动必须闭环到[参考设计迁移文档](docs/explanation/reference-design-transfer.md#61-已落地进度总表)：在 §6.1「已落地进度总表」登记实现位置与日期（含第三方代码需记录来源与版权声明，见 PRD §15.1）。未登记的改动视为未闭环、提交打回；改文档的结项以该总表为准。

## 常用命令

```bash
./aervox setup            # mise 工具链 + 依赖安装
./aervox dev              # 全栈：API(:3000) + Web(:5173) + Desktop + Worker
./aervox ci               # 本地双门禁：ci-code + ci-docs
mise tasks run ci-docs    # 改动 docs/** README.md AGENTS.md 后必跑
mise x -- pnpm test       # 测试（在 mise 环境内执行）
```

## 需要介入时

文档冲突 / 生产问题 / 变更请求的处理路径见 [docs/README.md §8](docs/README.md#8-从哪开始)；修改已批准文档先建 `CR-*`（见 [追踪基线 §11](docs/reference/REQUIREMENTS_TRACEABILITY.md#11-变更控制)）。
