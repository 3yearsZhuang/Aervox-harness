---
id: AVX-SAD-001
---

# Aervox｜思隅 架构设计与参考项目学习（SAD）

<a id="AVX-WEB-001"></a>

关联 PRD：[PRD.md](PRD.md) · 追踪：[REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md)

本文回答“系统如何实现、怎样扩展和怎样在故障/删除/模型变更下保持正确”。产品目标以 PRD、可观察行为与用户级验收以 SRS 为准；本文件不能扩大已批准的权限、数据用途或生命周期范围。

本文件是系统架构、参考项目学习与演进设计的统一入口。现行架构见 §1～§12；固定版本与源码证据见[参考学习](#reference-learning)；历史问题与候选设计见[演进设计](#architecture-evolution)、[产品体验](#product-experience)。ADR 保留决策记录，专项契约保留各自责任，研究候选不自动成为批准基线。

| 读者任务 | 单一入口与证据 |
|---|---|
| 理解部署、依赖、数据与安全责任 | §1～§12，关联 ADR、数据库与执行契约 |
| 学习上游并判断采用价值 | §13 固定清单、八仓源码对照、最小验收与许可 |
| 追溯旧设计来源和故障反例 | §14 来源编号、§15 ARC/FND 与历史审计 |
| 评审记忆/陪伴/性能的演进 | §14.3、§16、§17；采纳后再更新相应现行合同 |
| 查当前排期、能力状态或发布证据 | [plan.md](../../plan.md)、[追踪基线](REQUIREMENTS_TRACEABILITY.md)；本文不维护第二张队列或完成表 |

## 1. 架构结论

采用 **TypeScript-first 模块化单体 + 独立 Worker/Scheduler**。Web、API、后台任务和桌面壳共享契约、领域类型和 UI；SQLite（WAL 模式）是永久本地单用户业务真源，`@aervox/schema` 与 `@aervox/repositories` 分别承载结构和访问边界；AI、记忆、日记和插件通过稳定内部 Port 解耦。API 默认仅监听 loopback，非 loopback 必须显式启用并强制认证。CAP-033 要求由受信本地 Privacy Host/Helper 承担全量观察、画像、后台生命周期和主动动作；当前仍有平台/生产验收缺口，状态见[追踪基线](REQUIREMENTS_TRACEABILITY.md#42-证据与适用限制)，主动数据不得进入普通远程数据面；CAP-034/035 通过同机本地连接网关接入家庭环境和规范化健康信号。

MVP 不采用微服务，也不让 DSH、pi、BaiShou-Next 或任何模型供应商成为核心运行时依赖。共享数据库多租户、组织权限和 PostgreSQL 演进由 CR-030 取消；未来若重新需要多人协作或远程服务，必须新建 ADR，不能恢复旧租户字段作为捷径。

## 1.1 插件配置与页面边界（CR-006）

插件配置使用 Aervox Config Schema v1：Schema 随 Bundle 注册并存储在 `plugins` 表，配置值按 `pluginId` 存入本地 `plugin_configs`，secret 走 `plugin_config_secrets`；当前 SQLite SecretStore 未实现静态加密，加密 Port 是生产目标，不能据字段脱敏声称已加密。插件 Page 只加载本地 Bundle 静态资源，运行在受限 iframe 中并通过 Host Bridge 读写本插件配置；不开放插件自有后端路由、文件上传、SSE 或直接数据库访问，这是已实现的 Page 静态隔离范围；第三方代码执行、独立进程沙箱及跨端 Page Token 通道仍按 `ADR-009`、插件契约和 ITER-006/019 验收。

## 1.2 Bot 平台入口与群会话边界（ADR-029）

API 组合根显式装配第一方 Bot 传输贡献，共用会话受理与完整执行服务。平台插件仅做登录、协议规范化、收发和连接取消；宿主管理启停、实例代际、持久队列、去重、会话来源策略和发送回执。Bot Turn 的执行归属持久化为 API，Worker 不通过简化路径接管；每个连接只由一个宿主持有。接口见[插件规范](plugin-config-and-pages.md#05-bot-传输贡献adr-029)，决定见 [ADR-029](adr/ADR-029-bot-platform-adapters.md)。

微信只接受管理页配对并确认的本人私聊，使用普通人格、记忆与 `ask` 工具审批，不进入 CAP-033。QQ 仅接收白名单群直接 `@bot` 的文字，按连接、平台账号、群与成员接续，模型只获得公开基础身份与本成员历史，不加载个人记忆、学习事实、工具、Skill、Hook、Inbox 或 DSH。来源策略随 HTTP、重试、恢复和分支继承，群来源也不得进入个人日记和记忆派生链。

这属于单用户所有的外部聊天入口：群成员不成为本地账户，也不获得 API 权限。SQLite 持有连接、入站/出站记录与平台会话映射，Bot 凭据使用独立密钥加密。API 可在本机或独立机器常驻，两处不自动复制数据库或登录态；部署、备份与真实平台验收见[连接机器人](../how-to/connect-bots.md)。

## 2. 技术栈基线

架构遵守 TypeScript-first、Web-first、模型可替换、业务数据可迁移、异步任务可重试、核心流程不依赖外部 Agent 运行时六项约束。API 保持当前与上一版本客户端兼容；Prompt、模型路由、记忆和复习算法分别版本化。扩大运行时或改变兼容边界先通过 ADR 说明数据所有权、迁移和回滚。外部运行时只通过适配接口消费，不能拥有核心业务数据。

| 层 | 选择 | 约束 |
|---|---|---|
| Runtime | Node.js 24 LTS | `engines`、容器和 CI 精确锁定；参考仓库最低 Node 22.19，适配器独立兼容 |
| Language/build | TypeScript strict、pnpm、Turborepo | 工具和依赖版本分别取 [mise.toml](../../mise.toml)、[根包清单](../../package.json)与锁文件，不在架构表另行冻结；升级需通过契约/安全测试 |
| Web | Vue 3、Vite 7、Element Plus（Vue 全栈单栈，见 ADR-015） | Web 复用桌面端 renderer 核心（composables/主题），首发是登录后流式应用；不依赖任何框架私有后端能力 |
| UI/editor | Element Plus + 定制主题（迁移自 desktop styles）、CodeMirror 6 | 组件共享、键盘可用和 WCAG 2.2 AA |
| API | Fastify 5、Zod 4、OpenAPI 3.1、POST Turn + GET SSE（Fetch 消费） | 客户端和插件通过契约访问；事件 envelope、重连、取消、幂等和安全持久化遵循[流式协议契约](STREAMING_PROTOCOL.md)；不以 tRPC 锁定消费者 |
| Database | SQLite（WAL 模式）+ Drizzle ORM + `@aervox/schema`/`@aervox/repositories` | 事务、约束、递归 CTE、全文检索；当前操作系统用户和本机 API 是安全边界；禁止跨模块直接写表 |
| Retrieval | SQLite FTS5 + VectorSearchPort；当前本地 JSON 向量评分，`sqlite-vec`/原生计算为可替换候选 | 记录 embedding 模型/维度/版本，可离线重建；MVP 不引入 Neo4j/独立向量库 |
| Queue | 本地 SQLite Outbox + Worker 轮询 | 至少一次投递、幂等键、重试、指数退避；SQLite Outbox 是持久化真源（CR-030） |
| Object | 本地文件系统目录（attachments/exports） | 本地安全存储、上传前后做大小/格式/解压比扫描；删除遵循数据 SLA（CR-030） |
| AI | 内部 `ProviderPort`：`@aervox/core` 自研 OpenAI 兼容流式 Provider（运行时零外部依赖，ADR-021） | 业务通过内部接口调用模型；本地 llama.cpp 侧车以 OpenAI 兼容端点接入（model-runtime）；模型不能直写业务表 |
| Desktop/mobile | Electron（P1）、Capacitor（后续，打包 web UI） | `contextIsolation`、关闭 `nodeIntegration`、受限 IPC、签名更新包、逐项设备授权；CAP-033 使用独立签名 Privacy Host/OS Permission Broker 管理后台和设备能力；移动端以 Capacitor 打包 Web UI（WebView 壳 + 受限桥接，不引入 RN，见 ADR-015/022） |
| Test/observability | Vitest、Playwright、Testing Library、fast-check；运行观测通过 `@aervox/observability` 与受认证 Metrics；OpenTelemetry/Pino/Grafana/Sentry 为目标选型 | 正常 CI 不依赖实时供应商；目标选型不表示全部后端已接入，日志默认不含完整用户内容 |

## 3. 仓库与领域边界

本地 `dsh_search_code` 经 API 调用受控 `ripgrep` 子进程，平台二进制由锁定的 npm 依赖分发；取消、扫描范围与资源限额见 [CR-062](adr/ADR-024-native-runtime-boundaries.md#cr-062)。向量召回仍由 SQLite 仓储执行 JSON 行扫描与有界 top-K，授权资格仍回读业务真源。`native/tools/vector-pilot` 是只读合成夹具的 Rust 计算试点，不进入默认 API/Worker 运行路径；工具版本统一锁定于 `mise.toml`。`@aervox/native-runtime` 经现有 Port 提供只读 SQLite 向量缓存、受租约控制的应用活动 Helper 与声明进程主管，具体授权、平台和生命周期差量见 [CR-063](adr/ADR-024-native-runtime-boundaries.md#cr-063)。

| 边界 | 职责与所有权 |
|---|---|
| `apps/` | API、Worker、桌面、Web、CLI 与移动壳；宿主组合根负责装配，平台桥留在各端 |
| `packages/contracts` / `schema` / `repositories` | 公共协议、数据库 Schema 与事务仓储；业务写入不能绕过仓储 |
| `packages/host-runtime` | API 与 Worker 共用产品装配、执行与权限；API 监听，Worker 调度，见 [ADR-021](adr/ADR-021-aervox-core-standalone-package.md) |
| `packages/core` | [独立 Core 仓库](https://github.com/Aervox-agent/Aervox-core)的必需 Git submodule，固定提交并作为 `@aervox/core` workspace 包消费；零运行时依赖，宿主注入持久化、Provider 与业务工具 |
| `packages/host-plugin-api` / `plugins/` | 窄接口与插件自有实现；`plugins/` 是 [Aervox-plugins](https://github.com/Aervox-agent/Aervox-plugins) 集合仓的必需固定提交子模块，保留原 workspace 包和默认产品组成；领域逻辑不回流到宿主或内核 |
| `packages/ui` / `ui-host` / `api-client` | 跨端组件、主题和传输；不依赖平台壳或数据库 |
| `native/` / `packages/native-runtime` | Rust 计算与受控进程，TypeScript 负责业务、授权、写入与生命周期 |

根界面由平台组合根选择受信第一方 UI 包，`@aervox/ui-host` 负责清单校验、加载和实例释放。工作台、桌宠、主动陪伴界面与设置面板的实现各归所属插件，`@aervox/ui` 保留跨界面构件和主题；详见 [ADR-025](adr/ADR-025-ui-surface-hosts.md)。第三方界面开放仍为 [ADR-026](adr/ADR-026-ui-surface-open-ecosystem.md) 提案。

实际包与依赖以 workspace 清单、各包清单和[导入边界守卫](../../scripts/import-boundary.mjs)为准；本表说明架构职责，不逐项镜像磁盘目录。

Core 与插件的仓库分离不改变运行时或数据所有权：API/Worker、仓储与产品装配继续由主仓维护。两个必需产品子模块的源码和受跟踪文件参与主仓门禁，`reference/` 仍为可选参考输入；Core 独立工具链与引用更新见 [ADR-021](adr/ADR-021-aervox-core-standalone-package.md#仓库分离与主仓集成)，插件在固定宿主内开发及两仓兼容规则见 [ADR-031](adr/ADR-031-first-party-plugin-repositories.md)。

原生源码由顶层 Cargo 工作区统一管理；TypeScript 接入包不拥有 Rust 源码，原生制品仍归集到 `packages/native-runtime/dist/bin/<platform>-<arch>/`。精确工具版本由 `mise.toml` 管理，Cargo 工作区继承依赖、最低版本与许可证。

```text
native/
  Cargo.toml                    # 工作区：runtime 默认成员，vector-pilot 显式运行
  Cargo.lock                    # 唯一 Rust 依赖锁文件
  protocol/                     # 内部 IPC 机读定义与跨语言夹具
  crates/runtime/src/
    main.rs                     # 运行模式与模块接线
    protocol.rs                 # 有界帧、消息校验与响应
    vector/                     # 只读 SQLite、可丢弃缓存、有界 top-K
    audio.rs                    # 可选 WAV 预处理
    activity/platform/          # macOS、Windows、Linux 采集实现
    supervisor/                 # Unix 守护通道与 Windows Job
  tools/vector-pilot/           # 合成基准，无运行时依赖
```

普通 `build` 仅生成 TypeScript 接口；`native:build` 显式生成原生制品，原生与仓储集成测试、桌面安装包和完整门禁依赖该任务。顶层原生源码、协议与构建脚本纳入 Turbo 包外输入和 CI 触发范围。每个调用客户端独立拥有进程，目录拆分不合并向量、活动与主管生命周期；需要独立签名身份或独立部署时，再评审拆分发行制品。

连接版终端入口 `apps/cli` 只消费 `@aervox/api-client/transport` 的纯传输构建出口，该子路径不加载 Vue composables；CLI 使用根目录统一管理的 esbuild 生成独立 ESM 制品，业务数据与执行权威仍在已有 API/Worker。配置与请求标识回执是宿主私有文件，CLI 不导入 API 私有模块、不直接访问业务库，也不因此新增服务端路由或授权口径；独立 Core 组合另立条目认领。命令边界、受限本机地址、审批与取消语义及兼容范围见 CR-058（已归档至 Aervox-docs-archive），实施状态与剩余差量见 [§4.2](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。

共享行为所有权由 [ADR-030](adr/ADR-030-behavior-ownership.md) 收敛：平台桥复用同一 Turn 客户端，根界面复用无视觉会话控制器；领域命令掌握事务，执行生命周期和工具授权分别具有单一所有者。插件 API 与结果投影属于宿主实例，配置由组合根解析后注入。`@aervox/sync-runtime` 提供显式启用的网络适配，`@aervox/process-coordination` 提供进程 IPC；默认仓储入口只暴露数据能力，同步数据适配通过 `/sync` 子入口消费。

### 3.1 共享产品宿主结构（演进式模块化单体）

`packages/host-runtime/src/` 采用**按领域模块组织**的结构（ADR-014 0.3.0 两层分组：25 模块 → 6 域，归属表见 `CR-052 §3.1`（已归档）），每个模块自管路由与仓储实例化。持久异步副作用使用 SQLite Outbox 由 Worker 投递，同步能力经公开 Port/组合根注入，进程内 UI 唤醒不代替持久事件；实际所有权收敛仍由边界守卫与专项验收证明：

```text
packages/host-runtime/src/
├── modules/                        # 业务模块（按领域分组，每个自管 routes + 依赖注入）
│   ├── companion/                  #   陪伴与对话域
│   │   ├── conversation/           #     Session、Turn、Message、SSE 流式（Agent Loop 编排）
│   │   ├── persona/                #     人格设定与画像
│   │   ├── memory/                 #     长期记忆 FTS + 向量混合召回
│   │   ├── inbox/                  #     Agent 命令收件箱
│   │   └── branch/                 #     会话分支（CAP-014 会话地图）
│   ├── learning/                   #   学习与练习域
│   │   ├── learning/               #     目标、题目、作答、知识点、复习
│   │   ├── study-materials/        #     学习资料与附件
│   │   ├── terms/                  #     伴学术语表
│   │   └── diary/                  #     每日日记查询、计划、窗口调度
│   ├── knowledge/                  #   知识与内容域
│   │   ├── knowledge/              #     知识库
│   │   ├── content/               #     内容与附件元数据
│   │   └── project/               #     项目上下文（CR-048）
│   ├── ecosystem/                  #   扩展生态域
│   │   ├── plugins/               #     插件系统与内置插件同步
│   │   ├── tools/                 #     工具运行时
│   │   ├── mcp/                   #     MCP 集成
│   │   ├── skills/                #     AstrBot 兼容技能
│   │   ├── llm/                   #     模型路由与预设
│   │   └── model-runtime/         #     本地模型运行时驱动（llama-server 等）
│   ├── proactive/                  #   主动智能域
│   │   ├── proactive/             #     主动回合编排、集成授权
│   │   └── notification/          #     主动关怀通知
│   └── platform/                   #   平台基础域
│       ├── preferences/           #     偏好
│       ├── privacy/               #     同意授权、撤回、删除请求
│       ├── safety/                #     安全门禁
│       ├── voice/                 #     语音服务
│       ├── feedback/              #     用户反馈
│       └── analytics/             #     埋点
├── shared/                          # 跨模块共享（严格限制：只放通用工具）
│   ├── auth.ts                      #   本机认证与 actor 解析；CR-030 后不再创建 TenantContext
│   └── errors.ts                    #   共享错误类型（NotFoundError、ValidationError 等）
├── runtime.ts                       #   Fastify 应用工厂：组装模块、注册路由（按域分组注释）
└── index.ts                         #   公开导出；监听入口在 apps/api/src/index.ts

apps/api/test/                       # 集成测试
  └── api-integration.test.ts
```

**核心约束**：

| 规则 | 说明 |
|---|---|
| 领域分组 | `modules/<domain>/<module>/` 两层组织；域目录不承载代码，只承载子模块；归属以 CR-052 §3.1 表为准 |
| 模块自管仓储 | 每个 `modules/<domain>/<module>/index.ts` 内部实例化该模块的仓储，不引用全局容器 |
| 路由函数签名 | `routes.ts` 导出函数接收**该模块专属的仓储实例**，而非 `RepoContainer` |
| shared 严格受限 | `shared/` 只放跨 2 个以上模块的通用工具，禁止放业务逻辑 |
| 跨模块通信 | 同步 Query/Command 使用窄公开 Port；可靠事实和后台工作写入 SQLite Outbox，由 Worker 投递；可丢通知只作唤醒/表现，不作为提交证明；业务原子性由领域命令负责 |
| 单一数据库 | 一个本地 SQLite 实例；Schema 按领域拆文件，安全边界不依赖表前缀或租户列 |
| 对外入口唯一 | 每个模块只有 `index.ts` 对外可见，`routes.ts` 内部函数不被其他模块引用；host-runtime 包仅导出根入口、明确列出的 shared 工具和模块 index。私有实现测试通过 Vitest 内部别名访问，该别名禁止用于产品源码 |

**模块与仓储对应关系**：

| 模块 | 仓储（来自 `@aervox/repositories`） | 对应路由前缀 |
|---|---|---|
| conversation | `SqliteConversationRepository` | `/v1/sessions/*`, `/v1/turns/*`, `/v1/messages` |
| learning | `SqliteLearningRepository` | `/v1/learning/*`, `/v1/questions/*`, `/v1/review-items/*` |
| diary | `SqliteDiaryRepository` | `/v1/diaries/*` |
| feedback | `SqliteFeedbackRepository` | `/v1/feedback` |
| privacy | `SqlitePrivacyRepository` | `/v1/consent*`, `/v1/deletions` |
| analytics | `SqliteAnalyticsRepository` | `/v1/analytics/events` |
| content | `SqliteContentRepository` | `/v1/attachments/*` |
| notification | `SqlitePlatformRepository` | `/v1/notifications` |

**与 ADR-001 的关系**：本结构是 ADR-001（模块化单体）在 API 层的细化设计，由 ADR-014 记录完整决策。实现通过公开 Port 和组合根替换；跨进程拆分须重新验证事务、幂等和失败模式，不承诺零业务改动。CR-056 首轮保持现有部署形态。

<a id="avx-web-001"></a>

### 3.2 跨端工作台与平台壳

Web 与桌面组合根按平台装配第一方根界面，并复用 `@aervox/ui` 的主题、设置与工作台组件；桌面默认是角色居左、轻量工具与底部对话输入的经典陪伴布局，移动默认使用主动陪伴入口，完整/紧凑工作台仍可选择，通过 `@aervox/api-client` 消费同一 API/SSE 合同。Web 使用 Fetch 传输，Electron 注入受限 IPC 传输；重连、去重与 `Last-Event-ID` 语义相同。平台组合根注入能力，不让共享组件依赖 Electron 或 Capacitor。

两端主工作台均可显示共享 `Live2DPet`；Electron 另保留 `pet.html` 独立桌宠窗口、标题栏和窗口控制。Web 不提供 Electron 窗口能力。空间名「思隅」固定；角色名默认「小隅」，用户称呼默认「你」，可在对话设置修改。提示词优先采用当前人格名，再采用客户端角色名；界面设置不直接改写服务端人格，见 [ADR-027](adr/ADR-027-companion-identity.md)。设置共用左侧分类/右侧详情结构，窄屏采用横向分类；主题、角色名、用户称呼、发送偏好、密度和提醒保存在当前设备，桌面主题通过受限 IPC 同步壳窗口。

公共组件在实际跨端复用且开始分叉时才上收，页面壳、窗口管理与平台通道继续留在各端。移动 Capacitor 壳的存在不等于原生平台交付，其认证、跨设备授权、打包与实机要求见 [ADR-022](adr/ADR-022-mobile-runtime-access.md)。API 默认只监听 loopback，远程监听须通过 Token 和来源安全校验。

#### 3.2.1 桌宠多形态渲染引擎

桌面端与 Web 端共用一套协议契约与 SSE `emote` 情感表现，支持三种按需渲染模式：

1. **CSS 骨架（`PetHero`）**：纯静态 DOM + CSS 变换驱动动作与表情，零外部素材依赖，极速轻量启动。
2. **Codex 精灵图（`SpritePet`）**：消费标准 9 状态 Spritesheet（`pet.json` + 8×9 atlas），支持依据工具调用成败（`waving` / `failed`）实时改变姿态。
3. **Live2D 动态模型（`Live2D`）**：加载标准 Live2D Cubism 模型（真源位于 `packages/live2d/mizuki`），在 Web 与桌面独立桌宠窗口中呈现细腻骨骼动作，加载异常时自动平滑回退至 CSS 骨架。

领域模块：

- **Local Profile & Consent**：本地用户档案、年龄组、同意、actor 和设备授权；不提供共享数据库身份租户。
- **Conversation**：Session、MessageVersion、引用和真实分支；消息是会话内容真源。
- **Learning**：目标、知识点、计划、掌握度观测/推断。
- **Practice & Review**：题目、作答、错题和调度器。
- **Memory**：四段记忆、证据、冲突、晋升、衰减、树投影和删除传播。
- **Diary**：计划、滚动窗口素材缓冲、生成运行、版本、段落来源和通知。
- **AI Runtime**：上下文组装、模型路由、Prompt、工具权限代理、结构验证。
- **Safety**：输入/输出分类、固定危机响应、人工升级和安全审计。
- **Content/Ingestion**：附件、OCR、引用、许可和不可信输入隔离。
- **Integrations/Plugins**：OAuth、外部同步、适配器、沙箱和权限代理；P2 才启用。
- **Community/Organization**：P3 独立模块，不能提前污染单用户数据权限模型。

跨模块只能调用公开服务接口或发布领域事件。会话和日记只能提交“记忆候选”；只有 Memory 模块能写 `MemoryRecord`/`MemoryRevision`。画布是可重建投影，不复制会话正文。

## 4. C4 级别部署视图

### 4.1 System Context

```text
[Learner / Creator]
                  │ uses and controls personal data
                  v
             [Aervox System]
      ┌───────────┼──────────────┐
      v           v              v
[Local Auth] [AI Providers] [External Integrations]
 loopback+Token inference only  by consent (ADR-019)
      │           │              │
      └────── contractual privacy/security boundaries ──────┘

[External Content/Question Banks] <-> [Aervox Integrations]
[DSH/pi/MCP Plugins]               <-> [Permissioned Adapters]
```

本地用户数据的控制面始终在 Aervox；模型、通知、外部题库和插件均为外部信任边界。任何外部方只能获得已批准 purpose/scope 的最小数据，且必须支持撤销、故障隔离和审计。

### 4.2 Containers

```text
Web (:5173) / Electron Fairy / CLI / Mobile 壳
          │ HTTP/SSE（默认 loopback，非 loopback 强制 Token）
   API（Fastify 5 单实例，模块化单体）
        ├── SQLite 主库 aervox.db（业务真源 + FTS5，WAL 模式）
        ├── SQLite Outbox（事务性队列）
        ├── Local Filesystem（attachments/exports/skills）
        ├── proactive Vault（CAP-033 加密独立库）
        ├── RecoveryControlLedger（独立故障域控制事件）
        └── Model Provider Gateway（远程 OpenAI 兼容端点或本地模型侧车）

API ── Domain Socket IPC（wake/pressure/ping）──> Worker（独立进程）
Worker ──> SQLite Outbox 轮询消费（至少一次投递 + 幂等 + DLQ）
        ├── memory / diary / embedding / review
        ├── deletion / inbox-expiry / attempt-recovery
        └── proactive 派生与画像提炼

各进程 ──> 结构化日志（stdout）+ GET /v1/metrics（Prometheus 文本/JSON）；OpenTelemetry 为目标基线
```

CR-030 后的部署形态为单机本地实例：共享数据库多租户、CDN/WAF 与无状态水平扩展不再是本架构组件，客户端与本机 API 之间的 loopback 加 Token 即信任边界。

CAP-033 的主动智能路径与普通本地数据路径分离：

```text
Electron Shell
  -> signed Local Privacy Host / OS Permission Broker
      -> device/app/browser/file/communication/media/location adapters
      -> encrypted local proactive_* store
      -> local profile inference + FullProfileActionGrant gate
      -> user-visible notification / export / revoke
```

该路径不把原始捕获、画像、动作或控制面送入 API、远程 Provider、普通 Outbox、分析或自动云备份；控制面仅接受私密目录 `0600` 的 owner-only `proactive-access.token`、字面 loopback 请求并拒绝 redirect。Host 崩溃、租约过期、OS grant 撤销或本地证明失效时进入 `suspended`，核心学习流程继续可用。

用户消息、答题和权限变更先在 SQLite 事务中落库，同时写 Outbox；API 再流式请求模型。记忆、日记、附件、嵌入和通知异步执行。客户端不能直接调用模型服务；附件通过 `POST /v1/attachments` 直传并落盘本地附件目录，API 在提交前检查授权和扫描状态。

### 4.3 关键组件与信任边界

| 容器 | 关键组件 | 可写数据 | 外部信任边界 |
|---|---|---|---|
| Web/Desktop/Mobile | UI、离线草稿、流式渲染、授权界面 | 本地最小草稿/设置 | 浏览器、OS 权限、Electron IPC |
| API | Local Auth/Consent、Conversation、Learning、Review、Context Builder、Provider Gateway | SQLite 领域表、Outbox；默认仅通过 loopback 提供服务 | AI Provider、本地文件系统 |
| Worker/Scheduler | Memory、Diary、OCR、Embedding、Notification、Deletion Orchestrator | 各领域模块公开仓储；不得绕过来源、授权和删除状态；Job 以业务实体/来源修订幂等 | 本地队列、本地附件目录、通知供应商 |
| Plugin Host（P2） | Manifest、Policy Proxy、Adapter、Kill Switch | 插件自有状态；核心数据只经命令/候选 | 第三方代码和远程 Host |
| CAP-033 Privacy Host（P3） | signed observation/action Host、OS Permission Broker、activation lease、source adapters | `proactive_*` 本地授权/捕获/画像/动作/审计表；全链 `local_only` | 操作系统、文件/浏览器/通信/设备能力、用户导出目标 |
| CAP-033～035 主动智能与连接网关（P3） | 十二能力 Worker、Home Assistant REST/WS、小米健康 OAuth/每日同步、ToolRuntime handlers | `proactive_timeline_*`、项目/流程/触发/回顾、外部连接、HA 实体和健康样本；连接凭据加密 | 私网 Home Assistant、用户获准的小米开放平台、桌面设置与 Agent 工具 |
| Recovery Control Ledger | 删除、Consent/Plugin/External Grant 撤销的最小控制事件、单调序列、防篡改证据 | 独立账号/凭据/保留策略的追加写存储；不含用户正文 | 与业务 SQLite 和其备份分离故障域 |
| Observability | trace/metrics/脱敏日志 | 运行元数据，不得成为用户内容副本 | 监控/错误平台供应商 |

当前分支的 CAP-033 实现覆盖本地 Vault、授权/lease、动作授权器、已接入来源、Worker 提炼、十二项主动智能派生、日/周回顾、导出和后台 heartbeat；CAP-034 已接入 HA 私网 REST/WS、实体/service 白名单和受控工具，CAP-035 已接入可配置的小米官方开放平台每日指标与只读工具。其它平台来源、生产签名 Host/OS Broker、HA OAuth/重连矩阵和小米真实厂商沙箱仍是发布门禁，不能据此宣称全部平台能力已发布。

主要威胁与架构控制：

| 威胁 | 控制 | 验证 |
|---|---|---|
| 未认证远程访问或其他本机用户读取私人数据 | loopback 默认、非 loopback 强制 token、用户私有目录 ACL、插件 Grant 和脱敏日志 | `TC-SEC-LOCAL-API-001`、`TC-SEC-LOCAL-FS-001` |
| Prompt injection/恶意附件 | 不可信上下文分区、工具权限代理、扫描、引用验证 | `TC-SEC-PROMPT-001` |
| 插件远程代码执行/数据外泄 | 进程外沙箱、默认无权限、签名、Host allowlist、配额和 kill switch | `TC-SEC-PLUG-001` |
| 删除后数据复活 | `RecoveryControlLedger` 撤权先行、DeletionTargets、零召回验证、恢复前校验水位并按序重放 | `TC-PRIV-DEL-001`、`TC-RES-LEDGER-001` |
| 供应商保留/训练超出用途 | Provider metadata、合同/地区/保留审查、脱敏、可替换路由 | `TC-PRIV-PROVIDER-001` |
| Electron 主进程越权 | contextIsolation、禁用 nodeIntegration、schema 化 IPC、签名更新 | `TC-SEC-DESKTOP-001` |
| CAP-033 原始数据外传/错误清理 | 本地私密存储、Provider/出网准入、`local_only` provenance、七天+提炼门、撤权零召回 | `TC-SEC-PRO-LOCAL-001`、`TC-PRIV-PRO-RETENTION-001` |
| CAP-033 主动动作越权 | `FullProfileActionGrant`、目标 scope/授权修订、OS/身份校验、幂等、沙箱、deny ledger | `TC-SEC-PRO-ACTION-001`、`TC-SEC-PROMPT-001` |
| CAP-034 HA SSRF/越权控制 | 私网解析、redirect 拒绝、实体默认禁用、service 白名单、`action.external` 动作账本 | `TC-SEC-HA-SSRF-001`、`TC-SEC-HA-ACTION-001` |
| CAP-035 健康凭据或敏感指标泄露 | Vault 加密、响应最小化、Restricted 分级、只读工具、连接级删除 | `TC-PRIV-EXT-CREDENTIAL-001`、`TC-PRIV-HEALTH-001` |

### 4.4 关键时序：对话到记忆

```text
Client -> API: POST /turns + idempotency key
API -> SQLite: Turn + MessageVersion + Outbox (one transaction)
API -> Safety: input classify
API -> Context Builder: consent-filtered ContextManifest
API -> Provider: stream into bounded segment buffer
API -> Safety/Validator: per-segment checks
API -> SQLite: committed segment + TurnStreamEvent + ModelRun + Outbox
Client -> API: GET /v1/turns/{id}/events (Fetch SSE, Last-Event-ID)
API -> SQLite: finalize Completed/Rejected/Cancelled/Interrupted/Failed Turn + done event
Worker -> Memory: create candidate, validate sources, version revision
Memory -> Tree Projection: rebuild affected nodes/edges
```

### 4.5 关键时序：删除

```text
Client -> API: delete source
API -> RecoveryControlLedger: append immutable deny/revoke event and receive durable ack
API -> SQLite: idempotent deny projection + DeletionRequest/Targets + Outbox
API -> Retrieval/Context: immediate deny
Worker -> DB/Outbox/FTS/Vector/Files/Diary/Memory/Suppliers: clear or rebuild
Worker -> Verification: zero-recall + target evidence
Verification -> DeletionRequest: Completed or Failed + alert
Restore process -> RecoveryControlLedger: verify signature/sequence/watermark + replay before serving traffic; fail closed on gaps
```

<a id="arch-consistency"></a>

## 5. 关键数据与一致性

SQLite 是业务真源，仓储负责写事务。会话消息与作答是事实，摘要、记忆树和日记是带来源的派生结果；插件、连接器通过窄接口提交意图。权限撤销与删除先形成可恢复的控制证据，业务投影不能覆盖控制账本事实。

数据字段、投影覆盖、日记 CAS/fencing、账本持久确认与恢复水位见[数据库契约](DATABASE.md)。迁移优先 expand/contract；破坏性换库必须按[迁移演练](../how-to/run-database-migration-drill.md)执行。用户历史保留与 AI 召回期限是两个独立合同。

## 6. 四段记忆流水线

```text
Captured
  -> ShortCandidate
  -> ValidatedShort
  -> LongCandidate
  -> ActiveLong
  -> TreeProjection
  -> Decayed / Invalidated / Deleted
```

分层晋升、用户确认、来源纠错与树投影规则见 [SRS 记忆业务规则](SRS.md#3-记忆业务规则)，数据字段和重建职责见[数据库契约](DATABASE.md)。

<a id="arch-ai-security"></a>

## 7. AI 编排与安全

```text
鉴权/限流
  -> 输入安全分类
  -> 意图/任务类型
  -> 按权限构建 ContextManifest
  -> Provider 路由 + PromptVersion
  -> 工具权限代理
  -> Turn 持久化
  -> 分段缓冲与安全/结构校验
  -> 提交可见片段 + Outbox
  -> 记忆候选/评估事件
```

统一 Provider 能力面是架构目标：`ProviderPort` 至少支持 `streamText`、`generateObject`、`embed`、`classify`，并声明上下文长度、成本、数据地区和能力。当前 Core 对话执行接口是 `ModelProviderPort.stream`，embedding/分类等仍由独立 Port/服务承载，不能据目标接口推定两栈已统一；剩余见 [ITER-033](../../plan.md#iter-033)。流式协议采用 POST 创建 Turn + GET SSE，事件使用 Turn 内单调 `eventId/sequence` 和 `Last-Event-ID` 重连；供应商输出先进有界分段缓冲，逐段通过安全/结构检查并持久化后才展示。TTFT 从 Turn 持久化接受时刻起计到首个已安全检查且持久化的可见分段，另记端到端首段渲染延迟。当前每次实际模型调用记录 ModelRun 与 ContextManifest，包括失败调用、请求快照、可选 usage 和耗时；诊断 best effort 不等于授权/恢复账本。目标要求关联模型、供应商、Prompt 版本、token、成本、失败和安全决策，并默认不复制完整敏感 Prompt；当前快照仍包含完整 messages/tools 正文，最小化与来源删除传播的实现差距见[追踪基线](REQUIREMENTS_TRACEABILITY.md#privacy-gates)，不视为已满足隐私发布门槛。

附件、网页、插件输出和外部题库都是不可信数据，不能覆盖系统提示或直接触发工具。模型只能请求工具，权限代理根据用户授权和工具策略作最终决定。CAP-033 主动动作还需校验 `FullProfileActionGrant`、目标 scope、设备 lease 和本地处理证明；用户确认后可覆盖声明的本地、外部、特权和不可逆动作，但模型/插件不能自授。第三方插件的安全目标是默认无数据库、文件、网络、记忆和日记权限，远程能力隔离、桌面执行使用受限子进程；Node `vm` 不作为安全沙箱。当前第一方受信贡献在宿主内装配，Page 静态隔离已实现，第三方代码执行开放与进程沙箱仍待 ITER-019，不能用 Page iframe 推定代码隔离已交付。

## 8. 日记调度与时区

Worker 消费到期计划，日记周期拥有素材窗口，执行 Attempt 拥有一次尝试；日期标签不能替代窗口身份。调度变更通过版本和租约隔离旧任务，发布与游标推进由同一事务提交。

UTC/IANA 时区、首次窗口、迟到素材、补写、CAS/fencing 与跨时区规则见[数据库契约](DATABASE.md)和 [ADR-011](adr/ADR-011-diary-cycle-schedule-revision.md)。任务调度频率以 Worker 配置为准。

<a id="arch-nfr"></a>

## 9. 非功能、容量与灾备

性能、可用性、日记发布、删除与灾备指标只维护在 [SRS 非功能需求](SRS.md#srs-nfr)。部署容量按本机 CPU、内存、磁盘 I/O 与 SQLite 写入吞吐测量；云端多用户容量基线已取消，不作为本地发布达标依据。云端可用性及 RPO/RTO 的本地适用目标仍待复审，见[未决事项](REQUIREMENTS_TRACEABILITY.md#operational-decisions)。

运维告警目标覆盖 API 错误、TTFT、队列延迟/DLQ、日记迟到、来源验证失败、删除积压、AI 成本和安全分类异常。逐场景恢复操作见[运行手册](operations.md)。

### 9.1 成本与供应商降级

以下阈值与动作是待批准预算下的目标策略；现有 usage 采集和降级路由不证明全部百分比熔断已接入。实际发布状态仍以追踪基线证据为准。

- 会话/月度成本预算的待批准数值见[未决事项](REQUIREMENTS_TRACEABILITY.md#operational-decisions)，预算未确定前不以估算冒充已通过成本门槛。
- 预算达到 70% 触发预测告警，85% 停止非核心高成本任务（自动扩展阅读、批量重写等），100% 只保留已批准的核心模型/固定降级；不得通过降低安全分类或删除能力省钱。
- Provider 路由记录模型能力、地区、保留、成本、限流和健康状态。超时/5xx/限流达到熔断阈值后切换已评估备用模型；无合格备用时保留输入并显示可重试状态。
- 队列以 SQLite Outbox/ScheduledJob 为真源；消费者使用幂等键和水位线，重放后执行重复结果检查，崩溃重启后自动从 Outbox 恢复未完成作业。

## 10. 参考项目适配边界

- `BaiShou-Next` 的 TypeScript monorepo、AI SDK、Drizzle、Electron/Expo、SQLite/Markdown 导出和日记/记忆设计用于模式验证；其 AGPLv3 代码不进入核心服务，除非完成许可证评审。
- `dsh-synapse` 的会话分支和“内容真源/画布投影分离”用于 P1 设计；画布只保存节点位置、折叠、锚点和真实 ID，不复制会话内容。
- `deepseek-harness`、`pi`、DSH、ACP/RPC 和 MCP 通过 `adapter-dsh`、`adapter-pi`、`adapter-mcp` 可选接入；版本精确锁定、契约测试和全局 kill switch 必须存在。
- 参考仓库不是运行时依赖。MVP 核心学习、记忆、日记、删除和导出流程必须在不安装这些仓库的情况下可用。

## 11. 首批 ADR

技术决定见唯一的 [ADR 索引](adr/README.md)。

每个 ADR 需要记录上下文、备选方案、决策、后果、迁移和回滚。未批准的技术建议不能写成已承诺架构。

决策状态由各 ADR 的 `decision_status` 维护，[ADR 索引](adr/README.md)仅导航，不复制状态；`Accepted` 只表示方案获接受，不代表代码、运行接线或发布验收已完成。交付与剩余差量见[追踪基线](REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)，例如 [ADR-018](adr/ADR-018-proactive-local-privacy-host.md) 的 CAP-033 仍有 Privacy Host、授权与恢复门禁。ADR-002/008 已分别由 ADR-015/CR-030 替代；ADR-020 随 PR #232 回退退役，原文保留在归档库，编号不复用（见 [ADR-021](adr/ADR-021-aervox-core-standalone-package.md)）。

### 11.1 技术版本冻结规则

工具版本由 [mise.toml](../../mise.toml) 管理，依赖由包清单与锁文件管理；文档不复制版本号清单。主版本升级须核对 peer dependency、Node ABI、Electron、参考适配器、许可证与 SBOM，并运行构建和兼容回归。改变架构边界使用 ADR，普通依赖维护通过 PR 记录验证。

## 12. 架构发布门禁

- C4、数据所有权、威胁模型、容量/成本、备份恢复和删除传播评审通过；
- OpenAPI/事件契约无未批准的破坏性差异；数据库迁移可回滚，或像 CR-030 一样具备已批准的停写、备份、显式范围选择、staging 校验和原子换库协议；
- 记忆、日记、附件、插件和外部同步均有幂等、撤销、权限和 DLQ 测试；
- 依赖、许可证、SBOM、Secret scan、漏洞扫描和参考项目许可边界通过；
- Playwright 覆盖学习闭环、日记、删除、导出和弱网恢复；AI 回归集覆盖教学、安全、来源、过度压缩和删除后零召回；
- 演练证明模型供应商中断、SQLite 备份恢复、原子换库与回滚、本地附件恢复、Outbox 队列重放和功能开关回滚可执行。
- CAP-033 另须证明本地出网阻断、全量来源授权、七天捕获提炼清理、后台自启/恢复通知、全动作授权/撤权和独立可读导出；未通过相应授权与发布门槛前不得扩大真实广域数据采集。
- CAP-034/035 另须证明 HA 重连/版本矩阵、真实 OAuth/LLAT 撤销、小米厂商沙箱契约、凭据零回显和连接级删除；通过前保持 `Not Ready`。

### 12.1 可执行边界检查

代码守卫检查导入方向、禁用租户标识、宿主领域纯净性、DTO 单一来源、依赖提升和实现可移除性；仓储回归检查 Drizzle Schema 与 SQLite DDL 等价。具体任务见 [package.json](../../package.json) 和 [mise.toml](../../mise.toml)，文档不复制守卫数量或包目录清单。

文档检查覆盖格式、术语、稳定编号、ADR 状态与本地链接；不会要求生成目录、状态镜像或计划队列。修改文档不改变代码守卫的安全边界。

<a id="AVX-EXPL-002"></a>
<a id="reference-learning"></a>

## 13. 参考项目学习与固定源码证据

本章统一维护参考版本、许可证、源码对照与借鉴取舍。复核基线为 2026-10-14 的思隅 `151c36bf`，不是持续跟随上游的能力声明；版本更新不改变 §1～§12 的现行架构。研究建议获选后进入根 `plan.md`，实际能力和发布门槛只在追踪基线维护。

### 13.1 固定版本与许可边界

<a id="reference-manifest"></a>
<a id="prd-reference-manifest"></a>
<a id="101-参考实现要求"></a>

八个项目均固定到 2026-10-14 抓取时上游默认分支 HEAD。固定参考头不是稳定发布或外部运行时集成验收。

| 本地路径 | 上游项目 | 固定 commit | 许可证 | 复核日期 |
|---|---|---|---|---|
| `reference/baishou-next` | BaiShou-Next | `91c8d9fcf5bf6524e67f96b1c5146eb107b736ca` | AGPLv3；美术资产单独许可 | 2026-10-14 |
| `reference/dsh-synapse` | dsh-synapse | `847b712b14579ca5e5c5fcf414f4559589c44d93` | MIT | 2026-10-14 |
| `reference/deepseek-harness` | DeepSeek Harness | `d743267388641bc76f17c45ce8b4c231aed1d32c` | MIT | 2026-10-14 |
| `reference/pi` | pi monorepo | `6374c2baf432419ccb4541a99ce4958ecd03dae0` | MIT | 2026-10-14 |
| `reference/AstrBot` | AstrBot | `6ca3931925ab60a05c638fd66cb3c977b0d97f39` | AGPLv3 | 2026-10-14 |
| `reference/Petra` | Petra | `d34e6add082ff388ff57b0e4a0da931770067bd0` | MIT；第三方资源单独许可 | 2026-10-14 |
| `reference/OpenMAIC` | OpenMAIC | `ecb940c136cc5b4ea56dc81b2505e64eff1dea29` | MIT | 2026-10-14 |
| `reference/archify` | archify | `c21c31ffb879668900c5487ea24993bf45d89b15` | MIT | 2026-10-14 |

- 参考仓库的行为和 API 只能通过固定 commit 复核，升级时需记录变更原因和回归结果；
- 任何从参考项目复制或改写的代码，都必须在实现设计中记录文件来源、版权声明和许可证影响；
- BaiShou-Next 与 AstrBot 当前均采用 AGPLv3。除非完成许可证评审并接受网络服务开源义务，否则只借鉴公开设计和数据模型，不直接复制其代码或形成链接依赖；
- dsh-synapse 当前采用 MIT，可作为较低风险的交互和插件实现参考，但仍需独立检查其对 DSH 版本、Node.js 版本和 Web profile 的依赖；
- Petra 当前采用 MIT，可作为较低风险的表现与交互实现参考，但仍需独立检查其对 Tauri、pixi.js 版本与 Windows 平台的依赖；
- 参考项目不是本产品的运行时依赖。MVP 的核心学习流程必须在不安装 BaiShou-Next、AstrBot 或 dsh-synapse 的情况下正常运行。

<a id="upstream-20261014"></a>

### 13.2 更新区间与审查范围

更新目标为 **2026-10-14 抓取时各上游默认分支的 HEAD**，不是最大版本标签或稳定发布承诺。八个旧提交均为新提交的祖先；各子模块更新前后工作树干净，更新后以 detached HEAD 固定；本地 `refs/archive/reference-upstream-2026-10-14` 保留旧提交，原本的本地分支未重置。

| 项目 | 默认分支 | 更新前 → 更新后 | 区间提交数 | 新提交的包版本 |
|---|---|---|---:|---|
| DeepSeek Harness | `master` | [`639ed015` → `d7432673`](https://github.com/deepseek-ai/deepseek-harness/compare/639ed015397290b3745d163aafe02ffee4aa3f84...d743267388641bc76f17c45ce8b4c231aed1d32c) | 935 | `0.2.1-alpha.2` |
| pi | `main` | [`5257d0d5` → `6374c2ba`](https://github.com/earendil-works/pi/compare/5257d0d5f3ab7d42550804f32c67a77b49f485d4...6374c2baf432419ccb4541a99ce4958ecd03dae0) | 360 | coding-agent `1.2.0` |
| AstrBot | `master` | [`b53999e9` → `6ca39319`](https://github.com/AstrBotDevs/AstrBot/compare/b53999e959cfc3b71d7b74713ddee837be843fcb...6ca3931925ab60a05c638fd66cb3c977b0d97f39) | 82 | `4.29.0-beta.2` |
| BaiShou-Next | `main` | [`d95bae0f` → `91c8d9fc`](https://github.com/foxletters-hq/BaiShou-Next/compare/d95bae0f6f3184a94bbc3a77eb71ca987bfcadba...91c8d9fcf5bf6524e67f96b1c5146eb107b736ca) | 27 | Desktop `1.2.17` / Mobile `1.2.25` |
| OpenMAIC | `main` | [`9a28ca39` → `ecb940c1`](https://github.com/THU-MAIC/OpenMAIC/compare/9a28ca39d556f759bf3e62f83b8b58a2319a4ff2...ecb940c136cc5b4ea56dc81b2505e64eff1dea29) | 228 | `1.2.0-rc.2` |
| Petra | `master` | [`b629b295` → `d34e6add`](https://github.com/Wumiu/Petra/compare/b629b295b5ae535d80e09cd59bd3d515bcd8150f...d34e6add082ff388ff57b0e4a0da931770067bd0) | 120 | `0.3.1` |
| archify | `main` | [`06dd0526` → `c21c31ff`](https://github.com/tt-a1i/archify/compare/06dd052602dd9a369e4d034e24faef0917b5a60c...c21c31ffb879668900c5487ea24993bf45d89b15) | 1,238 | `3.1.0` |
| dsh-synapse | `main` | [`a323f76b` → `847b712b`](https://github.com/liangmianya/dsh-synapse/compare/a323f76b0c47ffad59194d8ac7efacb3aa6bdfba...847b712b14579ca5e5c5fcf414f4559589c44d93) | 19 | `0.4.2` |

提交数为 `git rev-list --count old..new`，包含合并历史，不能当作功能数量。完整固定 SHA 与许可证统一见[固定清单](#reference-manifest)。DSH、pi、OpenMAIC 和 archify 的变更量较大，本次审查聚焦与思隅相关的控制流、存储、模型请求和交互故障路径，不声称逐行审完全部变更。

思隅代码对照基线为 `151c36bf`（抓取时 `origin/main`）；另外只读检查了插件生命周期提交 `511f9d1e`（现由 PR #277 承接），该分支已有的插件生命周期改进也计入判断。本次在独立 `docs/reference-upstream-audit-2026-10-14` 分支交付，没有将该并行改动带入提交。

### 13.3 思隅现状复核与剩余差量

参考项目比较仍冻结于 §13.1/13.2 的版本；下表对照当前主线纠正旧判断。历史反例不直接证明今天仍存在同一缺陷，详细旧证据见[归档快照](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/docs/reference/ARCHITECTURE.md)。

| 历史评估中的判断 | 本次实际检查 | 真正剩余的问题 |
|---|---|---|
| ContextManifest 只保存首个 Step | [recording-provider](../../packages/core/src/recording-provider.ts) 已对每次实际请求复制消息、工具和生成参数；[多 Step/重试测试](../../packages/core/test/context-manifest.test.ts)已覆盖 | 诊断写入仍为 best effort，不能当作恢复或授权账本；新建议应聚焦实际使用的策略版本及消费链路 |
| 规则压缩只留首尾并伪称生成摘要 | [context-builder](../../packages/core/src/context-builder.ts) 已保留 system 和完整工具组，并明确提示被省略的消息没有生成摘要；[测试](../../packages/core/test/audit-provider.test.ts)验证配对 | 仍未实现保真摘要；应验证学习目标、错因、承诺和来源的保留，以及摘要失败后的明确降级 |
| 需要新增缓存 Token 分账字段 | [Provider](../../packages/core/src/openai-compat-provider.ts) 已解析缓存读写用量，[存储工具](../../packages/repositories/src/token-usage.ts)也已有分账 | [ModelRunRecord](../../packages/core/src/types.ts)及 recording-provider 已传递可选 usage，[API 装配](../../packages/host-runtime/src/modules/companion/conversation/agent-executor.ts)写入 tokenUsage；缺失上游用量不伪造为零，实际策略版本、成本估算与诊断消费仍需分别核验 |
| 插件注册失败没有 owned lifecycle | PR #277 已合入 owned activation、暂存注册、失败回滚和 scope 失效；声明包 generation 的原子激活切片另由 ADR-028 和 PR #281 交付 | 注册生命周期和分发包升级是不同问题；仍应独立审查安装目录、持久状态、恢复日志和进程崩溃，不能重复建设已有注册层 |

### 13.4 八个项目的实际增量与迁移取舍

#### 13.4.1 DeepSeek Harness：资源活到最后一项工作退出

`8d488a66ac` 收紧 Agent 关闭顺序：先停止接单，再等活动 Agent 和尚未完成的创建任务全部结算，最后释放会话投影；个别释放失败不能提前撤掉其他任务仍需要的资源。回归专门构造 0、1、2 个失败 teardown，验证维护任务退出时投影还存在，随后才卸载。思隅[Host](../../packages/host-agent/src/agent-host.ts)已有停止领取和 drain，借鉴点是补“创建中停止、释放抛错、父子同时关闭”的资源所有权夹具，并保留有界停机；不能只复制 `allSettled` 后无期限等待。

证据：[停止接单并等待全部结算](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/index.ts#L145)、[失败 teardown 与投影存活测试](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/tests/resource-lifecycle.spec.ts#L19)。

`9c679b21f4` 将运行环境刷新推迟到真正发起模型请求时，覆盖组装后、Provider 准备期间目录和权限变化；测试直接断言最终请求与会话投影重建结果相等且冻结。思隅已经逐请求保存快照，值得补的不是第二个 ContextManifest，而是“排队或准备期间撤权/换目录/切模型之后，最终输入、实际执行与记录仍一致”的夹具。权限提示不能替代工具执行时的授权校验，也不需要迁入 DSH JSONL 或 Cordis。

证据：[最终请求前刷新上下文](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts#L400)、[目录/权限变化与请求投影一致性](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/working-directory/tests/admission.spec.ts#L14)。当前是 alpha 版本且变更面很大，采用某个模式和验证整套宿主兼容必须分开。

#### 13.4.2 pi：收敛核心职责，让阻塞失败可见

架构变化比版本号更值得关注：`7fd478a2e` 删除 `pi-agent-core` 中实验 Harness、会话存储等入口，低层包保留 Agent、loop、proxy 和类型；持久会话放到独立的 `pi-durable`。不能再照历史文档把已删除的 lane Harness 当作当前可接入接口。对思隅的启发是保持低层执行与持久化宿主的边界，并允许淘汰实验路线；这与现有 core/host/repositories 分工相符，没有证据支持再次更换全部内核。`pi-durable` 的包版本和新增实验客户端也不等同于思隅的恢复、授权及产品验收。

证据：[当前 agent 导出面](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/agent/src/index.ts)、[独立 durable 包及存储出口](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/durable/package.json)。

`89e5c2c07` 修复阻塞式压缩失败后仍发出超大请求、只得到空回答的问题：等待的压缩失败就让本次生成明确失败，并将最新失败保留到成功生成摘要。对思隅应落实为摘要错误有独立可见状态、可恢复操作和有界重试；现有规则裁剪没有真实摘要，不能把这项当作已经实现。上游“没有可压缩内容”或拒绝压缩仍可能继续请求，也需要按思隅最终输入窗口合同单独判断。

证据：[阻塞失败处理](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/durable/src/harness/generation.ts#L129)、[失败与恢复状态测试](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/durable/test/harness-compaction.test.ts#L1064)。

`8c911797c` 则把 MCP 的“连接中”也纳入关闭：中止初始化、取消重试等待、等待连接尝试结算后再返回。思隅 [MCP service](../../packages/host-runtime/src/modules/ecosystem/mcp/service.ts)的同步包含异步 initialize/listTools，而断开会禁用并注销工具；应验证两者竞争时迟到同步不会重新挂回工具。借鉴这一故障夹具即可，不把 pi 的 transport 管理直接替换进现有服务。

证据：[连接中的取消与关闭](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/coding-agent/src/extensions/mcp/runtime.ts#L359)、[初始化及重试中关闭测试](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/coding-agent/test/mcp-extension.test.ts#L628)。

#### 13.4.3 AstrBot：生成器清理和摘要降级的失败路径

`33ef43be3` 把异步工具生成器的推进和关闭放在同一个 owner task，按消费者需求推进，并在取消时等待清理完成；测试覆盖重复取消、清理抛错、取消后又 yield 和后台工具关闭。这比“加一个取消信号”更接近真实资源语义。思隅[abortableStream](../../packages/core/src/abortable.ts)已经能结束本地等待并丢弃迟到结果，但 `iterator.return()` 是异步尽力清理；应由持有资源的宿主明确跟踪清理完成、容量占用和截止后的升级处理。不能为等待不合作的迭代器而重新引入无限停机。

证据：[owner task 与清理](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/astrbot/core/utils/async_generator.py#L9)、[取消与清理反例](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/tests/unit/test_async_generator.py#L59)、[真实工具处理器回归](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/tests/unit/test_tool_generator_lifecycle.py#L129)。Python task/context 的机制不直接移植到 TypeScript，借鉴的是所有权和结束时序。

`a8bb0803e` 修复摘要 Provider 配额耗尽时长时间退避：摘要只请求一次，失败后逐轮裁剪并重新计数，保留工具配对。思隅当前规则裁剪已保留配对，下一步应在真实摘要接入时补独立预算、超时和失败状态。上游保留最新一轮，即使它仍超窗口也照发并警告；这不是最终输入窗口的硬保证，不能照搬为思隅预算合同。

证据：[单次摘要请求](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/astrbot/core/agent/context/compressor.py#L280)、[逐轮降级及仍超限分支](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/astrbot/core/agent/context/manager.py#L88)、[摘要失败与最新轮过大测试](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/tests/agent/test_context_manager.py#L651)。

#### 13.4.4 BaiShou-Next：先让缓存收益可测量

`cc9c8278` 将具体时刻移出稳定 system 前缀，`5c9c0886` 又移除日记格式规则中的实时日期渲染，保留模板占位符。这能减少无关变化破坏提示缓存，但不能从源码推断实际节约比例。思隅可利用已有 ContextManifest 比较相邻请求的稳定部分和易变部分，先确认学习状态、记忆和工具变化中哪些确实需要刷新，再做同模型、同材料的配对实验。

同一提交修复缓存写入字段和多步骤计费：逐 Step 累计，结束时使用 SDK 的整轮 `totalUsage`，避免仅统计最后一步。思隅的真实差距是 §13.3 所述 usage 落库链路未接通。建议先保存每次 Provider 调用的最后权威用量，再按回合聚合；区分缺失与零、单次累计与跨请求求和。BaiShou 的 SDK finish 语义不能直接套在思隅的流式 chunk 上。

证据：[稳定的日记规则](https://github.com/foxletters-hq/BaiShou-Next/blob/91c8d9fcf5bf6524e67f96b1c5146eb107b736ca/packages/shared/src/utils/diary-template.util.ts#L101)、[逐步与整轮用量处理](https://github.com/foxletters-hq/BaiShou-Next/blob/91c8d9fcf5bf6524e67f96b1c5146eb107b736ca/packages/ai/src/agent/stream-accumulator.ts#L171)、[多步及缓存分账回归](https://github.com/foxletters-hq/BaiShou-Next/blob/91c8d9fcf5bf6524e67f96b1c5146eb107b736ca/packages/ai/src/__tests__/token-usage.util.test.ts#L109)。

#### 13.4.5 OpenMAIC：区分响应失败、提交失败与资源释放

`9d2eface` 修复导入已持久化但响应丢失时误删数据：聚合文档写入是提交点，失败后尝试读回，不能仅因 Promise 拒绝就按 ID 删除；消费方成功回调也放到回滚范围之外。思隅[附件入口](../../packages/host-runtime/src/modules/knowledge/content/routes.ts)已有幂等键与读回能力，值得补“提交成功后连接断开、同 key 重试、读回也失败”的故障夹具，保证不重复创建、不删除已提交内容，不确定状态明确可见。

证据：[提交与失败处理](https://github.com/THU-MAIC/OpenMAIC/blob/ecb940c136cc5b4ea56dc81b2505e64eff1dea29/lib/import/use-import-classroom.ts#L539)、[三种读回结果测试](https://github.com/THU-MAIC/OpenMAIC/blob/ecb940c136cc5b4ea56dc81b2505e64eff1dea29/tests/import/server-backed-import-flow.test.ts#L158)。

`bceb7d12`、`02194d1b` 将预览和视频导出的执行容量隔离，幂等释放配合断连、失败和超时处理。可用于思隅昂贵的文档解析/渲染：取消响应后，必须等底层清理完成才能宣称执行槽空闲。当前没有必要为了借鉴容量控制引入它的 server-first 存储或多 owner 架构；上游 rc 版本也不提供思隅平台实测保证。

证据：[预览准入与释放](https://github.com/THU-MAIC/OpenMAIC/blob/ecb940c136cc5b4ea56dc81b2505e64eff1dea29/render-service/src/main.ts#L428)、[隔离与故障测试](https://github.com/THU-MAIC/OpenMAIC/blob/ecb940c136cc5b4ea56dc81b2505e64eff1dea29/render-service/test/preview-route.test.ts#L652)。

#### 13.4.6 Petra：学习语音顺序的验收场景，保留对实现的质疑

`aac255b` 把并发预取和 FIFO 播放分开：后一句先合成完成，也要等待队首；静音通过音量处理，使结束回调和气泡收尾继续运行。对伴学解释很重要，否则“因此……”可能先于推导被读出。思隅已有[合成入口](../../packages/host-runtime/src/modules/platform/voice/service.ts)和[语音试听](../../plugins/surfaces/panels-ui/src/persona/VoiceAbilityCard.vue)，应基于这些入口测试分段顺序、打断、静音和迟到结果。

但该实现仍有缺口：`preload()` 的失败分支只标记 ready，没有唤醒播放队列；本次以原源码和隔离的合成替身复现了唯一队首失败后不推进、idle 回调不触发。创建的 blob URL 也未见对应释放，`stop()` 未取消在途合成。现有“中间段失败”测试不能覆盖全部时序。适合借鉴测试设计并补反例，不宜直接复制播放器。

证据：[入队、预取失败与 FIFO](https://github.com/Wumiu/Petra/blob/d34e6add082ff388ff57b0e4a0da931770067bd0/src/tts/TTSPlayer.ts#L109)、[乱序合成测试](https://github.com/Wumiu/Petra/blob/d34e6add082ff388ff57b0e4a0da931770067bd0/tests/tts-order.test.js#L114)、[静音测试](https://github.com/Wumiu/Petra/blob/d34e6add082ff388ff57b0e4a0da931770067bd0/tests/tts-mute.test.js)。新增麻将、歌词和天气等功能没有直接证明对思隅伴学目标的收益，不据此扩大范围。

#### 13.4.7 archify：让源码引用真的绑定固定对象

`0857afc8` 禁用 Git replacement refs，`abd6b367` 阻止 partial clone 读取对象时隐式联网。普通与批量读取都使用原始 Git 对象，校验完整 SHA、来源仓库和对象存在性；对象缺失时明确失败，保留旧成品。测试还模拟旧 Git 忽略 `GIT_NO_LAZY_FETCH` 的情况，验证禁用传输协议的兜底确实生效。

这直接适用于思隅的参考源探针：[dsh-reference](../../packages/host-agent/src/dsh-reference.ts)目前核对父仓 gitlink，但版本和许可证声明取自工作树 `package.json`，没有把实际子模块 HEAD、工作树内容及 LICENSE 字节都绑定到该 SHA。值得独立补探针和反例：HEAD 漂移、脏文件、replace refs、缺失对象均准确报告，只读检查不隐式下载。本次八仓工作树和 HEAD 已另做 Git 核验，但没有因此更改探针行为。

证据：[本地对象读取与容量上限](https://github.com/tt-a1i/archify/blob/c21c31ffb879668900c5487ea24993bf45d89b15/archify/renderers/shared/repository-evidence.mjs#L23)、[替换对象反例](https://github.com/tt-a1i/archify/blob/c21c31ffb879668900c5487ea24993bf45d89b15/test/repository-evidence-replacement.test.mjs#L15)、[缺失对象与禁止联网测试](https://github.com/tt-a1i/archify/blob/c21c31ffb879668900c5487ea24993bf45d89b15/test/repository-evidence-partial-clone.test.mjs#L11)。

`e2c44ce5` 的另一点价值是按输入顺序一次返回多项可修复诊断，并限制读取字节、只验证需要的行，失败不替换旧 HTML。思隅可以将此用于知识导入和来源报告。它保证的是来源与结构检查，不能证明架构图的语义正确，也没有必要为此引入整套绘图引擎。

证据：[诊断次序、旧成品保留及读取上限测试](https://github.com/tt-a1i/archify/blob/c21c31ffb879668900c5487ea24993bf45d89b15/test/repository-evidence.test.mjs#L37)。

#### 13.4.8 dsh-synapse：宿主升级要验证引用生命周期

`b6554a5` 适配 DSH 0.1.7-rc.2 的 retain/ready/release：发送路径等待会话就绪，并在 finally 释放；观察会话按 generation 更换绑定，停止或销毁时清理引用。思隅[工具运行时](../../packages/core/src/host-tool-runtime.ts)已有 owner/generation 保护，新增价值是对真正采用的宿主协议做关闭、替换、超时和迟到事件夹具。Synapse 声明适配的宿主版本与本次 DSH `0.2.1-alpha.2` 不同；八仓各自更新到最新不等于它们已作为一套系统兼容。

证据：[会话持有与释放](https://github.com/liangmianya/dsh-synapse/blob/847b712b14579ca5e5c5fcf414f4559589c44d93/client.js#L37)、[generation 与销毁测试](https://github.com/liangmianya/dsh-synapse/blob/847b712b14579ca5e5c5fcf414f4559589c44d93/test/client-bridge.test.js#L415)。

`6988021`、`bfd0535` 增加按视口挂载卡片与动画帧合并更新。思隅[标准会话视图](../../packages/ui/src/components/workbench/StandardConversation.vue)仍是线性列表，先测长会话挂载数量、内存和滚动延迟，再决定是否应用虚拟化。上游仍扫描全体卡片，连线并未等量虚拟化，部分测试是源码断言，不能据此宣称大图帧率达标，也不能推导思隅必须新增无限画布。

证据：[按相机与缩放计算视口](https://github.com/liangmianya/dsh-synapse/blob/847b712b14579ca5e5c5fcf414f4559589c44d93/app.js#L989)、[画布测试](https://github.com/liangmianya/dsh-synapse/blob/847b712b14579ca5e5c5fcf414f4559589c44d93/test/canvas-runtime.test.js)。

### 13.5 建议切片与最小验收

优先选择能够对已有路径给出明确前后对照的切片。以下是本次研究建议，不是批准实施的任务单。

| 建议顺序 | 切片 | 最小验收 |
|---|---|---|
| 1 | 接通每次模型调用的权威 usage 与缓存分账 | 多 Step、重试、缺失 usage、最后一次 usage 覆盖、失败流都可追溯；缺失值不冒充零成本；稳定前缀的收益用同模型配对测量 |
| 2 | 将取消结束与资源清理完成分开验证 | 连接建立中取消、工具生成器清理变慢、释放抛错、旧任务迟到完成后，无新副作用、无泄漏、无虚假空闲容量 |
| 3 | 保真摘要与失败降级 | 长伴学夹具保留目标/错因/承诺/来源；摘要失败有明确状态且重试有界；保留 system 和工具组、不声称已总结未知内容 |
| 4 | 语音分段顺序与长会话展示 | 第二段先合成完成仍按原文播放；静音与取消语义分清；长会话离屏内容不持续渲染，选中项和失败回合仍可定位 |

思隅已有 SQLite/Port、执行管线、取消信号、请求快照和插件隔离接口。这些基础继续保留。对照上游时，采用故障场景、状态划分和测量方法最容易产生收益；整体替换会话存储、引入另一套宿主或照搬上游产品面，需要单独证明必要性。

### 13.6 审查验证与采用限制

本次同步 DSH 固定 SHA、准入测试及 runner manifest。当前 [DSH runner](../../packages/host-agent/test/fixtures/dsh-turn-runner.mjs) 的 `modelTurn` 直接调用 OpenAI 兼容 `/chat/completions`；`DSH_LIB_MODE` 仅检查库导出，未组装 Cordis 或执行 DSH 内核。因此主仓准入与协议测试通过，只能证明思隅的固定版本登记和适配协议，没有证明新 DSH 运行时完整兼容。此次库符号加载测试使用工作区既有构建产物，不能作为新 SHA 已构建的证据。

2026-10-14 原审查记录的验证（不是统一文档之后重新执行的结果）：

- 主仓 `./aervox ci all` 完整退出码为 0，包含代码、构建、类型、测试、原生专项与文档门禁；其中 Host Agent 为 76 passed、1 skipped，真实模型条件测试未运行。
- Synapse `node --test test/*.test.js`：89/89 通过，退出码 0；这些测试包含源码断言，不能等同于浏览器性能验证。
- archify 的 `repository-evidence`、`repository-evidence-replacement`、`repository-evidence-partial-clone` 三个 Node 测试文件：43/43 通过，退出码 0。
- Petra 使用 Node 24 读取原始 TypeScript、仅替换 Tauri 合成入口和浏览器对象的隔离探针，复现队首失败后队列不推进；这不是 Tauri 实机或完整上游测试。

其余上游测试链接表示已阅读的行为证据。没有安装上游依赖或构建八仓完整产物，也未验证真实模型、操作系统权限或发布包。参考更新不构成生产发布验收。

源码与资产分别核验许可：六仓顶层为 MIT，AstrBot/BaiShou 为 AGPLv3；BaiShou 美术资产和 Petra 新增第三方资源有各自条款。本文未复制上游实现或素材。实际采用时仍按文件来源处理许可，不能将顶层软件许可证推及所有资产。

回退时一起恢复父仓 gitlink、DSH 常量、runner manifest 和当前清单；本次没有修改业务数据库。

## 14. 设计来源与记忆研究

<a id="6-落地顺序建议"></a>
<a id="61-落地登记唯一真源"></a>
<a id="62-待接线缺口现状如实记录"></a>

### 14.1 历史来源编号与判定理由

T、AST、PET、Skill、DSH、PI、GPH 编号用于追溯设计来源，不是新的实施队列。以下 A/B/C 为早期评估的契合度判定，不表示今天的排期或交付；实现、验证与限制见[追踪基线](REQUIREMENTS_TRACEABILITY.md#42-证据与适用限制)。

| 编号 | 设计 | 历史判定 | 落点 | 关联需求 |
|---|---|---|---|---|
| T-01 | SQLite 写路径 busy 重试（指数退避） | A | `packages/repositories` 写路径 | WAL 多进程并发（DATABASE.md） |
| T-02 | FTS + 向量 RRF 混合检索 + JS 余弦降级 | A | `packages/repositories/src/search` | 记忆召回窗口 |
| T-03 | 上下文压缩标记（snapshotId 写回会话） | A | 临时→短期整理链路 | SRS 记忆验收标准 |
| T-04 | 工具注册表 + 主动记忆工具 | A | AI 运行时工具系统 | CAP-020、记忆晋升候选 |
| T-05 | Embedding 独立存储 + 可中止的迁移控制 | A | `memory_embeddings` 独立表 | SQLite Vector Port（当前边界见 ADR-016） |
| T-06 | 数据库迁移服务（journal + 旧库补齐） | B | 存储层演进 | DATABASE.md 迁移三阶段 |
| T-07 | 桌面 preload 按域划分 IPC API | B | `apps/desktop` | 桌面端功能扩展 |
| T-08 | 桌宠角色设定文档化 | B | 文档组织 | 桌宠 IP、CAP-019 |
| T-09 | Git 作为数据版本/同步层 | B | 本地优先与导出 | CR-030 本地数据边界 |
| T-10 | Token 用量分账（缓存/非缓存） | B | `ModelRun` 用量链路 | AI 质量与安全规范 |
| T-11 | 多工作区 vault 双库模型 | C | — | 与 CR-030 本地单用户边界冲突 |
| T-12 | Expo 移动端与 WebView 日记编辑器 | C | — | 与 ADR-015（Capacitor）冲突 |
| T-13 | 云同步/局域网快传/定价/更新器 | C | — | 商业化能力不在当前路线 |
| AST-01 | 会话级写锁（引用计数回收、按事件循环隔离） | A | 会话写路径进程内锁 | 与 T-01 互补 |
| AST-02 | 向量库 Port 批量/重试/进度回调接口形态 | A | T-05 落地时对齐 Port 语义 | SQLite Vector Port（当前边界见 ADR-016） |
| AST-03 | 人设字段化 + 逐级解析 + 默认兜底 | B | 随 CAP-019 立项 | 桌宠 IP、CAP-019、T-08 |
| AST-04 | 插件元数据模型 + 工具配置条件门控 | B | CAP-020 插件权限模型 | T-04 |
| AST-05 | Pipeline Stage 显式顺序 + 迁移完成标记 | B | Worker/中间件管线演进 | T-06 |
| AST-06 | IM 平台适配/群聊白名单/内容安全链路 | 历史 C；ADR-029 批准受限文字入口 | API Bot 宿主与第一方传输插件 | [Bot 范围](PRD.md#bot-platform-scope)；群不读取个人数据，不开放群治理 |
| AST-07 | Dashboard 面板形态与 zip 更新器 | C | — | 与 T-13 同理由 |
| AST-08 | 声明式插件配置（`_conf_schema.json` 模式） | B | CAP-020 插件配置解析与可视化 | 自研 Aervox Config Schema v1 |
| AST-09 | 插件页面 + 受限 iframe Bridge | B | CAP-020 插件 Page | 自研 Aervox Page Bridge，仅本地 Bundle 资源 |
| PET-01 | 桌宠表现命令通道（speak/emote/gesture/move/react） | A | 消息/SSE 契约预留表现指令 | 桌宠 IP、表现层与大脑解耦 |
| PET-02 | 结构化记忆条目字段（source 区分用户自述/AI 推断） | A | 记忆 schema 字段对照 | SRS 记忆验收标准、T-03/T-04 |
| PET-03 | 自主行为引擎参数化（活动频率三档/躲避/待机） | B | 桌面端角色行为 | T-07、桌宠 IP |
| PET-04 | 表现驱动数据对象 + 视图接口分离 | B | 桌宠表现层抽象 | 桌宠 IP、CAP-019 |
| PET-05 | AI 工具只读白名单与提示词使用原则 | B | 工具链安全规范 | AI 质量与安全规范 |
| Skill | Skill 能力（Anthropic Skills 渐进式披露 + Neo 生命周期） | B；后有实现登记 | `packages/host-runtime/src/modules/ecosystem/skills/`、`packages/repositories` 技能表 | CAP-020 |

<a id="33-t-03-上下文压缩标记"></a>

T-03 的溯源约束是先持久化完整响应，再投递带 `memoryId/snapshotId` 的整理意图；标记关联源 Turn/MessageVersion 区间，不以“摘要生成成功”替代持久提交。规则裁剪、模型摘要和记忆晋升是三种行为，必须分别标注来源与失败状态。

T-01/AST-01 的借鉴点是有界 busy 退避与可回收的进程内会话锁：前者不能盲重放带外部副作用的事务，后者不能解决跨进程 SQLite 写竞争。T-02/05、AST-02 要求业务记录仍是真源，embedding 独立版本化，索引失败可重建，批次、重试、进度和取消有明确语义。

T-04/AST-04、PET-05 区分工具发现、可用性与授权；工具清单不是执行授权，未知或撤回能力不得继续派发。PET-02 的用户自述与模型推断不能仅凭字段名决定置信度；模型抽取仍是候选，需要证据和既有确认策略。

T-07、PET-01/03/04 学习平台桥、表现命令与可释放视图的分层；不会为采用这些模式更换 Vue/Electron、复制 Tauri/Windows 原生层，或从旧“不引入 Live2D”的建议倒推删除现有渲染能力。T-08/AST-03 的人格资产由批准修订与解析优先级管理，不与模板逐字段双写。

AST-08/09 的 Config Schema、Page 和 Host Bridge 只按[插件契约](plugin-config-and-pages.md)开放。Skill 学习渐进式披露和候选晋升，但指令包不自动获得可执行权限；注册、内容目录与 Persona 的所有权按现行实现核对，不恢复旧租户级接口。

不采用多工作区 vault/共享租户、React/Expo 或 Tauri 全栈迁移、IM 群聊治理、另一套 JSONL Session 真源或外置图数据库。ADR-029 仅批准本人微信及白名单 QQ 群文字接入；历史 AST-06 判定不再排除这一受限入口，也不授权群管理或共享个人数据。Git 快照只能是受控导出/历史载体，不能绕过一致性备份、删除和恢复规则；品牌、美术与第三方资产许可须单独检查。

<a id="upstream-20260929"></a>

### 14.2 DSH-01 与 PI-01 的历史控制流证据

| 来源 | 历史固定提交 | 设计输入与边界 |
|---|---|---|
| DSH-01 | `639ed015397290b3745d163aafe02ffee4aa3f84` | Turn/Step、typed event、steer/follow-up、可逆 effect/disposer；不迁移 Cordis、Session 存储与权限体系 |
| PI-01 | `5257d0d5f3ab7d42550804f32c67a77b49f485d4` | outer/inner loop、工具参数与结果配对、串行提交、operation/invocation 失效、上下文投影；不把完整宿主权限带入 API/Worker/Renderer |

历史 DSH 工具批次 any/concludesTurn 与 pi 非空批次 every/terminate 不能静默互换。思隅终止策略、租约、fencing、授权与事件必须由[执行契约](agent-harness-loop.md)控制；Adapter 收紧或拒绝不兼容批次。

2026-09-29 对 lane Harness 的 prompt/resume/abort、未完成 watchSession 和初始 durable 路线的描述属于旧提交证据。2026-10-14 的 pi 已移除低层实验 Harness，会话持久化转至 `pi-durable`；当前复核取 §13.4.2，不能把旧接口当作新 SHA 的可接入能力。DSH runner 仍须按 §13.6 的实际接线限制评价。

保留以下旧提交的设计与反例，作为复核而非当前外部 API 的依据：

| 历史设计 | 对思隅的启发与不变量 | 固定源码证据 |
|---|---|---|
| DSH 工具失败分类与格式迁移 | 区分未开始与结果未知，保留已提交成功结果并补齐调用/结果配对；未知文件或设备副作用不得自动重放，迁移保留旧文件 | [失败阶段](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/tests/tool-calls.spec.ts#L635)、[保留原文件](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session/session-persistence-jsonl/tests/v3-restart-migration.spec.ts#L55) |
| DSH 限时提问 | 超时返回 pending，问题仍可回答，迟到答案按 callId 接后续输入；超时不等于用户回答或操作批准，新续跑语义先评审 | [限时等待](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/interaction/user-questions/src/timed-wait.ts#L4)、[旧/新路径](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts#L102) |
| DSH Host 定时任务 | 显式时区、DST、补发和投递历史有价值；投递到 Inbox 不是任务完成，旧实现非原子且可重复，思隅保留 Outbox、业务次序键、幂等和通知预算 | [Schedule 限制](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/schedule/schedule/README.md#L59)、[投递/执行区别](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/schedule/schedule/tests/delivery.spec.ts#L10) |
| DSH PTC 与创建屏障 | 每次受控执行有取消、截止、控制帧与输出上限，初始化监听器全部完成后才接单；平台、网络和内存限制逐项声明 | [PTC 限制](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/ptc-runtime/ptc-runtime-node/README.md#L133)、[初始化屏障](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/tests/serial-listener-review.spec.ts#L82) |
| pi effect gate 与回合钩子 | 关闭新副作用准入、持久取消、结果/终态提交、通知有明确顺序；finishTurn 的失败通知不得继续调度，内存 gate 不替代 lease/fencing | [effect gate](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/agent/src/harness/execution/effect-gate.ts#L31)、[硬退出](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/agent/test/agent-loop.test.ts#L1067) |
| pi context_edit 与工具组压缩 | 模型可见上下文是可重建投影，原聊天/计费/UI 历史保留；调用/结果成组、重试有界，投影隐藏不等于用户删除 | [context edit](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/test/session-context-edit.test.ts#L37)、[大工具结果](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/test/compaction.test.ts#L378)、[单次重试](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts#L135) |
| pi 按需工具与模型路由 | 嵌套调用仍执行授权 hooks；实际物理模型决定窗口，逐调用保留 local-only、取消、账本与总预算，不沿用无限脚本截止时间 | [嵌套工具与脱敏](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/test/suite/agent-session-codemode.test.ts#L178)、[物理模型窗口](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/test/suite/virtual-models.test.ts#L228) |
| pi 注册事务与持久任务 | factory 失败丢弃暂存贡献，旧 invocation 不可提交；外部调用仍可能重复，真实幂等由业务键保证 | [注册提交/丢弃](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/src/core/extensions/loader.ts#L248)、[SQLite 重开与幂等](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/durable/test/harness-tasks-recovery.test.ts#L110) |
| pi 慢观察者与已提交 partial | 可重建视图可以从增量折叠成快照，审批/账本/审计不能丢弃后假装连续；收尾等待已启动写入，恢复仍核对撤权与删除水位 | [慢观察者](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/durable/test/session-watches.test.ts#L142)、[partial 恢复](https://github.com/earendil-works/pi/blob/5257d0d5f3ab7d42550804f32c67a77b49f485d4/packages/durable/test/harness-generation-recovery.test.ts#L123) |

### 14.3 Letta、Graphiti 与 Generative Agents 的设计输入

以下保留 2026-09-25 研究提出的假设，不维护这些外部产品的最新规格，也不批准直接引入运行时。官方项目与原始论文是继续复核的入口；源码复用另行固定提交和核对许可。

| 来源 | 学习目标 | 思隅中的窄实验 | 采用边界与反例 |
|---|---|---|---|
| [Letta Code](https://github.com/letta-ai/letta-code)、[memory blocks](https://docs.letta.com/tutorials/attaching-detaching-blocks/) | 常驻身份/规则与按需历史分层，变更在重新编译上下文时生效 | ContextManifest 区分 identity、user_confirmed、active_goal、recalled 槽；记录 owner、有效修订、选择理由和 token 预算 | 不允许任意自改提示词覆盖批准人格；同一会话跨 20 Turn 验证身份稳定、纠正下一轮生效与修订回滚 |
| [Graphiti](https://github.com/getzep/graphiti) | 事实有效时间与进入系统时间分离，episode 证据及冲突后旧事实失效 | GPH-01 双时间规则、GPH-02 SQLite 时态投影；确认记忆投影为 subject/predicate/object，保留有效窗口与失效来源 | 不部署 Python/图数据库，不让模型抽取绕过确认；测试迁居、偏好变化、矛盾更新、指定时间查询和来源删除后屏蔽 |
| [Generative Agents 论文](https://arxiv.org/abs/2304.03442)、[研究实现](https://github.com/joonspk-research/generative_agents) | 观察、召回、反思与计划的可验证闭环 | 固定事件脚本，比较无记忆、仅召回、召回加反思、再加计划四组 | 反思保留源记忆、模型/Prompt 版本、置信度与确认状态；测事实正确率、计划完成率、无依据推断和打扰率，不用“像真人”代替安全与正确性 |

时态投影是可删除重建的派生数据，不能成为第二套业务事实。身份槽只从批准人格和确认记忆编译，普通召回仍是不可信事实上下文；删除/修订必须贯穿全部槽与投影。实验完成不自动表示生产写入、召回或主动行为已接线。

<a id="AVX-EXPL-012"></a>
<a id="AVX-EXPL-010"></a>
<a id="architecture-evolution"></a>

## 15. 架构演进设计与历史问题证据

本章保留当前边界、采用条件与未关闭验收。ARC/FND 编号来自旧基线，详细反例、行号、实验及 2026-10-08 审计已迁入[历史架构快照](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/docs/reference/ARCHITECTURE.md#architecture-evolution)。原始文件与 SHA-256 同包保存，旧失败和局部成功不改写为今日结论。现行合同由 §1～§12、专项契约及 ADR 定义；当前排序只维护[计划](../../plan.md)。

### 15.1 先统一边界与生命周期

推荐目标是继续保持单体业务部署，用现有 Port 逐步收敛五个责任边界：

1. **业务命令边界**：模块拥有数据写入命令、短事务和版本 CAS；跨域使用公开 Port，外部 I/O 不进入数据库事务。
2. **执行边界**：接单生成持久执行意图；调度统一容量、claim、取消与预算；子任务和 Driver 继承根策略。
3. **投影与恢复边界**：Outbox 有明确消费者和完成证据；检索、UI 通知和派生资料各有水位；删除和撤权先禁止使用，再完成清理与恢复追平。
4. **资源边界**：模型、ASR/TTS、下载和大文件校验有队列、时限、生命周期与就绪等级；需要硬隔离的计算再移入受限进程。
5. **部署与验证边界**：主管负责进程、目录、凭据和版本；CI 从冷环境重建所有测试依赖；指标覆盖实际生产入口。

这些边界可分批建立。禁止把所有问题浓缩成一个通用 Service Manager、全局事务包装器或万能事件总线；它们的失败语义不同。

### 15.2 候选方案与采用条件

| 方案 | 适用条件 | 收益 | 成本与当前判断 |
|---|---|---|---|
| 单体内受控执行调度 | 先解决接单恢复、取消和容量 | 改动小，可复用现有仓储与 Loop | 与 API 共享事件循环；推荐作为第一步 |
| 同机独立 Agent 执行进程 | 执行输入已可恢复；推理/工具干扰 API 或需要独立重启 | 故障与资源隔离 | 增加跨进程通知、生命周期、取消和接管；完成 ARC-01/04 后再评估 |
| 局部计算 Worker/子进程 | 原生推理或大文件处理阻塞/不可取消 | 隔离最重资源，可硬终止 | 启动、IPC、数据复制和平台打包成本；优先针对具体 Provider |
| 每进程短事务调度 | 同一进程大量竞争写入且测量超预算 | 可控排队、批次与公平性 | 不解决跨进程竞争，不能替代正确 CAS；先测量 |
| 全局单写者进程 | 正确事务后仍持续出现跨进程忙错误/尾延迟 | 统一写入顺序与公平性 | 增加 IPC 单点、恢复、幂等和权限协议；当前证据不足以直接采用 |
| 本地 FTS/向量扩展 | 中文质量或向量规模超过已批准预算 | 提高质量或减少扫描成本 | 索引迁移、平台二进制和重建成本；保留现有 Port 后按基准选择 |
| 微服务/外置数据库/外置队列 | 真正出现独立部署、多团队或容量需求 | 可独立扩展 | 当前本地单用户产品无相应证据，且不修复本轮正确性缺口 |

主库与 Vault 应继续按现有数据边界分工。账本的可靠保留是恢复协议问题，不应被“减少文件数”或“全部改成同一事务”的优化目标破坏。

### 15.3 ARC-01～14：反例、取舍与验收

各项保留旧编号与锚点，详细触发条件见[原始评估](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/docs/reference/ARCHITECTURE.md#arc-01)。已交付与待验收分开陈述，不以历史故障降低现行合同。

<a id="arc-01"></a>

#### 15.3.1 ARC-01：从接单成功到可恢复执行（历史评估）

原子受理、Outbox 消费归属与无租约 Attempt 收敛已由 [ITER-002](../../plan.md#iter-002) / PR #228、#258 交付。已受理任务仍须可追踪且重复消费不产生副作用；容量准入与完整互动恢复分别留 [ITER-013](../../plan.md#iter-013)/010，不能由接单切片推定自动续跑完成。

<a id="arc-02"></a>

#### 15.3.2 ARC-02：执行控制必须沿父子任务与 Driver 传递（历史评估）

父子任务、Workflow、Driver 的取消/截止/local-only 和授权修订由 ControlContext 传递并在副作用前复验，已交付切片见 [ITER-007](../../plan.md#iter-007)/034/044/045。未知外部结果不自动重放，取消不回滚既有副作用；累计预算、Driver 能力等价与真实外部执行仍按 [ITER-013](../../plan.md#iter-013) 及 [ITER-033](../../plan.md#iter-033) 验收。

<a id="arc-03"></a>

#### 15.3.3 ARC-03：动态工具的可执行性与可发现性（历史评估）

动态工具的模型可见 Schema 快照、执行时授权重验与参数验证已由 [ITER-007](../../plan.md#iter-007)/068 交付。注册缓存不成为授权真源；新增工具继续捕获真实模型请求、覆盖启停与旧快照拒绝，并与最终上下文预算一起核验。

<a id="arc-04"></a>

#### 15.3.4 ARC-04：自动恢复与互动等待的连续性（历史评估）

Resume 库的请求/账本覆盖和高水位已有修复；运行中审批续跑不等于跨进程恢复。默认启动未因此启用完整自动 Resume；缺账本、多工具、审批/答案重启、重复接管、一次性授权/有效期与未知结果人工处置继续见 [ITER-010](../../plan.md#iter-010) 和 [Loop 合同](agent-harness-loop.md)。

<a id="arc-05"></a>

#### 15.3.5 ARC-05：流式输出需要贯通整个链路（历史评估）

安全正文已按时间/字节窗口提交，SSE 已有 SQLite 分页、背压及持久终态核对，见 [ITER-057](../../plan.md#iter-057)/013。持久提交先于可见输出；慢源、慢客户端、跨进程终态、断连续传分别验证，DSH/其它 Driver 的整次响应能力不能冒充真实增量流。

<a id="arc-06"></a>

#### 15.3.6 ARC-06：删除完成证明和恢复后的撤权保留（历史评估）

Memory owner 的清理、独立验证、迟到写入拒绝与失败不解闸已交付；未知 owner/目标不能伪造 completed。完整来源传播、独立 deny 账本、恢复水位和旧备份撤权保留仍见 [ITER-003](../../plan.md#iter-003)/010 及 [隐私合同](DATA_PRIVACY.md)。删除成功须可重做验证，恢复包保留不能代替零召回证明。

<a id="arc-07"></a>

#### 15.3.7 ARC-07：消息版本变更需要一个业务工作单元（历史评估）

消息版本在写者短事务中完成 CAS、旧版推进与当前指针切换，失败回滚/同版本竞争回归见 [ITER-004](../../plan.md#iter-004) / PR #258、#259。新写点须继续保持唯一当前版本，编辑/删除竞争不得复活内容；历史不一致不能按最大行号静默修补。

<a id="arc-08"></a>

#### 15.3.8 ARC-08：检索资格与派生索引生命周期（历史评估）

召回资格和迟到索引写入已加闸，向量仍以当前模型 JSON 数据做本地评分；有界 top-K 不证明生产瓶颈消失。投影失败追平、来源/模型版本、可选回填、中文 Recall@K 和 A→B→A 切换留 [ITER-012](../../plan.md#iter-012) 及 [ITER-017](../../plan.md#iter-017)；Restricted 与过期数据的权威资格在返回上下文前复验。

<a id="arc-09"></a>

#### 15.3.9 ARC-09：启动建表、Schema 迁移和索引重建分工（历史评估）

启动 Schema 初始化不等于旧版本升级协议。FTS/shadow 排除、版本 journal/校验和、完整旧库升级及失败恢复留 [ITER-011](../../plan.md#iter-011)；任何业务换库遵循[停写、备份、显式范围、staging、校验、原子切换与回滚保留](../how-to/run-database-migration-drill.md)，不能恢复租户列或以简单 rename 代替恢复演练。

<a id="arc-10"></a>

#### 15.3.10 ARC-10：领域目录需要可执行的所有权边界（历史评估）

公开 Port、插件实例生命周期、平台注入与导入守卫已有切片，见 [ITER-014](../../plan.md#iter-014)/052 及 ADR-014/021。目录分域不自动证明所有写入所有权；新增跨模块私有导入须拒绝、公开 Port 可独立 Fake 测试，产品域深层依赖继续按 [ITER-026](../../plan.md#iter-026) 收敛，其它跨模块路径由 ADR-014 的公开边界约束，不机械改为异步调用。

<a id="arc-11"></a>

#### 15.3.11 ARC-11：模型制品接收需要受限且可验证（历史评估）

模型文件名/根路径/symlink、续传范围/响应及实体校验已由 [ITER-008](../../plan.md#iter-008) / PR #266 加固。可信来源摘要与仅计算摘要有区别；私有 staging 后提升、磁盘/总时限、重启一致性及下载成功/启动失败分别保持可见，不能因已认证就跳过内容验证。

<a id="arc-12"></a>

#### 15.3.12 ARC-12：进程代际、资源准入与真实就绪（历史评估）

模型进程 epoch、有界探针/日志/指标已由 [ITER-008](../../plan.md#iter-008) 交付。Provider 队列/等待/取消、真实推理就绪及全机资源竞争仍见 [ITER-013](../../plan.md#iter-013) 及 [ITER-033](../../plan.md#iter-033)；旧 child/初始化迟到不得覆盖新实例，原生阻塞是否需要隔离须用固定设备测量，不能由 HTTP 200 推定模型可用。

<a id="arc-13"></a>

#### 15.3.13 ARC-13：部署主管与客户端访问边界（历史评估）

open Host/Origin、Token 预检、桌面 IPC/导航与统一传输已加固，见 [ITER-069](../../plan.md#iter-069)；Page Token 仍留 [ITER-006](../../plan.md#iter-006)。完整桌面/服务主管需管理目录、凭据、版本、就绪与退出，沿 [ITER-015](../../plan.md#iter-015)；干净安装、升级、端口占用、磁盘满、异常退出及数据保留逐项验收，签名/公证和真实设备恢复单列。

<a id="arc-14"></a>

#### 15.3.14 ARC-14：CI 必须证明冷启动和真实输入（历史评估）

冻结安装、包外输入触发、插件导出恢复与原生构建依赖已由 [ITER-001](../../plan.md#iter-001)/067 及 PR #310 交付。冷检出和缓存命中均须恢复完整消费产物；真实分发端点可重现性仍属 [ITER-005](../../plan.md#iter-005)，正式安装/签名验收不由构建通过替代。

<a id="foundation-review"></a>

### 15.4 FND-01～10：基础边界与资源反例

旧基线实验与行号见[归档评估](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/docs/reference/ARCHITECTURE.md#foundation-review)，本节保留当前约束和未关闭门槛。

#### 15.4.1 FND-01：Outbox 消费归属与失败恢复（历史评估）

Outbox 业务消费者完成前不能被审计消费者提前确认，重复处理须幂等；已交付范围见 ARC-01/[ITER-002](../../plan.md#iter-002)。新增多订阅协议仍需明确消费归属、水位与失败重放。

#### 15.4.2 FND-02：插件升级与失败恢复（历史评估）

Config/Secret 同库 CAS、owned activation 与声明包 generation 原子激活已有交付。真实分发端点的每个预检/写入/注册/切换失败与崩溃恢复、旧凭据保留、幂等重试及可重现导出继续见 [ITER-005](../../plan.md#iter-005) / ADR-028；单个数据库事务不提供文件系统跨介质原子保证。

#### 15.4.3 FND-03：Page Bridge 的身份、权限与撤权（历史评估）

Page Bridge 已校验 Window/source、请求身份、配置修订与生命周期，Page 文件上传/清理拒绝预存 symlink。跨端认证资源通道仍留 [ITER-006](../../plan.md#iter-006)，长期 Token 不放 URL 或插件页；主动同 OS 祖先交换不是当前静态资源边界保证。

#### 15.4.4 FND-04：归档预检的资源配额（历史评估）

归档统一预算、ZIP/重复路径预检及大小写文件/目录冲突拒绝已加固，见 [ITER-060](../../plan.md#iter-060)/064。所有安装入口仍须在写入前检查路径、条目数、声明与实际展开尺寸/总量、压缩比和取消，失败不能丢失旧技能或留下部分注册。

#### 15.4.5 FND-05：宿主轮询故障与停机（历史评估）

Worker 已从首信号共享关闭总预算，重复信号不重置；超时/释放异常退出非零，数据库只在前序释放成功后显式关闭，见 [ITER-013](../../plan.md#iter-013) / PR #317。Agent 轮询、其它 Provider 与所有宿主写者的排空仍分别验收；同步阻塞无法由异步定时器打断，未知副作用不盲重放。

#### 15.4.6 FND-06：SSE 的有界缓冲与持久恢复（历史评估）

SSE Hub 仅唤醒，SQLite 有界分页、write/drain 背压及同一快照终态/高水位核对见 [ITER-013](../../plan.md#iter-013) / PR #316。单超大历史事件、元数据及 JSON 临时内存仍可超过页预算；全局并发与逐帧撤权未完成。断连只释放连接，客户端依持久 ID 重连去重，不取消已受理任务。

#### 15.4.7 FND-07：会话锁回收与 SQLite 写竞争（历史评估）

会话锁尾链按真实存入 Promise 回收，万 key/异常排队回归已交付。跨进程 SQLite 写竞争仍用 WAL、短事务和受控忙等待；BEGIN 不盲重试，事务不得包含外部副作用。真实 P50/P95/P99 竞争测量及调度选择留 [ITER-017](../../plan.md#iter-017)，不能据内存锁推定跨进程无竞争。

#### 15.4.8 FND-08：完整上下文预算与保真压缩（历史评估）

最终请求预算、完整工具组与“未生成摘要”的规则裁剪已具备；真实保真摘要、权威事实输入和任务完成率验收留 [ITER-032](../../plan.md#iter-032)。压缩投影不等于用户删除，原文/摘要/索引仍受删除及撤权水位约束。

#### 15.4.9 FND-09：让已有观测能支持决策（历史评估）

受认证 API 指标及宿主诊断已经提供有界可观测路径；应复用现有 Port，继续覆盖积压、跳过、忙等待、裁剪、审计失败及慢连接，见 [ITER-013](../../plan.md#iter-013)。指标可丢样不代表关键授权/副作用审计可吞错；诊断不输出用户正文或 Secret。

#### 15.4.10 FND-10：静态资产与构建缓存的产物归属（历史评估）

公共/Live2D 资源保持单一源码与消费端恢复检查；关闭缓存是正确性保护。仅在冷/热/单资源基线显示值得时调整产物所有权，并证明清空消费目录后缓存可恢复、源修改能失效，见 [ITER-017](../../plan.md#iter-017)；不为表面速度扩大 SQLite 测试并发。

<a id="audit-findings"></a>

### 15.5 2026-10-08 审计的交付范围

[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) 交付 Memory owner 清理/独立验证、原子接单、动态工具取消、消息/配置 CAS、取消终态恢复、锁回收与公共资产单源。八项触发条件、局部回归和原始严重性见[审计快照](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/docs/reference/ARCHITECTURE.md#audit-findings)。完整来源传播、独立恢复账本、自动 Resume 与签名分发仍按对应现行合同及 ITER 条目验收，局部修复不能关闭全部发布门槛。

<a id="AVX-EXPL-015"></a>
<a id="product-experience"></a>

## 16. 陪伴产品体验的设计候选

这里的 Pi AI 指 Inflection 的陪伴产品，和 §13 的 pi 代码库不同。G1～G7 是历史产品体验研究的候选，不是验证过的竞品现行规格或新的需求；语音、工作台、主动陪伴等已有实现须逐项复核，不能继续使用旧“语音缺位”“工作台全空白”的笼统判断。内核 ITER-032/033/039/040 不代表这七项产品候选已立项。

| 编号 | 用户问题与候选设计 | 数据/架构边界 | 采用前最小验收 |
|---|---|---|---|
| G1 自由陪伴 | 用户不想学习时也可交谈；候选 companion 状态不自动注入学习目标，不强行拉回练习 | 修改产品范围需 PRD/SRS 评审；生活素材进入日记或记忆需已有 purpose/scope 同意；危机响应、非依赖关系与反打扰保持 | 无学习目标仍可对话；用户可切回学习；不自动生成学习成绩或扩大画像采集 |
| G2 自然呈现 | 保留意图分类的分析价值，候选将标签转为内化数据或可选诊断视图 | 先核对 SRS 的用户可见标签要求，不以“纯前端”绕过行为契约；不预设新增 MessageVersion 字段 | 标签与必要来源/风险提示分别处理；隐藏标签不丢审计、练习反馈或无障碍信息 |
| G3 倾诉/建议/学习节奏 | 用户表达困扰时可选择倾听、一起想办法或调整学习节奏，随时切换 | 路径选择不算学习作答；情绪不直接推断人格/掌握度；陪伴素材用途单独授权 | 三条路径遵循用户意图，切换不重复副作用；危机安全响应不受路径开关影响 |
| G4 可控引导 | 候选严格、适度、直接回答三种强度，结合明确偏好、尝试与知识点信号 | 先评审既有首轮引导规则；不能把模型猜测当掌握度，不能用个性化绕开质量门禁 | 固定新手/熟练/明确求答案样本，比较闭环完成与知识留存；偏好缺失有可解释默认值 |
| G5 渐进上手 | 可先看界面，模型连接和偏好在实际需要时引导；配置延后但不跳过 | 首次真实 AI 回复前确认 Provider；不偷用远程模型或假装占位回复是真推理；昵称/提醒等可跳过且使用默认值 | 空配置、已有本地模型、拒绝授权、连接失败和退出重进都有明确路径；测首次回复与闭环漏斗，不承诺“3 秒完成” |
| G6 探索与空状态 | 候选固定动作/策展卡片、轻量阅读和授权后的兴趣话题，而非无限生成的信息流 | 当前主动 UI 的最近会话/固定动作不等于完整发现流；遵循来源许可、安全、删除和反打扰；不扩大后台观察 | 无目标时入口可用；来源、关闭与频率可见；推荐不能使用过期/撤权记忆或制造虚假生活经历 |
| G7 语音连续体验 | V0 顺序朗读，V1 按键转写进入文字 Turn，V2 再研究双工/VAD/自然打断 | 已有 ASR/TTS 不代表完整语音会话；逐 Provider 验证真实产物、授权、取消与资源隔离；本地限制不得静默远程降级 | 分段乱序、静音、队首失败、迟到结果、设备权限与中途取消；保留文字流、准确率/音质/延迟原始测量 |

语音 V0/V1/V2 是候选范围，不是排期。旧研究的 MOS 3.5、对话 800 ms、打断 200 ms 属于未验证目标；采纳前须固定设备、语料、测量起止点与成本，不能当作现行发布门槛。开放生活素材、自动推荐、人格信号或远程语音都需要先核对产品、隐私和安全合同。

主动智能的授权/画像/执行/通知四轴仍见[专项解释](../explanation/proactive-intelligence-mode.md)，它与自由陪伴 UI 状态不同；有对话入口不证明后台已获设备观察权。

## 17. 设计验证与性能判定

### 17.1 固定负载与不可退让的不变量

首先固定设备 CPU/RAM、操作系统、磁盘、工具版本、模型文件/量化、线程数、数据库规模和配置；Fake Provider 的结果仅用于衡量本地调度，不与真实模型速度混为一个指标。建议先用纯合成数据的小/中/大三个档位，例如记忆 1 千/1 万/10 万条，再根据用户实际规模调整。这些是实验设计值，不是容量承诺。

| 负载 | 核心测量 | 能回答的问题 |
|---|---|---|
| 短对话与长文本流，单路/多会话 | 接单到 claim、上游首段、安全段落库、首渲染、取消耗时、在途数 | 慢在模型、调度、持久化还是 SSE；ARC-01/05 是否改善体验 |
| API 写入 + Worker 到期任务 + 插件安装/模拟设备事件 | BEGIN/提交 P50/P95/P99、忙错误/重试、队列最老年龄、WAL 大小、事件循环延迟 | 是否真的需要写调度或计算隔离，后台工作是否饿死 |
| 冷加载/热 ASR + LLM + TTS + 下载校验 | 各进程 CPU/RSS、排队时间、拒绝数、音频延迟、取消后内存、模型切换耗时 | 设备规格、并发预算与资源优先级是否合理 |
| 中文/英文/代码检索和模型切换 | Recall@K、合格结果数、越权结果数、P95、峰值 RSS、重建耗时 | 是质量、资格过滤还是向量计算瓶颈 |
| 慢 SSE 与长历史重连 | 待发送字节、每批事件数、断连释放、恢复游标与跨进程可见延迟 | 缓冲是否有界，重连是否完整 |
| 持续运行与随机退出 | 内存趋势、句柄/子进程数、孤儿任务、未知副作用、删除积压和恢复水位 | 能否进入硬件常驻试点，而非只在演示中成功 |
| 冷/热构建、仅插件变化、产物删除 | 实际执行任务、缓存失效、制品完整性、总耗时 | CI 缓存是否可信，构建优化是否值得 |

### 17.2 观测与判定方法

优先扩展现有 [Metrics Registry](../../packages/observability/src/metrics-registry.ts)和 API `/v1/metrics`；不是重新建设监控平台。为实际 API 调度、Worker、模型进程分别记录指标，带上组件/任务类型等低基数维度，通过 Turn/Attempt/Job 关联脱敏日志。FND-09 中 Host 私有样本不可读的问题不等于 API 没有指标端点。

先记录预热与测量窗口、重复次数和异常样本，再由产品/设备预算确定门槛。性能比较至少报告 P50/P95/P99、失败率、峰值/稳态内存和任务质量；使用同一数据与配置，仅改变被评估因素。持续运行可先安排 24 小时合成负载，再做目标硬件 72 小时试点；这两项尚未执行。

任何优化都有不可退让的不变量：已接单任务可追踪；未确认副作用不盲重放；过期/撤权内容不回流；版本变更原子；文件不越界；资源有界。事务更少、队列更短或吞吐更高不能抵消这些约束。达到这些条件后，才比较增加进程、索引扩展或缓存重构的实际收益。

### 17.3 已有原生试点证据的适用限制

2026-10-12 CR-063 的[文件 SQLite 与运行时基准](../_meta/native-runtime-baseline.json)比较实际 LibSQL 仓储、稳定 top-K、连续数组 Worker、Rust 冷/热连接和 `sqlite-vec`。缓存、数据表示与预计算范数贡献主要收益；Rust 仍需计入启动、IPC、读入及 JSON 解码。缓存使用独立只读连接，LibSQL 池化调用的连接水位不能当全局修订；普通业务提交也会触发保守重建，因此热查询不等于真实对话延迟。生产默认不切换索引，两个缓存 Port 均有跨连接删除、仓储直写、模型和资格回归。

音频对照包含传输成本，保持 TypeScript 默认；原生预处理仅作为显式可选路径。插件 Worker 增加总处理时间，但缩短主事件循环阻塞，沿用成熟压缩实现与原有预检配额。三平台活动 Helper 和声明主管补齐进程与平台边界，权限缺口、签名和 OS 发布验收见 CR-063 与操作指南，不把编译或合同测试当作真实桌面权限验证。

2026-10-12 [CR-062](adr/ADR-024-native-runtime-boundaries.md#cr-062) 增补[机器可读原生搜索基准](../_meta/native-search-baseline.json)：同设备、固定种子、三档 256 维向量，比较 JSON 全排序、JSON 有界 top-K、连续数组与 Rust；每档校验候选 ID 和分数一致性。查询计时与进程启动/加载分账，内存为间隔采样，短命进程可能没有有效样本。JSON 解析成本明显高于排序差量，不能把预加载的 Rust 计算时间当作端到端召回提速。

代码搜索对照覆盖无匹配、末尾匹配和结果上限：原生搜索让 API 的定时器保持可调度，但进程启动使很快命中的查询可能更慢。采纳依据是有界运行与主事件循环响应；不承诺所有搜索更快。基准为探索性样本，没有覆盖 SQLite 读入、真实语义召回质量、生产索引生命周期或跨平台发布。

复跑入口为 `mise tasks run native-search-benchmark`，默认报告写入忽略目录 `artifacts/native-search/`。Rust 合同、格式与静态检查入口为 `mise tasks run native-search-check`，已进入代码门禁。后续受信原生 Helper 与进程主管由 [CR-063](adr/ADR-024-native-runtime-boundaries.md#cr-063) 接续实施，签名与发布证据独立取证。

2026-09-18 评估的执行过程由 Git 基线与后续 PR 保留，当前测试入口以[测试策略](TEST_STRATEGY.md)、[工具任务](../../mise.toml)及关联测试为准。本文不复制测试耗时和终端日志，也不把历史绿色结果当作当前版本的发布证据。

### 17.4 单一文档的维护边界

§1～§12 保存现行架构与发布要求；§13 保存固定源码学习与复核；§14 保存来源编号和记忆研究；§15～§16 保存有证据边界的演进候选；§17 定义验证方式。采纳候选时更新对应现行章节和 ADR，避免在历史章节再建立一份现行合同。跨专题排序只编辑 `plan.md`，CAP 实现/发布状态只编辑追踪基线，Schema/OpenAPI/协议仍由机器契约及专项文档定义。

AVX-EXPL-002/010/012/015 与 T/AST/PET/DSH/PI/GPH/ARC/FND/G 编号保留作历史来源锚点。四份并入文档的原文、旧章节定位、完整评估日志和旧优先级从 Git/PR 追溯；不保留继续可编辑的同主题副本。文档统一不授权执行研究候选、生产换库或正式发布。
