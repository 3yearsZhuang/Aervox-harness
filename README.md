# Aervox｜思隅

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-18

> **全新交互减法下的“主动智能” —— 属于你的贾维斯。**
>
> 告别被动等待提示词的沉重对话框。Aervox 是一个隐入桌面、全域感知、自我进化、数据绝对自持的智能生活与伴学系统。基于 TypeScript 全栈 monorepo 交付：Fastify API + 独立 Worker 进程 + 桌面端（Electron）/ Web 端（Vue 3）/ 移动端（Capacitor）共享同一套契约，SQLite (WAL) 永久本地单用户真源。

---

```text
  ┌─────────────────────────────────────────────────────────────┐
  │                        AERVOX CORE                          │
  │                                                             │
  │  [全域感知 Perception]           [自进化大脑 Brain]          │
  │  • Home Assistant 智能家居       • 四段式记忆树 (Episodic)   │
  │  • 小米健康 / 个人生理节律        • SM-2 认知间隔复习算法     │
  │  • 操作系统上下文与窗口感知      • AI 夜间日记自主提炼       │
  │               │                             │               │
  │               └──────────────┬──────────────┘               │
  │                              ▼                              │
  │          ┌───────────────────────────────────────┐          │
  │          │  主动智能调度中枢 (Proactive Harness) │          │
  │          └───────────────────────────────────────┘          │
  │                              │                              │
  │               ┌──────────────┴──────────────┐               │
  │               ▼                             ▼               │
  │  [交互减法 Ambient HUD]          [开放生态 Ecosystem]        │
  │  • 灵动透明桌宠 / Live2D         • Streamable MCP 原生网关  │
  │  • 极简气泡 / Galgame 逐句推进   • 单文件 .aervox-plugin    │
  │  • 沉浸式伴学工作台 (Vue 3)      • AstrBot 兼容技能 (Skill) │
  └─────────────────────────────────────────────────────────────┘
```

---

## 核心设计理念与四大支柱

### 1. 💡 交互减法 (Ambient Presence)

不再强迫用户面对复杂的管理后台与长篇大论的 Prompt 调试。

- **灵动桌面触点**：独立半透明桌宠窗口（支持 CSS 骨架、Codex 精灵图、Live2D Mizuki 三种渲染引擎），随唤随应，平时彻底隐入工作流背景；
- **视觉小说级气泡**：逐句推进与快速回看，以极简信息流承载日常交流与轻量提醒；
- **无缝伴学工作台**：需要深度探索与刷题时，一键从桌宠呼出液态玻璃雾蓝工作台，实现极简与深度的动态平衡。

### 2. ⚡ 主动智能 (Proactive Intelligence)

告别“不问不答、一问一答”的机械被动响应，实现真正懂你的个人贾维斯。

- **全域环境感知**：内置 Home Assistant 智能家居网关与小米运动健康适配器，连接真实物理环境与生理节奏；
- **适时主动触达**：根据作息、专注状态与学习周期，由后台独立 Worker 进程结合 SQLite Outbox 事务可靠投递，在适宜节点主动发起问候、日程提示与复习关怀；
- **智能免打扰与断路**：完备的静默窗口、频控策略与胶囊级物理熔断机制，拒绝任何无意义骚扰。

### 3. 🧠 自进化认知闭环 (Self-Evolving Loop)

伴随日常使用自主进化，成为越用越有默契的专属智能体。

- **四段式记忆拓扑**：工作记忆、情境记忆、语义记忆、系统记忆逐级沉淀，构建层次分明的个人知识与偏好树；
- **夜间 AI 日记提炼**：无需手动记录，每日凌晨自动萃取全天对话、练习与事件关键素材，生成带有情感温度的复盘日记；
- **自适应间隔重复**：基于 SM-2 遗忘曲线算法演进的错题本与复习排期引擎（`@aervox/practice-review`），以科学节律巩固长期记忆。

### 4. 🔒 纯本地数据主权与解耦生态 (Local-First & Decoupled)

在保障个人隐私绝对安全的前提下，提供无限扩展的可能性。

