# Aervox｜思隅

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-04

更好上手的"主动智能" Agent：以桌宠为入口，视觉小说 + 工作台双形态交互，承载陪伴与学习双重任务。TypeScript 全栈 monorepo 交付：Fastify API + Worker + 桌面 / Web / 移动端共享同一契约，SQLite 为业务真源。产品定义、工程规范与契约事实源一律在 [docs/](docs/README.md)，本 README 只做索引与速查。

## 快速开始

环境要求：Node 24 / pnpm 11（由 [mise.toml](mise.toml) 锁定），首次进入仓库执行一次安装：

```bash
./aervox setup       # 前置：mise 工具链 + 依赖安装（lockfile 一致时自动跳过）
```

一条命令启动开发服务，及其变体：

```bash
./aervox dev             # 全栈：API(:3000) + Web(:5173) + Mobile(:5174) + Desktop(Electron) + Worker
./aervox dev web         # 仅 API + Web（desktop / worker / api 同理）
./aervox mobile          # 构建 Web 产物并同步 Capacitor 移动壳
./aervox ci              # 本地门禁：ci-code + ci-docs（Markdown + Vale + 文档治理校验）
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
| `mise tasks run docs-validate`              | 文档 ID、签名、本地链接/锚点与登记一致性校验（`ci-docs` 的组成部分）           |
| `mise tasks run docs-lint-prose`            | Vale 术语与散文检查（`ci-docs` 的组成部分）                       |

## 架构与技术栈

演进式模块化单体（[ADR-001](docs/reference/adr/ADR-001-modular-monolith.md) / [ADR-014](docs/reference/adr/ADR-014-modular-monolith-structure.md)，已 Accepted）+ Vue 全栈单栈（[ADR-015](docs/reference/adr/ADR-015-vue-full-stack.md)）：桌面 / Web / 移动端共享契约与技术族。详细设计见 [架构设计](docs/reference/ARCHITECTURE.md)（C4、数据所有权、可靠性、安全）与 [ADR 索引](docs/reference/adr/README.md)。

| 层     | 选型                                                                                 |
| ----- | ---------------------------------------------------------------------------------- |
| 语言/工程 | TypeScript、pnpm + Turborepo、Node 24（mise 管理）                                       |
| 前端    | Vue 3 + Vite 7 + Element Plus（Web / Electron 桌面端 / Capacitor 移动壳）                  |
| API   | Fastify 5 + Zod 4 + OpenAPI 3.1；POST Turn + GET SSE 流式；内置 MCP 预设客户端（Streamable HTTP） |
| 数据    | SQLite (WAL) + Drizzle + 仓储抽象，PG 双引擎兼容规划（[AVX-DB-001](docs/reference/DATABASE.md)） |
| 后台    | Worker 进程（Outbox / 复习提醒 / 日记生成 / 删除传播 / 收件箱过期回收 / 恢复裁决 / 主动智能画像与提炼），Redis + BullMQ 待接入 |

## 仓库结构

```text
apps/
  api/          Fastify /v1/ API，按领域模块组织（20+ 个 modules/*，见 ADR-014）
  web/          Vue 3 工作台（对话 / 学习 / 复习 / 扩展中心）
  desktop/      Electron 桌面端（Fairy，含独立桌宠窗口）
  worker/       后台任务进程（tsx）
  mobile/       Capacitor 最小壳（打包 web 产物）
packages/
  agent-loop/   Agent Turn/Attempt/Step 执行核心：Replay/Scripted/真实 OpenAI 兼容 Provider、多 Step 工具循环、租约与恢复、Context 压缩 seam 与 Subagent/Workflow Contribution
  host-agent/   内嵌异步 Agent Host：执行器、回执/续跑、健康检查、Inbox 消费与进程外 Adapter 整 Turn 执行（runAdapterTurn）
  config/       环境配置加载与启动期枚举校验（@aervox/config）
  diary/        日记生成共享包（素材窗口 / 模板 / Prompt 构建，@aervox/diary）
  observability/   可观测性接口与指标（阶段 2a）
  contracts/    Zod 契约事实源 → OpenAPI 3.1（流式协议 / 学习域 / 插件 Config/Page / Persona）
  database/     SQLite 真源 + 仓储 / FTS5 / 向量检索 Port / 迁移服务
  api-client/   Web/Desktop 共享 API 客户端（Turn/SSE、设置、收件箱）
  ui/           Web/Desktop 共享 UI 组件与 composables
  practice-review/  复习排期 @aervox/practice-review（CAP-006，幂等 + 时区安全调度）
reference/      参考仓库子模块（deepseek-harness / pi / baishou-next / dsh-synapse / AstrBot / Petra / OpenMAIC / archify，仅设计验证；已配置 shallow = true，按需 init）
artifacts/      对外推介材料（pitch-preview：Midnight Galaxy 与 Tech Innovation 两版 PPT 及预览图），非代码资产、不参与构建与打包，仅供对外介绍取用
docs/            按 Diátaxis 四分类组织；_meta 存放文档治理机器策略
AGENTS.md        AI 协作入口（薄入口，深链 docs/；被 AI 编码工具自动加载）
```

## 客户端形态

三种客户端共享同一契约（`@aervox/contracts`）与后端（`@aervox/api`），均不在各自端持有核心业务数据。

### 桌面端 Fairy Agent

桌宠为核心的视觉小说式 AI 对话应用：

- **功能**：独立透明、可拖动、始终置顶的桌宠窗口 · 长文本逐句推进与历史回看 · 待办清单/番茄钟/对话历史工具菜单 · 亮/暗/系统主题 · 自定义无边框标题栏 · 开屏引导（取材自自研宣讲包：六能力辐射图 + 学习闭环，设置 → 外观可随时回放完整产品介绍）· Electron `contextIsolation` + 沙箱 preload
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

桌宠支持三种渲染形态，共用一套表现契约（`@aervox/contracts`）与 SSE `emote` 事件：

- **CSS 骨架**（`PetHero`）：静态 DOM + CSS 变换表达 emote/gesture，无外部素材依赖；
- **Codex Pets 兼容精灵图**（`SpritePet`）：消费 Codex Pets 9 状态 spritesheet（`pet.json` + 8×9 atlas），工具调用结果经 `/v1/tools/:id/call` 的 `sheetState` 驱动姿态（成功 `waving` / 失败 `failed`）；
- **Live2D 桌宠**（CR-007，可替换渲染层）：Web 工作台与 Electron 独立桌宠窗口加载 Live2D 模型资产（真源 `packages/live2d/mizuki`，构建期拷贝至两端 `public/live2d/`，W-15 收敛后不再经 git submodule），加载失败回退 CSS 骨架；沉浸式桌宠工作台重构（雾蓝主题 + 液态玻璃菜单 + Live2D 满高对齐）已落地（#70）。

### 环境变量

| 端            | 变量                                     | 说明                                                                                                                             |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| API          | `PORT`                                 | 监听端口（默认 3000）                                                                                                                  |
| <br />       | `AERVOX_LOOP_DRIVER`                   | Turn 执行驱动：`native`（默认）/ `dsh`（整 Turn 走 DSH 进程外 Adapter，准入失败 fail-closed，见 [ADR-010](docs/reference/adr/ADR-010-dsh-pi-adapters.md)） |
| Web / Mobile | `VITE_API_URL`                         | API 地址（默认 `http://127.0.0.1:3000`）                                                                                             |
| <br />       | `VITE_SESSION_ID`                      | 会话 ID（默认 `web_default`）                                                                                                        |
| <br />       | `VITE_WORKSPACE_ID` / `VITE_USER_ID`   | 可选租户头（缺省回退默认租户）                                                                                                                |
| Desktop      | `AERVOX_API_URL` / `AERVOX_SESSION_ID` | 见上方桌面端小节                                                                                                                       |
| 数据           | `DATABASE_URL`                         | SQLite 真源路径；API / Worker / 端侧默认共享 `<repo>/data/aervox.db`（详见 [AVX-DB-001 §2.1](docs/reference/DATABASE.md#21-sqlite-共享真源路径约定)） |

## 文档与追踪

- [文档索引](docs/README.md)：体系、权威顺序 · [从哪开始](docs/getting-started.md) · [文档治理规范](docs/reference/document-governance.md) · [生命周期登记表](docs/DOC_REGISTRY.md)
- [CONTRIBUTING](CONTRIBUTING.md)：双语贡献指南（三阶段新功能流程 + 门禁与落地登记）
- [AGENTS.md](AGENTS.md)：AI 协作入口（根目录，AI 编码工具自动加载）
- [PRD](docs/reference/PRD.md)（AVX-PRD-001）· [架构设计](docs/reference/ARCHITECTURE.md) · [ADR](docs/reference/adr/README.md) · [SRS](docs/reference/SRS.md)
- [Agent Harness Loop 规范](docs/reference/agent-harness-loop.md)（AVX-HAR-001）
- 评估与延伸：[ESP32 硬件延伸](docs/explanation/esp32-s3-hardware-extension.md)（AVX-EXPL-005）· [Home Assistant 集成评估](docs/explanation/home-assistant-integration-assessment.md)（AVX-EXPL-006）· [运动与健康数据接入评估](docs/explanation/health-data-integration-assessment.md)（AVX-EXPL-007）
- [需求追踪](docs/reference/REQUIREMENTS_TRACEABILITY.md)：CAP 状态、DoR、G0\~G6 门禁
- [能力注册表](docs/reference/capability-registry.md)（自选与交付状态） · [能力组合规范](docs/reference/capability-composition.md) · [操作指南](docs/how-to)

## 项目状态与质量门禁

- P0（CAP-001\~013）需求已 `Specified` 并进入 DoR 评估；
- 首批落地：API 域路由 + SQLite 仓储（[AVX-DB-001](docs/reference/DATABASE.md)）、Fairy 桌面端、Web 工作台、学习域契约、间隔重复调度；
- 持续演进（[落地追踪基线 §4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 有全部登记）：
  - **数据/存储**：SQLite 写路径 busy 重试（T-01）、会话级写锁（AST-01）、FTS+向量 RRF 混合检索（T-02）、上下文压缩标记与异步消费（T-03）、Embedding 独立表与迁移（T-05）、迁移服务与完成标记（T-06/AST-05）、数据版本快照（T-09）、Token 用量分账（T-10）；
  - **学习/复习**：练习会话契约（会话快照/作答幂等，CR-008）、错题本忽略与恢复（CR-009）、复习完成幂等与结果重放（CR-010）、时区安全的到期与逾期复习调度（CR-011，`@aervox/practice-review`）、学习计划生成与路由（#118）；
  - **Agent 执行核心**：Agent Harness Loop 阶段 0/1/2a-2e/3a/3b-A/3b-B/3c/4a-4d/5a/5a-2/5b/5c 已落地（`packages/agent-loop` + `packages/host-agent`：Replay/Scripted/真实 OpenAI 兼容 Provider、持久化 SSE、只读/写审批/特权工具、工具执行账本、租约与 fencing、恢复裁决、内嵌异步 Host 与健康检查、受控收件箱 AgentInboxItem 及 HTTP 入口、Context 压缩 seam 与 Skill 渐进式披露、Subagent/Workflow 独立 Contribution）；Turn 流活性治理——执行解耦、SSE 活流与思考增量透传、取消闭环（CR-027）；DSH 进程外 Adapter 接线——`AERVOX_LOOP_DRIVER=dsh` 整 Turn 执行、准入 fail-closed 不回退 native（ADR-010 阶段 6f，#138）；
  - **工具/插件/技能/MCP**：工具注册表 + 运行时 + `/v1/tools`（T-04）、插件运行时 + Config/Page（CAP-020，CR-006）、Skill 注册表/zip 安装/渐进式披露（借鉴 AstrBot）与 zip 路径规范化、层级穿越加固（#132/#133）、MCP 预设客户端——麦当劳中国官方 MCP 作为首个出厂预设（自研 Streamable HTTP 客户端，远程工具以 `mcp__<serverId>__<toolName>` 落注册表，PET-05 分级门控，#140）、工具安全级别白名单（PET-05）；
  - **主动智能（CAP-033）**：桌面 Host 本地私密存储与 OS Permission Broker（ADR-018）、外部连接本地网关（ADR-019）、激活以连接为准（#117）、全量画像来源与动作改用户可选胶囊开关——开关即授权，关闭即撤销并删除本地捕获与画像证据（#137）；
  - **日记**：AI 按当天记忆与上下文生成日记（`@aervox/diary` 共享包 + Worker 定时任务 + 首开卡片与菜单日记本，#124）、当日素材窗口 UTC 边界修复（#138）；
  - **人格/桌宠/桌面体验**：Persona 系统级重构（去模块化 + 系统级 Skills/Tools/MCP + 独立 Voice，2026-08-27，原生）、Persona 设定 UI（AST-03）、在线语音模型设置——远程配置持久化 + api_v2 协议适配（CR-028）、表现指令契约与前端消费（PET-01/02）、Codex Pets 兼容的 9 状态 spritesheet 协议、桌面 preload 按域 IPC（T-07）、桌宠角色设定文档化（T-08）、品牌资产与任务栏图标接入（#126/#129）、桌宠 dock 快捷交互与 galgame 式收起对话（#113/#115/#122）；
  - **多能力批次（CAP-010~019）**：人格偏好、消息编辑、学习资料、多模态答疑、层级对话/会话地图、思维宇宙、自适应刷题与报告、考试日计划、多人格模板（已主仓实现交付，PR #64；自选状态按 CR-019 转主仓交付）；
  - **文档/架构治理**：能力组合与可选化目录规范（AVX-CAP-001，借鉴 DSH-01/PI-01）+ 能力注册表（AVX-CAP-REG-001）；文档治理与事实源规范（AVX-DOC-GOV-001/CR-017）+ `docs-validate`；文档头元数据清账（ci-docs 28 → 0 warning）+ 16 份 Proposed ADR 转显式验收跟踪、ADR-014 接受（#139）；双语贡献指南（CONTRIBUTING）。

合并到 `main` 前通过（本地 `./aervox ci` 等效，CI 定义见 `.github/workflows/`）：

- **代码**（`apps/**`、`packages/**`、锁文件等）：install + build + typecheck + test；
- **文档**（`docs/**`、`README.md`、`CONTRIBUTING.md`、`AGENTS.md` 等）：Markdown lint + Vale 术语检查 + 文档治理校验；CI 另执行仓库链接检查；
- 变更一律走功能分支 + PR 合入 `main`（分支前缀：`feat/` `fix/` `docs/`）；PR 描述须引用对应落地登记。

## License

The source code (apps/, packages/, scripts/ and configuration files) is licensed under the GNU Affero General Public License v3 or later. See the [LICENSE](LICENSE) file for details.

The documentation (docs/, README.md, AGENTS.md) is licensed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International Public License. See the [docs/LICENSE](docs/LICENSE) file for details.

本项目采用双许可：源码（apps/、packages/、scripts/ 及配置文件）基于 GNU Affero General Public License v3 或更高版本授权，详见 [LICENSE](LICENSE)；文档（docs/、README.md、AGENTS.md）基于 Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International（CC BY-NC-SA 4.0）授权，详见 [docs/LICENSE](docs/LICENSE)。
