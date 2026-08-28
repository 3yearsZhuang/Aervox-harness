# Aervox｜思隅

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-28

更好上手的"主动智能" Agent：以桌宠为入口，视觉小说 + 工作台双形态交互，承载陪伴与学习双重任务。本仓库承载产品定义、工程规范与契约种子，代码以 TypeScript 全栈交付。

## 快速开始

环境要求：Node 24 / pnpm 11（由 [mise.toml](mise.toml) 锁定），首次进入仓库执行一次安装：

```bash
./aervox setup       # 前置：mise 工具链 + 依赖安装（lockfile 一致时自动跳过）
```

一条命令启动开发服务，及其变体：

```bash
./aervox dev             # 全栈：API(:3000) + Web(:5173) + Desktop(Electron) + Worker
./aervox dev web         # 仅 API + Web（desktop / worker / api 同理）
./aervox mobile          # 构建 Web 产物并同步 Capacitor 移动壳
./aervox ci              # 本地门禁：ci-code（install+build+typecheck+test）+ ci-docs（markdown lint + Vale + 链接检查）
./aervox clean           # 清理构建产物（保留 node_modules）
./aervox help            # 命令与环境变量速查
```

底层等价命令（供 CI 与脚本直接使用）：

| 命令                                          | 说明                                                  |
| ------------------------------------------- | --------------------------------------------------- |
| `pnpm install`                              | 安装依赖（frozen lockfile）                               |
| `pnpm build && pnpm typecheck && pnpm test` | 代码门禁                                                |
| `pnpm dev:web`                              | API + Web（开发用）                                      |
| `pnpm dev:desktop`                          | API + 桌面端（需 `AERVOX_API_URL` / `AERVOX_SESSION_ID`） |
| `mise tasks run ci-code` / `ci-docs`        | 分别等同 `aervox ci` 的代码门禁 / 文档门禁                       |
| `mise tasks run docs-lint-prose`            | Vale 术语与散文检查（`ci-docs` 的组成部分）                       |

## 架构与技术栈

演进式模块化单体（ADR-001/014）+ Vue 全栈单栈（ADR-015）：桌面/Web/移动端共享契约与技术族。详细设计见 [架构设计](docs/reference/ARCHITECTURE.md)（C4、数据所有权、可靠性、安全）与 [ADR](docs/reference/adr/README.md)。

| 层     | 选型                                                                                 |
| ----- | ---------------------------------------------------------------------------------- |
| 语言/工程 | TypeScript、pnpm + Turborepo、Node 24（mise 管理）                                       |
| 前端    | Vue 3 + Vite 7 + Element Plus（Web / Electron 桌面端 / Capacitor 移动壳）                  |
| API   | Fastify 5 + Zod 4 + OpenAPI 3.1；POST Turn + GET SSE 流式                             |
| 数据    | SQLite (WAL) + Drizzle + 仓储抽象，PG 双引擎兼容规划（[AVX-DB-001](docs/reference/DATABASE.md)） |
| 后台    | Worker 进程（Outbox / 复习提醒 / 日记 / 删除），Redis + BullMQ 待接入                              |

## 仓库结构

```text
apps/
  api/          Fastify /v1/ API，按领域模块组织（11 个 modules/*，见 ADR-014）
  web/          Vue 3 工作台（对话 / 学习 / 复习）
  desktop/      Electron 桌面端（Fairy，含独立桌宠窗口）
  worker/       后台任务进程（tsx）
  mobile/       Capacitor 最小壳（打包 web 产物）
packages/
  contracts/    Zod 契约事实源 → OpenAPI 3.1（流式协议 / 学习域 / 插件 Config/Page / Persona）
  database/     SQLite 真源 + 仓储 / FTS5 / 向量检索 Port / 迁移服务
  practice-review/  复习排期 @aervox/practice-review（CAP-006，幂等 + 时区安全调度）
reference/      参考仓库子模块（deepseek-harness / pi / baishou-next / dsh-synapse / AstrBot / Petra，仅设计验证）
docs/            按 Diátaxis 四分类组织：tutorials / how-to / explanation / reference/（含 adr · changes · standards · diagrams）
AGENTS.md        AI 协作入口（薄入口，深链 docs/；被 AI 编码工具自动加载）
```

