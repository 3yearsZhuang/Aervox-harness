# Aervox｜思隅

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-13

更好上手的“主动智能” Agent：以桌宠为入口，视觉小说 + 工作台双形态交互，承载陪伴与学习双重任务。基于 TypeScript 全栈 monorepo 交付：Fastify API + 独立 Worker 进程 + 桌面端（Electron）/ Web 端（Vue 3）/ 移动端（Capacitor）共享同一套契约，SQLite (WAL) 永久本地单用户真源。产品定义、工程规范与契约事实源一律在 [docs/](docs/README.md)，本 README 提供全局概览、快速启动与开发速查。

---

## 核心特性

- **双形态交互界面**：独立透明灵动桌宠（CSS 骨架 / Codex Pets 精灵图 / Live2D Mizuki 三种表现引擎）+ 沉浸式对话与伴学工作台（Element Plus，雾蓝主题与液态玻璃设计，支持 Galgame 式收起与桌面 Dock 快捷交互）。
- **纯本地单用户真源（CR-030）**：数据 100% 本地自持，SQLite (WAL 模式) 单库存储，集成 FTS5 全文索引 + 嵌入式向量 RRF 混合重排，彻底消除外部数据库与云端网络依赖。
- **可信 Agent Harness Loop 闭环**：多步工具调用循环、租约与恢复机制（Lease & Fencing）、持久化 SSE 活流透传与思考增量（CR-027 / CR-031）；支持原生 Provider 与基于进程外的 DSH Adapter（`AERVOX_LOOP_DRIVER=dsh` 准入 fail-closed）。
- **开放插件与工具生态**：自研 Streamable HTTP 客户端原生集成 MCP（如出厂预置麦当劳中国官方 MCP）、兼容 AstrBot Skill 规范并实现渐进式披露、支持基于 WebUI 的 Plugin Config 与 Page 扩展。
- **主动智能与科学伴学**：基于遗忘曲线与间隔重复算法（SM-2 演进）的自适应错题与复习系统（`@aervox/practice-review`）；AI 每日记忆日记提炼（`@aervox/diary`）；受控的本地主动智能画像（OS 权限代理，胶囊开关授权即开启、关闭即物理擦除，见 ADR-018 / ADR-019）。
- **Docs-as-Code 严谨治理体系**：严格对齐 Diátaxis 架构的 100+ 篇受治文档体系，配备自动化元数据提取、机器目录（`document-catalog.json`）、注册表自动回写与代码变动触发器（Triggers）。

---

## 快速开始

### 环境准备

项目由 [mise.toml](mise.toml) 严格锁定工具链版本：**Node 24**、**pnpm 11** 与 **Vale 3.18**。首次进入仓库执行前置安装：

```bash
./aervox setup       # 前置：mise 工具链安装 + 依赖重新解析（幂等执行）
```

### 一键开发启动

使用根目录统一 CLI 脚本 `./aervox` 启动开发服务及其变体：

```bash
./aervox dev             # 全栈启动：API(:3000) + Web(:5173) + Desktop(Electron) + Worker
./aervox dev web         # 轻量开发：仅启动 API + Web 工作台
./aervox dev desktop     # 桌面开发：仅启动 API + Electron 桌面端
./aervox dev worker      # 后台开发：仅启动 Worker 后台进程
./aervox dev api         # 接口开发：仅启动 Fastify API 服务
./aervox mobile          # 移动端：构建 Web 产物并同步至 Capacitor 移动壳
./aervox package         # 打包：构建 Electron 桌面端安装包（产物至 apps/desktop/release/）
./aervox ci              # 门禁自检：本地执行 ci-code + ci-docs
./aervox clean           # 清理构建产物 dist/out/.turbo（保留 node_modules）
./aervox help            # 命令与环境变量速查
```

### 底层等价命令速查

供自动化脚本或 CI 流程直接取用：