- **100% 本地自持（CR-030）**：去租户化纯单用户架构，本地 SQLite (WAL 模式) 单库存储，FTS5 全文检索 + 嵌入式向量 RRF 混合重排，彻底隔绝云端外泄风险；
- **单文件插件化分发**：支持 `.aervox-plugin` 单文件分发包（ZIP 容器）原子安装与安全预检，集市自发现一键部署；
- **原生开放协议**：内置 Streamable HTTP MCP 客户端（如官方预置 MCP），全面兼容 AstrBot 技能生态，支持动态 Web 扩展页面与运行时配置注入。

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

## 全景技术栈矩阵

演进式模块化单体（[ADR-001](docs/reference/adr/ADR-001-modular-monolith.md) / [ADR-014](docs/reference/adr/ADR-014-modular-monolith-structure.md)）+ Vue 全栈单栈（[ADR-015](docs/reference/adr/ADR-015-vue-full-stack.md)），全链路强类型契约驱动：

| 领域层次 | 核心技术选型 | 职责定位与核心依据 |
| :--- | :--- | :--- |
| **环境感知 (Perception)** | Home Assistant REST/WS + 小米开放平台 + OS Broker | 真实环境信号采集，私网白名单校验与授权动作审计 |
| **表现交互 (Ambient UI)** | Electron 43 + Vue 3 + Vite 7 + Live2D Cubism | 透明穿透桌宠外壳、沙箱化 IPC 隔离、Element Plus 雾蓝液态工作台 |
| **核心服务 (Core API)** | Fastify 5 + Zod 4 + OpenAPI 3.1 (`zod-to-openapi` v9) | POST Turn 建立会话 + GET SSE 活流输出，领域模块化单体组织（ADR-014） |
| **智能大脑 (Agent Loop)** | `@aervox/agent-loop` + `@aervox/host-agent` | 多步工具调用循环、Lease & Fencing 租约恢复机制、异步收件箱排队 |
| **认知进化 (Cognition)** | `@aervox/practice-review` + `@aervox/diary` | SM-2 科学复习排期调度、时区安全幂等计算、夜间日记 Prompt 渲染引擎 |
| **本地真源 (Data Vault)** | SQLite (WAL 模式) + Drizzle ORM（[AVX-DB-001](docs/reference/DATABASE.md)） | 永久单用户本地真源，131 张业务表完整索引，FTS5 全文 + 向量混合检索 |
| **后台作业 (Worker)** | 独立 Worker 进程（`tsx` 驱动） | SQLite Outbox 事务消费、定时排期批处理、日记生成、过期证据物理擦除 |
| **开放扩展 (Ecosystem)** | MCP (Streamable HTTP) + AstrBot Skill + Plugins | 插件打包与安装安全预检、扩展配置与 UI 页面注入、物理断路器控制 |
| **工程工具 (Tooling)** | TypeScript 5.x + pnpm 11 + Turborepo + mise | 统一工具链版本锁定，零幽灵依赖，秒级增量构建与受控测试编排 |

---

## 仓库组织架构

```text
apps/
  api/              Fastify 5 API 服务，按领域模块组织（20+ modules/*，见 ADR-014）
  web/              Vue 3 对话与伴学工作台（对话 / 练习 / 扩展中心 / 沉浸式桌宠）
  desktop/          Electron 桌面端（Fairy，独立透明桌宠窗口、Dock 工具栏与托盘）
  worker/           后台任务进程（Outbox 投递、复习排期、日记生成、画像证据清理）
  mobile/           Capacitor 移动壳（跨平台打包 apps/web 静态产物）
packages/
  agent-loop/       Agent Turn 执行核心：多 Provider、工具循环、租约恢复与上下文压缩
  host-agent/       内嵌异步 Agent Host：任务领取、心跳续租、受控收件箱与进程外驱动
  contracts/        Zod 契约事实源 → OpenAPI 3.1（流式协议 / 学习域 / 插件 / Persona）
  schema/           Drizzle 表结构与实体模式定义（131 张业务表唯一事实源）
  repositories/     LibSQL/SQLite 仓储层：DDL、迁移、事务执行器与混合检索
  practice-review/  SM-2 间隔重复自适应排期引擎（幂等 + 时区安全调度）
  diary/            AI 记忆日记生成共享包（素材窗口 / 模板引擎 / Prompt 构建）
  ui/               Web 与 Desktop 共享的 Vue 3 组件库、设计代币与 Composables
  api-client/       Web 与 Desktop 共享的 API 客户端（Turn/SSE 流传输、收件箱）
  live2d/           Live2D 桌宠模型静态真源（Mizuki 模型资源包）
  public/           共享公共资产（Favicon 与 aervox-intro 宣讲页）
  config/           运行时环境配置加载与严格类型校验
  observability/    结构化日志、可观测性指标与审计导出接口
```