## 客户端形态

三种客户端共享同一契约（`@aervox/contracts`）与后端（`@aervox/api`），均不在各自端持有核心业务数据。

### 桌面端 Fairy Agent

桌宠为核心的视觉小说式 AI 对话应用：

- **功能**：独立透明、可拖动、始终置顶的桌宠窗口 · 长文本逐句推进与历史回看 · 待办清单/番茄钟/对话历史工具菜单 · 亮/暗/系统主题 · 自定义无边框标题栏 · Electron `contextIsolation` + 沙箱 preload
- **技术栈**：Electron / Vue 3 + TypeScript / Element Plus / Lucide / `electron-vite`
- **结构**：`apps/desktop/src/` 下 `main`（主进程与窗口）、`preload`（受限 IPC 桥接）、`renderer`（标题栏、侧栏、聊天区、桌宠窗口）
- **启动**：renderer 不直接访问 API，经 preload IPC 由主进程调用 Turn/SSE：

```bash
AERVOX_API_URL='http://127.0.0.1:3000' AERVOX_SESSION_ID='<现有会话 ID>' pnpm dev:desktop
```

`AERVOX_SESSION_ID` 必须指向现有 API 有权访问的会话；模型、鉴权与持久化由 `@aervox/api` 负责。

### Web 工作台

浏览器版对话 + 学习工作台（端口 5173），复用桌面端 renderer 核心（composables / SSE 浏览器分支），桌宠以同页浮层呈现。移动端（Capacitor）为其壳，原生平台随 auth（PG 阶段）启用。

### 桌宠表现

桌宠支持两种渲染形态，共用一套表现契约（`@aervox/contracts`）与 SSE `emote` 事件：

- **CSS 骨架**（`PetHero`）：静态 DOM + CSS 变换表达 emote/gesture，无外部素材依赖；
- **Codex Pets 兼容精灵图**（`SpritePet`）：消费 Codex Pets 9 状态 spritesheet（`pet.json` + 8×9 atlas），工具调用结果经 `/v1/tools/:id/call` 的 `sheetState` 驱动姿态（成功 `waving` / 失败 `failed`）。

### 环境变量