| 命令 | 说明 |
| ------------------------------------------- | --------------------------------------------------- |
| `pnpm install` | 依赖安装（使用 frozen-lockfile） |
| `pnpm dev:web` | 启动 API + Web 联调环境 |
| `pnpm dev:desktop` | 启动 API + Electron 桌面端联调环境 |
| `pnpm test` | 执行全量单元测试与集成测试 |
| `pnpm typecheck` | 执行全工作区 TypeScript 类型检查 |
| `mise tasks run ci-code` | 代码门禁：依赖安装 + 架构边界检查 + 构建 + 类型检查 + 测试 |
| `mise tasks run ci-docs` | 文档门禁：Markdownlint + Vale 术语检查 + 文档治理严格校验 |
| `mise tasks run docs-sync` | 自动化治理：从 Front Matter 自动同步核验日期至 `DOC_REGISTRY.md` |
| `mise tasks run docs-catalog` | 自动化治理：自动扫描并生成机器目录 `docs/_meta/document-catalog.json` |
| `mise tasks run docs-triggers` | 变更触发器：检查当前代码改动是否命中受治文档的 `review_triggers` |

---

## 架构与技术栈

演进式模块化单体（[ADR-001](docs/reference/adr/ADR-001-modular-monolith.md) / [ADR-014](docs/reference/adr/ADR-014-modular-monolith-structure.md)）+ Vue 全栈单栈（[ADR-015](docs/reference/adr/ADR-015-vue-full-stack.md)）。桌面、Web 与移动端共享契约与技术族。详细设计见 [架构设计说明书](docs/reference/ARCHITECTURE.md) 与 [ADR 索引](docs/reference/adr/README.md)。

| 架构层 | 核心技术选型 | 职责与设计依据 |
| ----- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 语言与工程 | TypeScript 5.x、pnpm 11 + Turborepo、Node 24（mise 管理） | 全栈强类型保障，单 monorepo 统一工作区依赖与任务编排 |
| 前端工作台 | Vue 3 + Vite 7 + Element Plus（Web 工作台与桌面端共用） | 模块化单栈，复用 composables 与 UI 组件核心，雾蓝沉浸式主题 |
| 桌面端宿主 | Electron + `electron-vite` | 提供透明可穿透桌宠独立窗口、沙箱化 preload IPC 隔离桥接 |
| 移动端外壳 | Capacitor 跨平台容器壳 | 打包 Web 静态产物至移动端，共享同一份前端与 API 契约 |
| 桌宠表现层 | Live2D (Cubism Core) + Codex Pets 9-state Spritesheet + CSS 骨架 | 三种自适应表现形态，由统一表现契约与 SSE `emote` 事件驱动 |
| API 服务 | Fastify 5 + Zod 4 + OpenAPI 3.1（`zod-to-openapi` v9） | POST Turn 建立会话 + GET SSE 活流输出；内置 Streamable HTTP MCP 客户端 |
| 调度与执行 | `@aervox/agent-loop` + `@aervox/host-agent` + DSH Adapter | Harness Loop 状态机、多 Provider、租约与恢复机制、收件箱异步排队 |
| 数据持久化 | SQLite (WAL 模式) + Drizzle ORM（[AVX-DB-001](docs/reference/DATABASE.md)） | 永久本地单用户真源（CR-030），FTS5 检索 + 向量 RRF，无外部数据库依赖 |
| 后台作业 | Worker 独立进程（tsx 驱动） | 基于 SQLite Outbox 消费机制、间隔复习排期调度、夜间日记提炼、过期证据物理擦除 |

---

## 仓库结构