---

## 系统级防多源漂移守卫体系

为了从根源上杜绝架构文档、数据库定义、跨层契约与依赖拓扑随时间推移产生的多源漂移，仓库内置了 5 道自动化防漂移系统级门禁（在本地 `./aervox ci` 与 GitHub Actions CI 中严格阻断）：

- **Guard 1 (P0 表结构双源等价守卫)**：内存 SQLite DDL 与 Drizzle Schema 全量 131 表双向等价断言，杜绝建表遗漏 Schema 或 Schema 遗漏 DDL；
- **Guard 2 (P0 AST 级租户遗留标识拦截)**：基于 Babel AST 语法树遍历，硬性阻断 `TenantContext`、`tenantId` 及承载 `LocalContext` 的 `tenant` 变量复发；
- **Guard 3 (P1 文档-代码自动渲染与校验)**：校验 131 张表在覆盖矩阵中的登记完整性、校验 18 个工作区包与架构拓扑对齐、自动化 ADR 索引生成与 `--check` 一致性门禁；
- **Guard 4 (P1 跨层 DTO 类型单一真源)**：扫描下游应用层，严禁本地重复声明已由 `@aervox/contracts` 导出的 DTO 类型；
- **Guard 5 (P2 依赖提升与版本分裂治理)**：扫描子包 `package.json`，严禁重复声明根级构建工具（`typescript`、`turbo`、`vitest` 等）。

本地运行守卫套件：

```bash
pnpm check:guards        # 秒级运行 6 项守卫与 21 个针对性单元测试
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

当前迭代建议、排序、依赖与待决策项统一维护在根目录 [plan.md](plan.md)。开始任务先读计划；维护规则见[迭代计划治理](docs/reference/document-governance.md#31-当前迭代计划的唯一入口)。PRD/ADR/契约及追踪基线继续各自负责需求、决策与验收，不在本入口复制待办。

Aervox 实施严格的 Docs-as-Code 规范，文档按 Diátaxis 四分类组织。权威真源由 [docs/README.md](docs/README.md) 索引，划分为八大主题域：

1. **入门指引**：[从哪开始](docs/getting-started.md) · [教程：构建第一个对话](docs/tutorials/first-conversation.md)
2. **产品与能力真源**：[产品需求说明书 PRD](docs/reference/PRD.md) · [能力注册表](docs/reference/capability-registry.md) · [能力组合规范](docs/reference/capability-composition.md) · [主动智能需求规格](docs/reference/srs-proactive-intelligence.md)
3. **系统架构与技术选型**：[系统架构设计说明书](docs/reference/ARCHITECTURE.md) · [ADR 架构决策索引](docs/reference/adr/README.md) · [软件需求规格 SRS](docs/reference/SRS.md)
4. **变更提案（CR）**：[提出与闭环 CR 指南](docs/how-to/cr-workflow.md) · [历史 CR 归档说明](docs/README.md#历史变更请求与临时落地计划归档说明)
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
- **文档资产**（`docs/`、`README.md`、`AGENTS.md`、`CONTRIBUTING.md`、`plan.md`）：基于 [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](docs/LICENSE)（CC BY-NC-SA 4.0）授权。