| 端            | 变量                                     | 说明                                                                                                                             |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| API          | `PORT`                                 | 监听端口（默认 3000）                                                                                                                  |
| Web / Mobile | `VITE_API_URL`                         | API 地址（默认 `http://127.0.0.1:3000`）                                                                                             |
| <br />       | `VITE_SESSION_ID`                      | 会话 ID（默认 `web_default`）                                                                                                        |
| <br />       | `VITE_WORKSPACE_ID` / `VITE_USER_ID`   | 可选租户头（缺省回退默认租户）                                                                                                                |
| Desktop      | `AERVOX_API_URL` / `AERVOX_SESSION_ID` | 见上方桌面端小节                                                                                                                       |
| 数据           | `DATABASE_URL`                         | SQLite 真源路径；API / Worker / 端侧默认共享 `<repo>/data/aervox.db`（详见 [AVX-DB-001 §2.1](docs/reference/DATABASE.md#21-sqlite-共享真源路径约定)） |

## 文档与追踪

- [文档索引](docs/README.md)：体系、权威顺序 · [从哪开始](docs/getting-started.md) · [生命周期登记表](docs/DOC_REGISTRY.md)
- [CONTRIBUTING](CONTRIBUTING.md)：双语贡献指南（三阶段新功能流程 + 门禁与落地登记）
- [AGENTS.md](AGENTS.md)：AI 协作入口（根目录，AI 编码工具自动加载）
- [PRD](docs/reference/PRD.md)（AVX-PRD-001）· [架构设计](docs/reference/ARCHITECTURE.md) · [ADR](docs/reference/adr/README.md) · [SRS](docs/reference/SRS.md)
- [Agent Harness Loop 规范](docs/reference/agent-harness-loop.md)（AVX-HAR-001）
- [需求追踪](docs/reference/REQUIREMENTS_TRACEABILITY.md)：CAP 状态、DoR、G0\~G6 门禁
- [能力注册表](docs/reference/capability-registry.md)（自选与交付状态） · [能力组合规范](docs/reference/capability-composition.md) · [操作指南](docs/how-to)

## 项目状态与质量门禁

- P0（CAP-001\~013）需求已 `Specified` 并进入 DoR 评估；
- 首批落地：API 域路由 + SQLite 仓储（[AVX-DB-001](docs/reference/DATABASE.md)）、Fairy 桌面端、Web 工作台、学习域契约、间隔重复调度；
- 持续演进（[落地追踪基线 §4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 有全部登记）：
  - **数据/存储**：SQLite 写路径 busy 重试（T-01）、会话级写锁（AST-01）、FTS+向量 RRF 混合检索（T-02）、上下文压缩标记与异步消费（T-03）、Embedding 独立表与迁移（T-05）、迁移服务与完成标记（T-06/AST-05）、数据版本快照（T-09）、Token 用量分账（T-10）；
  - **学习/复习**：练习会话契约（会话快照/作答幂等，CR-008）、错题本忽略与恢复（CR-009）、复习完成幂等与结果重放（CR-010）、时区安全的到期与逾期复习调度（CR-011，`@aervox/practice-review`）；
  - **工具/插件/技能**：工具注册表 + 运行时 + `/v1/tools`（T-04）、插件运行时 + Config/Page（CAP-020，CR-006）、Skill 注册表/zip 安装/渐进式披露（借鉴 AstrBot）、工具安全级别白名单（PET-05）；
  - **人格/桌宠表现**：Persona 系统级重构（去模块化 + 系统级 Skills/Tools/MCP + 独立 Voice，2026-08-27，原生）、Persona 设定 UI（AST-03）、表现指令契约与前端消费（PET-01/02）、Codex Pets 兼容的 9 状态 spritesheet 协议（`pet.json` + 8×9 atlas + 工具状态驱动，原生·外部协议兼容）、桌面 preload 按域 IPC（T-07）、桌宠角色设定文档化（T-08，AVX-EXPL-003）；
  - **文档/架构治理**：Agent Harness Loop 目标规范与迁移计划（AVX-HAR-001/CR-012）、能力组合与可选化目录规范（AVX-CAP-001，借鉴 DSH-01/PI-01）+ 能力注册表（AVX-CAP-REG-001）、双语贡献指南（CONTRIBUTING）。

合并到 `main` 前通过（本地 `./aervox ci` 等效，CI 定义见 `.github/workflows/`）：

- **代码**（`apps/**`、`packages/**`、锁文件等）：install + build + typecheck + test；
- **文档**（`docs/**`、`README.md`、`AGENTS.md` 等）：markdown lint + Vale 术语检查 + 链接检查；
- 变更一律走功能分支 + PR 合入 `main`（分支前缀：`feat/` `fix/` `docs/`）；PR 描述须引用对应落地登记。

## License

The source code (apps/, packages/, scripts/ and configuration files) is licensed under the GNU Affero General Public License v3 or later. See the [LICENSE](LICENSE) file for details.

The documentation (docs/, README.md, AGENTS.md) is licensed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International Public License. See the [docs/LICENSE](docs/LICENSE) file for details.

本项目采用双许可：源码（apps/、packages/、scripts/ 及配置文件）基于 GNU Affero General Public License v3 或更高版本授权，详见 [LICENSE](LICENSE)；文档（docs/、README.md、AGENTS.md）基于 Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International（CC BY-NC-SA 4.0）授权，详见 [docs/LICENSE](docs/LICENSE)。