```text
apps/
  api/              Fastify 5 API 服务，按领域模块组织（20+ modules/*，见 ADR-014）
  web/              Vue 3 对话与伴学工作台（对话 / 学习 / 复习 / 扩展中心 / 沉浸式桌宠）
  desktop/          Electron 桌面端（Fairy，含独立透明桌宠窗口、Dock 快捷菜单与系统托盘）
  worker/           后台任务进程（Outbox 消息分发、复习排期、日记生成、画像证据清理）
  mobile/           Capacitor 移动壳（跨平台打包 apps/web 静态产物）
  data/             运行时扩展与技能资产存储（如 apps/data/skills/ 离线技能包）
packages/
  agent-loop/       Agent Turn/Attempt/Step 执行核心：多 Provider、工具循环、租约恢复与上下文压缩
  host-agent/       内嵌异步 Agent Host：任务领取、心跳续租、受控收件箱与进程外 Adapter 整 Turn 驱动
  contracts/        Zod 契约事实源 → OpenAPI 3.1（流式协议 / 学习域 / 插件 Config & Page / Persona）
  schema/           Drizzle 表结构与实体模式定义（@aervox/schema）
  repositories/     数据访问层 / FTS5 / 向量检索 Port / CR-030 纯本地存储迁移服务
  practice-review/  间隔重复学习排期引擎（CAP-006，SM-2 演进，幂等 + 时区安全调度）
  diary/            AI 记忆日记生成共享包（素材窗口 / 模板引擎 / Prompt 构建）
  ui/               Web 与 Desktop 共享的 UI 组件库、主题代币（Tokens）与 Composables
  api-client/       Web 与 Desktop 共享的 API 客户端（Turn/SSE 流传输、系统设置、收件箱）
  live2d/           Live2D 桌宠模型静态真源（mizuki 模型资源包，构建期自动同步）
  public/           共享公共资产（Favicon 与自研产品宣讲引导页单份真源）
  config/           运行时环境配置加载与启动期枚举严格校验（@aervox/config）
  observability/    结构化日志、可观测性指标与审计导出接口
scripts/            文档治理器（docs-governance.mjs）、架构依赖边界校验器（import-boundary.mjs）
reference/          参考项目子模块（仅做架构验证与设计借鉴；配置 shallow clone，按需检出）
artifacts/          对外推介演示 PPT 与视觉资源，不参与打包与运行时
docs/               按 Diátaxis 规范组织的 100+ 篇工程真源文档，_meta 存放治理机器策略
AGENTS.md           AI 协作专属指南（薄入口，立红线并深链 docs/）
mise.toml           工具链版本锁定与开发任务编排真源
```

---

## 客户端形态与多端协同

桌面端、Web 端与移动端完全共享底层 API 契约（`@aervox/contracts`）与数据服务，均不在各自端层持久化核心业务数据。

### 1. 桌面端 Fairy Agent

桌宠为核心的视觉小说式 AI 伴学与陪伴应用：

- **桌面交互体验**：独立透明、可拖动、置顶的桌宠窗口；逐句推进长文本气泡与历史快速回看；待办清单 / 番茄钟 / 会话历史 Dock 工具栏；深浅及系统自适应主题；自定义无边框窗口。
- **开屏引导体验**：内置自研宣讲引导页（六能力辐射图与学习闭环），可在“设置 → 外观”中随时回放完整交互指引。
- **架构隔离**：严格遵循 Electron `contextIsolation: true` 与安全沙箱隔离，由主进程托管 Turn/SSE 活流调度，Renderer 经由受限的类型安全 IPC 与主进程通信。
- **启动方式**：

```bash
AERVOX_API_URL='http://127.0.0.1:3000' AERVOX_SESSION_ID='<现有会话 ID>' pnpm dev:desktop
```

### 2. Web 工作台与移动端

- **Web 工作台**（端口 5173）：浏览器端完整对话与伴学工作台，共享桌面端核心组件，桌宠以浮动图层呈现。
- **移动端（Capacitor）**：作为 Web 端产物的移动原生容器壳，通过 `./aervox mobile` 自动同步编译产物。

### 3. 三大桌宠渲染引擎

桌宠支持三种按需渲染模式，共用一套协议契约与 SSE `emote` 情感表现：

1. **CSS 骨架（`PetHero`）**：纯静态 DOM + CSS 变换驱动动作与表情，零外部素材依赖，极速轻量启动。
2. **Codex Pets 精灵图（`SpritePet`）**：消费标准 9 状态 Spritesheet（`pet.json` + 8×9 atlas），支持依据工具调用成败（`waving` / `failed`）实时改变姿态。
3. **Live2D 动态模型（`Live2D`）**：加载标准 Live2D Cubism 模型（真源位于 `packages/live2d/mizuki`），在 Web 与桌面独立桌宠窗口中呈现细腻骨骼动作，加载异常时自动平滑回退至 CSS 骨架。

---

## 环境变量速查

