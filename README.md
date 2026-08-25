# Aervox｜思隅（伴学桌宠）

面向编程初学者的 AI 陪伴式学习产品。本仓库承载产品定义、工程规范与契约种子。

## 文档入口

- [文档索引](docs/README.md)：文档体系、权威顺序、`从哪开始`（§8）· [文档生命周期登记表](docs/DOC_REGISTRY.md)
- [产品需求 PRD](docs/PRD.md)：为什么做、为谁做、全生命周期做什么（AVX-PRD-001）
- [架构设计](docs/ARCHITECTURE.md) · [ADR](docs/architecture/adr/README.md) · [SRS](docs/requirements/SRS.md)
- [可选功能模块化方案](docs/architecture/optional_modules.md)：非核心功能以子仓库开发 + workspace 自选消费（AVX-MOD-001）
- [需求追踪与交付基线](docs/REQUIREMENTS_TRACEABILITY.md)：CAP 状态、DoR、G0~G6 门禁
- [操作指南](docs/how-to/)

## 工程骨架

- pnpm + Turborepo monorepo（`apps/*`、`packages/*`）；Node 24 / pnpm 11 由 [mise.toml](mise.toml) 统一管理
- `apps/api`：Fastify `/v1/` API，按领域模块组织（会话、学习目标、题目作答、日记等 8 个 `modules/*`，自管仓储 + 进程内事件总线，见 ADR-014）
- `apps/desktop`：Electron + Vue 桌面端（Fairy）——renderer 经受限 preload IPC 桥接，由主进程调用 `@aervox/api`（见 [apps/desktop/README.md](apps/desktop/README.md)）
- `apps/worker`：后台任务进程（tsx，待接入调度/日记作业）
- `packages/contracts`：Zod 契约事实源（Turn/SSE 流式协议 + 学习域请求体），OpenAPI 3.1 由此生成（[STREAMING_PROTOCOL](docs/contracts/STREAMING_PROTOCOL.md)）
- `packages/database`：SQLite 业务真源 + 仓储/向量检索 Port 抽象，含租户隔离与 Postgres 兼容规划（[数据库设计与双引擎契约 AVX-DB-001](docs/contracts/DATABASE.md)）
- `packages/practice-review`：练习复习排期（CAP-006 间隔重复 MVP 调度）
- 参考仓库 `reference/`（固定 commit 子模块，仅作设计验证）：deepseek-harness / pi / baishou-next / dsh-synapse

## 快速开始

```bash
pnpm install                      # 安装（frozen lockfile）
pnpm build && pnpm typecheck && pnpm test   # 代码门禁
pnpm dev:desktop                  # 同时启动 API 与桌面端（需先配置 AERVOX_API_URL / AERVOX_SESSION_ID，见 apps/desktop/README.md）
```

或使用 mise 统一任务：`mise tasks run ci-code`（install + build + typecheck + test）、`mise tasks run ci-docs`（markdown lint）。

## 当前状态

- P0（CAP-001~013）需求已 `Specified` 并进入 DoR 评估；
- 工程骨架可构建，首批实现已落地：API 域路由与 SQLite 真源/仓储（[AVX-DB-001](docs/contracts/DATABASE.md)）、Fairy 桌面端（Electron IPC 桥接）、学习域契约层、间隔重复调度（`packages/practice-review`）；
- 详见 [docs/README](docs/README.md) 与需求追踪（[REQUIREMENTS_TRACEABILITY](docs/REQUIREMENTS_TRACEABILITY.md)）。

## CI 门禁

- **文档**（改动 `docs/**`、`README.md`、`.markdownlint-cli2.jsonc` 或 `mise.toml`）：markdown lint + 链接检查（[docs.yml](.github/workflows/docs.yml)）
- **代码**（改动 `apps/**`、`packages/**`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json` 或 `mise.toml`）：mise 安装后执行 build + typecheck + test（[ci.yml](.github/workflows/ci.yml) → `mise tasks run ci-code`）

## License

This project is licensed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International Public License. See the [LICENSE](./LICENSE) file for details.

本项目采用 Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International Public License（CC BY-NC-SA 4.0）许可。详见 [LICENSE](./LICENSE) 文件。