| 作用域 | 环境变量 | 说明与推荐默认值 |
| ------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| API | `PORT` | 监听端口（默认 `3000`） |
| API | `AERVOX_LOOP_DRIVER` | Turn 执行驱动：`native`（默认，内置 Harness Loop）/ `dsh`（外部 DSH 进程驱动，准入失败 fail-closed） |
| API | `AERVOX_TRUST_LOCAL_DEV_HOST` | 本地未签名开发宿主信任开关：开发模式置 `1`（主动智能可用）；设 `0` 恢复挂起 |
| Web / Mobile | `VITE_API_URL` | 后端 API 服务地址（默认 `http://127.0.0.1:3000`） |
| Web / Mobile | `VITE_SESSION_ID` | 默认会话 ID（默认 `web_default`） |
| Desktop | `AERVOX_API_URL` / `AERVOX_SESSION_ID` | 桌面端直连的 API 地址与绑定会话 ID |
| 数据持久化 | `DATABASE_URL` | 本地 SQLite 数据库文件路径；默认指向 `<repo>/data/aervox.db`（详见 [AVX-DB-001 §3](docs/reference/DATABASE.md#3-本地存储拓扑)） |

---

## 文档体系与权威真源

Aervox 实施严格的 Docs-as-Code 规范，文档按 Diátaxis 四分类组织。权威真源由 [docs/README.md](docs/README.md) 索引，划分为八大主题域：

1. **入门指引**：[从哪开始](docs/getting-started.md) · [教程：构建第一个对话](docs/tutorials/first-conversation.md)
2. **产品与能力真源**：[产品需求说明书 PRD](docs/reference/PRD.md) · [能力注册表](docs/reference/capability-registry.md) · [能力组合规范](docs/reference/capability-composition.md) · [主动智能需求规格](docs/reference/srs-proactive-intelligence.md)
3. **系统架构与技术选型**：[系统架构设计说明书](docs/reference/ARCHITECTURE.md) · [ADR 架构决策索引](docs/reference/adr/README.md) · [软件需求规格 SRS](docs/reference/SRS.md)
4. **变更提案（CR）**：[变更请求速览](docs/README.md#变更请求速览) · [提出与闭环 CR 指南](docs/how-to/cr-workflow.md)
5. **契约与数据持久化**：[SQLite 数据库契约](docs/reference/DATABASE.md) · [Agent Harness Loop 规范](docs/reference/agent-harness-loop.md) · [流式协议契约](docs/reference/STREAMING_PROTOCOL.md)
6. **质量、安全与运维**：[威胁模型](docs/reference/THREAT_MODEL.md) · [测试策略](docs/reference/TEST_STRATEGY.md) · [运行与演练手册](docs/reference/operations.md) · [数据与隐私规范](docs/reference/DATA_PRIVACY.md)
7. **教程与实战指南**：[编写自定义工具](docs/tutorials/create-agent-tool.md) · [开发扩展插件](docs/how-to/develop-plugin-ui-extension.md) · [SQLite 换库演练](docs/how-to/run-database-migration-drill.md) · [新增 CAP 能力](docs/how-to/add-capability.md)
8. **文档治理与元数据**：[文档治理与事实源规范](docs/reference/document-governance.md) · [文档写作规范](docs/reference/standards/doc-standards.md) · [术语表](docs/reference/standards/terminology.md) · [机器目录 JSON](docs/_meta/document-catalog.json) · [生命周期登记表](docs/DOC_REGISTRY.md)

---

## 质量保障与落地追踪

- **双门禁自动化保障**（本地 `./aervox ci` 阻断不合格变更，CI 双流并发执行）：
  - **代码门禁（`ci-code`）**：依赖锁定安装 + `scripts/import-boundary.mjs` 模块边界检查 + 全量构建 + 类型检查 + 单元测试。
  - **文档门禁（`ci-docs`）**：Markdownlint 语法格式 + Vale 术语合规 + `scripts/docs-governance.mjs --strict` 严格模式（校验 Front Matter、点阵签名、本地链接/断锚、注册表对齐）。
- **落地实现唯一真源**：
  - 一切落地改动必须在 [落地追踪基线 §4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 登记完成情况（关联 CAP、实现位置、日期、验证方式），未登记视为未闭环、提交打回。
  - 借鉴参考项目（`T-*` / `AST-*` / `PET-*` / `DSH-01` / `PI-01`）需在“来源”列标注参考编号，并严格遵循来源版权与引用声明。
- **分支与提交规范**：
  - 严禁直接向 `main` 分支推送或提交。所有改动一律建立功能分支（前缀：`feat/`、`fix/`、`docs/`），通过 GitHub Pull Request 合入 `main`。

---

## 开源协议

本项目采用双许可机制：

- **源代码**（`apps/`、`packages/`、`scripts/` 及配置文件）：基于 [GNU Affero General Public License v3](LICENSE)（AGPLv3）或更高版本授权。
- **文档资产**（`docs/`、`README.md`、`AGENTS.md`、`CONTRIBUTING.md`）：基于 [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](docs/LICENSE)（CC BY-NC-SA 4.0）授权。
