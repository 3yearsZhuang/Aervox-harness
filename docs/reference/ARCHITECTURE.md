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

采用 **TypeScript-first 模块化单体 + 独立 Worker/Scheduler**。Web、API、后台任务和桌面壳共享契约、领域类型和 UI；SQLite（WAL 模式）是永久本地单用户业务真源，`@aervox/schema` 与 `@aervox/repositories` 分别承载结构和访问边界；AI、记忆、日记和插件通过稳定内部 Port 解耦。API 默认仅监听 loopback，非 loopback 必须显式启用并强制认证。CAP-033 由受信本地 Privacy Host/Helper 承担全量观察、画像、后台生命周期和主动动作，主动数据不得进入普通远程数据面；CAP-034/035 通过同机本地连接网关接入家庭环境和规范化健康信号。

MVP 不采用微服务，也不让 DSH、pi、BaiShou-Next 或任何模型供应商成为核心运行时依赖。共享数据库多租户、组织权限和 PostgreSQL 演进由 CR-030 取消；未来若重新需要多人协作或远程服务，必须新建 ADR，不能恢复旧租户字段作为捷径。

## 1.1 插件配置与页面边界（CR-006）

插件配置使用 Aervox Config Schema v1：Schema 随 Bundle 注册并存储在 `plugins` 表，配置值按 `pluginId` 存入本地 `plugin_configs`，secret 走 `plugin_config_secrets`（生产注入加密 SecretStore Port）。插件 Page 只加载本地 Bundle 静态资源，运行在受限 iframe 中并通过 Host Bridge 读写本插件配置；不开放插件自有后端路由、文件上传、SSE 或直接数据库访问，符合 `ADR-009` 与 `AVX-CAP-001` 的沙箱与最小权限要求。

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
| Retrieval | SQLite FTS5 + VectorSearchPort（`sqlite-vec`/内存适配） | 记录 embedding 模型/维度/版本，可离线重建；MVP 不引入 Neo4j/独立向量库 |
| Queue | 本地 SQLite Outbox + Worker 轮询 | 至少一次投递、幂等键、重试、指数退避；SQLite Outbox 是持久化真源（CR-030） |
| Object | 本地文件系统目录（attachments/exports） | 本地安全存储、上传前后做大小/格式/解压比扫描；删除遵循数据 SLA（CR-030） |
| AI | 内部 `ProviderPort`：`@aervox/core` 自研 OpenAI 兼容流式 Provider（运行时零外部依赖，ADR-021） | 业务通过内部接口调用模型；本地 llama.cpp 侧车以 OpenAI 兼容端点接入（model-runtime）；模型不能直写业务表 |
| Desktop/mobile | Electron（P1）、Capacitor（后续，打包 web UI） | `contextIsolation`、关闭 `nodeIntegration`、受限 IPC、签名更新包、逐项设备授权；CAP-033 使用独立签名 Privacy Host/OS Permission Broker 管理后台和设备能力；移动端优先 WebView 壳，团队用 RN 仅当细粒化需要原生能力时评估 |
| Test/observability | Vitest、Playwright、Testing Library、fast-check、OpenTelemetry、Pino、Prometheus/Grafana、Sentry | 正常 CI 不依赖实时供应商；日志默认不含完整用户内容 |

## 3. 仓库与领域边界

本地 `dsh_search_code` 经 API 调用受控 `ripgrep` 子进程，平台二进制由锁定的 npm 依赖分发；取消、扫描范围与资源限额见 [CR-062](adr/ADR-024-native-runtime-boundaries.md#cr-062)。向量召回仍由 SQLite 仓储执行 JSON 行扫描与有界 top-K，授权资格仍回读业务真源。`native/tools/vector-pilot` 是只读合成夹具的 Rust 计算试点，不进入默认 API/Worker 运行路径；工具版本统一锁定于 `mise.toml`。`@aervox/native-runtime` 经现有 Port 提供只读 SQLite 向量缓存、受租约控制的应用活动 Helper 与声明进程主管，具体授权、平台和生命周期差量见 [CR-063](adr/ADR-024-native-runtime-boundaries.md#cr-063)。

| 边界 | 职责与所有权 |
|---|---|
| `apps/` | API、Worker、桌面、Web、CLI 与移动壳；宿主组合根负责装配，平台桥留在各端 |
| `packages/contracts` / `schema` / `repositories` | 公共协议、数据库 Schema 与事务仓储；业务写入不能绕过仓储 |
| `packages/host-runtime` | API 与 Worker 共用产品装配、执行与权限；API 监听，Worker 调度，见 [ADR-021](adr/ADR-021-aervox-core-standalone-package.md) |
| `packages/core` | 零运行时依赖的内核；宿主注入持久化、Provider 与业务工具 |
| `packages/host-plugin-api` / `plugins/` | 窄接口与插件自有实现；领域逻辑不回流到宿主或内核 |
| `packages/ui` / `ui-host` / `api-client` | 跨端组件、主题和传输；不依赖平台壳或数据库 |
| `native/` / `packages/native-runtime` | Rust 计算与受控进程，TypeScript 负责业务、授权、写入与生命周期 |

根界面由平台组合根选择受信第一方 UI 包，`@aervox/ui-host` 负责清单校验、加载和实例释放。工作台、桌宠、主动陪伴界面与设置面板的实现各归所属插件，`@aervox/ui` 保留跨界面构件和主题；详见 [ADR-025](adr/ADR-025-ui-surface-hosts.md)。第三方界面开放仍为 [ADR-026](adr/ADR-026-ui-surface-open-ecosystem.md) 提案。

实际包与依赖以 workspace 清单、各包清单和[导入边界守卫](../../scripts/import-boundary.mjs)为准；本表说明架构职责，不逐项镜像磁盘目录。

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

### 3.1 共享产品宿主结构（演进式模块化单体）

`packages/host-runtime/src/` 采用**按领域模块组织**的结构（ADR-014 0.3.0 两层分组：25 模块 → 6 域，归属表见 `CR-052 §3.1`（已归档）），每个模块自管路由与仓储实例化，跨模块解耦走持久化的 SQLite Outbox 表由 Worker 轮询投递：

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
| 对外入口唯一 | 每个模块只有 `index.ts` 对外可见，`routes.ts` 内部函数不被其他模块引用 |

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

Web 与桌面端使用 `@aervox/ui` 的 `AervoxWorkbench`、主题与设置组件，通过 `@aervox/api-client` 消费同一 API/SSE 合同。Web 使用 Fetch 传输，Electron 注入受限 IPC 传输；重连、去重与 `Last-Event-ID` 语义相同。平台组合根注入能力，不让共享组件依赖 Electron 或 Capacitor。

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

`ProviderPort` 至少支持 `streamText`、`generateObject`、`embed`、`classify`，并声明上下文长度、成本、数据地区和能力。流式协议采用 POST 创建 Turn + GET SSE，事件使用 Turn 内单调 `eventId/sequence` 和 `Last-Event-ID` 重连；供应商输出先进有界分段缓冲，逐段通过安全/结构检查并持久化后才展示。TTFT 从 Turn 持久化接受时刻起计到首个已安全检查且持久化的可见分段，另记端到端首段渲染延迟。每个 `ModelRun` 记录模型、供应商、Prompt、ContextManifest、token、延迟、成本、失败和安全决策；默认不记录完整敏感 Prompt。

附件、网页、插件输出和外部题库都是不可信数据，不能覆盖系统提示或直接触发工具。模型只能请求工具，权限代理根据用户授权和工具策略作最终决定。CAP-033 主动动作还需校验 `FullProfileActionGrant`、目标 scope、设备 lease 和本地处理证明；用户确认后可覆盖声明的本地、外部、特权和不可逆动作，但模型/插件不能自授。插件默认无数据库、文件、网络、记忆和日记权限；远程插件能力仍需隔离运行，桌面插件使用受限子进程，Node `vm` 不作为安全沙箱。

## 8. 日记调度与时区

Worker 消费到期计划，日记周期拥有素材窗口，执行 Attempt 拥有一次尝试；日期标签不能替代窗口身份。调度变更通过版本和租约隔离旧任务，发布与游标推进由同一事务提交。

UTC/IANA 时区、首次窗口、迟到素材、补写、CAS/fencing 与跨时区规则见[数据库契约](DATABASE.md)和 [ADR-011](adr/ADR-011-diary-cycle-schedule-revision.md)。任务调度频率以 Worker 配置为准。

<a id="arch-nfr"></a>

## 9. 非功能、容量与灾备

性能、可用性、日记发布、删除与灾备指标只维护在 [SRS 非功能需求](SRS.md#srs-nfr)。部署容量按本机 CPU、内存、磁盘 I/O 与 SQLite 写入吞吐测量；云端多用户容量基线已取消，不作为本地发布达标依据。云端可用性及 RPO/RTO 的本地适用目标仍待复审，见[未决事项](REQUIREMENTS_TRACEABILITY.md#operational-decisions)。

告警覆盖 API 错误、TTFT、队列延迟/DLQ、日记迟到、来源验证失败、删除积压、AI 成本和安全分类异常。逐场景恢复操作见[运行手册](operations.md)。

### 9.1 成本与供应商降级

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

下表纠正旧评估中的现状判断。并行提交的能力单独标注；未合入主线的工作不视为当前默认行为。

| 历史评估中的判断 | 本次实际检查 | 真正剩余的问题 |
|---|---|---|
| ContextManifest 只保存首个 Step | [recording-provider](../../packages/core/src/recording-provider.ts) 已对每次实际请求复制消息、工具和生成参数；[多 Step/重试测试](../../packages/core/test/context-manifest.test.ts)已覆盖 | 诊断写入仍为 best effort，不能当作恢复或授权账本；新建议应聚焦实际使用的策略版本及消费链路 |
| 规则压缩只留首尾并伪称生成摘要 | [context-builder](../../packages/core/src/context-builder.ts) 已保留 system 和完整工具组，并明确提示被省略的消息没有生成摘要；[测试](../../packages/core/test/audit-provider.test.ts)验证配对 | 仍未实现保真摘要；应验证学习目标、错因、承诺和来源的保留，以及摘要失败后的明确降级 |
| 需要新增缓存 Token 分账字段 | [Provider](../../packages/core/src/openai-compat-provider.ts) 已解析缓存读写用量，[存储工具](../../packages/repositories/src/token-usage.ts)也已有分账 | [ModelRunRecord](../../packages/core/src/types.ts)没有 usage，recording-provider 未向记录传递用量，[API 装配](../../packages/host-runtime/src/modules/companion/conversation/agent-executor.ts)结束记录只传状态和耗时；需接通实际调用到数据库的链路 |
| 插件注册失败没有 owned lifecycle | `511f9d1e` 已增加 owned activation、暂存注册、失败回滚和 scope 失效 | 注册生命周期和分发包升级是不同问题；仍应独立审查安装目录、持久状态、恢复日志和进程崩溃，不能重复建设已有注册层 |

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

`aac255b` 把并发预取和 FIFO 播放分开：后一句先合成完成，也要等待队首；静音通过音量处理，使结束回调和气泡收尾继续运行。对伴学解释很重要，否则“因此……”可能先于推导被读出。思隅已有[合成入口](../../packages/host-runtime/src/modules/platform/voice/service.ts)和[语音试听](../../surfaces/panels-ui/src/persona/VoiceAbilityCard.vue)，应基于这些入口测试分段顺序、打断、静音和迟到结果。

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
| AST-06 | IM 平台适配/群聊白名单/内容安全链路 | C | — | 与伴学 1v1 场景冲突 |
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

不采用多工作区 vault/共享租户、React/Expo 或 Tauri 全栈迁移、IM 群聊治理、另一套 JSONL Session 真源或外置图数据库。Git 快照只能是受控导出/历史载体，不能绕过一致性备份、删除和恢复规则；品牌、美术与第三方资产许可须单独检查。

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

本章是候选演进与历史反例。ARC/FND 分项来自 2026-09-18 基线 `6b20e7e`，其中“现状”“当前”、行号和实验结果均指该快照；后续闭环摘要按注明的 PR 解释。它们不能直接证明今天仍有同一缺陷。优先阅读 §13.3 的 2026-10-14 复核，再对照主线源码、测试和[当前计划](../../plan.md)。

已合入的原子接单、配置/消息 CAS、锁回收、删除与控制继承切片，不重复列为待实现。PR #277 的插件 owned lifecycle、目录所有权和停机整改于 2026-10-15 独立合入主线，不属于 #278 的参考学习实现差量；注册激活回滚不自动证明分发包的崩溃恢复升级完成。现行契约仍由 §1～§12、专项契约和 ADR 定义，不由历史缺陷降低要求。

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

以下每项保留旧基线的故障触发条件、实现/库级区别和建议验收；“建议”不表示批准新架构。恢复账本、授权、进程信任、公开 Port 等合同差量先走 ADR，破坏性迁移继续停写、备份、显式范围、staging 校验、原子换库与回滚保留。

<a id="arc-01"></a>

#### 15.3.1 ARC-01：从接单成功到可恢复执行（历史评估）

原评估复现了领取前失败留下无租约 Running Attempt 的问题。消费隔离、死信、预加载失败与已有无租约 Attempt 恢复已由 [ITER-002](../../plan.md#iter-002) / PR [#228](https://github.com/3yearsZhuang/Aervox-harness/pull/228) 修复，回归入口为[对话派发恢复测试](../../apps/api/test/conversation-dispatch-resilience.test.ts)及 [Outbox 测试](../../apps/worker/test/outbox-worker.test.ts)。历史过程见 Git。PR #258 随后以原子接单闭合提前确认 Inbox 和尚未创建 Attempt 的窗口，故障与并发回归见[历史审计](#audit-findings)。

已受理任务须可追踪、重试不得重复消费或产生副作用，这些约束继续有效。容量准入、独立 Host 与完整互动恢复不由此切片自动证明，分别按 ITER-013/010 继续核验。

<a id="arc-02"></a>

#### 15.3.2 ARC-02：执行控制必须沿父子任务与 Driver 传递（历史评估）

**历史实现与证据。** [原生执行器](../../packages/core/src/executor.ts)已有工具 AbortSignal、租约心跳、默认 8 Step 和通常 5 秒工具超时；API 没有注入总 Turn 时长，相关默认值为 0。[OpenAI 兼容 Provider](../../packages/core/src/openai-compat-provider.ts)的默认 45 秒是随上游数据重置的空闲超时。持续输出不受它约束为固定总时长。

[Subagent/Workflow Contribution](../../packages/core/src/subagent-contribution.ts)没有把工具信号传入 delegate/WorkflowContext。[子任务执行器](../../packages/host-agent/src/subagent-executor.ts)另起 lease、仅限制 4 Step；[API 组合根](../../packages/host-runtime/src/modules/companion/conversation/index.ts)为子任务构造 Provider 时，没有传入父执行器使用的 `requireLocalOnly`、路由和会话上下文。父本地处理约束不能据此推断子任务已继承。Workflow 需注入定义才出现；Subagent 已在生产组合根注册，默认子任务无工具且禁止递归委托，这些保护应保留。

**已复现与限制。** 两步 Fake Workflow 在第一步取消信号后仍执行第二步并返回成功；Fake Subagent 收到的 delegate 输入不含 signal。实验没有运行真实模型或外部副作用。父工具超时后子模型是否继续写入属于这条接线导致的风险，不是本轮已观察到的用户数据事件。

**建议。** 用窄的执行控制对象传递根/父任务身份、取消、绝对截止时间、删除/授权修订和本地处理约束；子任务只能收紧父策略。预算先覆盖墙钟、调用数与并发，再按真实 usage 增加 token/成本；恢复不能重置已消耗预算。没有取消能力的 Provider 应停止新派发、丢弃已取消结果，必要时依赖受限进程终止。已发出的外部动作仍可能结果未知，取消不等于副作用撤回。

**Driver 边界。** [API 执行器](../../packages/host-runtime/src/modules/companion/conversation/agent-executor.ts)的 DSH 分支在原生本地策略检查之前返回；[Adapter](../../packages/host-agent/src/adapter-turn.ts)与[当前 runner](../../packages/host-agent/test/fixtures/dsh-turn-runner.mjs)没有自动继承原生全部控制合同。当前 runner 是 `stream:false` 的单次兼容请求，库模式仅探测 DSH 导出；推广完整外部 Agent 前，应逐项验证本地策略、取消、删除、租约、工具账本与终态原子性，不能凭名称认为实现等价。

**验收。** 父取消后子任务不再进入下一步；总截止时间覆盖持续输出；本地处理任务委托时拒绝 Fake 远程 Provider；重启后累计预算连续。Driver 使用同一合同夹具，但可以明确声明不同能力等级；当前没有证据支持宣布 DSH/Pi 与原生执行完全等价。

<a id="arc-03"></a>

#### 15.3.3 ARC-03：动态工具的可执行性与可发现性（历史评估）

**历史实现与证据。** [createRuntimeToolProvider](../../packages/host-runtime/src/modules/companion/conversation/tool-providers.ts)返回 `tools: []`，执行时才读取注册表。[组合器](../../packages/core/src/subagent-contribution.ts)只合并已有清单，模型 Provider 又只将 `request.tools` 转成 function Schema。因此静态 Subagent/Question/Practice/已配置 Workflow 可见，Memory、MCP 和插件注册工具不会自动进入真实模型请求。

**已复现。** Fake 注册表包含一个只读 `fake_memory`，静态 Provider 包含 `fake_static`。捕获真实 OpenAI 兼容序列化生成的请求体，只看到 `avx_fake_static`；直接调用动态 `fake_memory` 却成功。这个实验解释了为什么手写 ToolCall 的执行测试可以通过，同时真实模型无法自然选择该工具。

**建议与验收。** 在上下文构建前产生经过可见性与能力级别过滤的工具 Schema 快照，记录注册修订；执行时仍重查启用状态和授权。先实现每 Turn 清单，再根据注册版本失效缓存；工具很多时才评估按任务筛选。验证应捕获模型 HTTP 请求体，覆盖安装/启用/禁用与在途旧快照；不能把发现缓存变成授权真源。此项会增加 Prompt 开销，应与 FND-08 的完整上下文预算一起测量。

<a id="arc-04"></a>

#### 15.3.4 ARC-04：自动恢复与互动等待的连续性（历史评估）

**接线边界。** 当前 [Attempt Recovery Worker](../../apps/worker/src/attempt-recovery.ts)主要将过期 Running 收敛为 Interrupted，并处理未知工具结果；`createAgentHost` 和 `createSqliteResumeSource` 尚未接入默认生产启动。已提交答案、已批准工具与已恢复执行是三个不同事实。

**库级已复现。** [decideResume](../../packages/core/src/resume.ts)在同一 Step 的事件为 `request1(seq=1) → result1(seq=2) → request2(seq=3)`、账本只有第一个执行完成时，返回 `resume=true,lastSequence=2`。它没有证明所有请求都具备账本，而且游标低于持久最大序号 3。[ResumeSource](../../packages/host-agent/src/sqlite-resume-source.ts)还需要按 executionId 正确关联多工具结果与互动事件。当前未接线，不能把这个实验描述为默认 API 已重复执行副作用。

**互动语义。** 当前审批结束主要依赖新 Turn 命中已有授权，不是原 Attempt 自动续跑；授权查询按工具名、参数和 granted 匹配，虽记录 `toolVersion`，查询未校验该版本，一次性消费与有效期语义也未闭环。这是需要明确的持续授权语义，不能直接用“一次批准”概括。[问题协调器](../../packages/host-runtime/src/modules/companion/conversation/user-question-coordinator.ts)能持久接收恢复后的答案，但原进程 Promise 消失后仍需后续执行消费者。

**建议与验收。** 自动恢复启用前，先固定完整请求/账本覆盖、全体持久事件高水位、当前 Attempt 归属和原子接管规则；未知外部结果保持人工处理或明确补偿。将等待审批/答案与续跑意图关联，区分一次动作批准和持续规则授权。覆盖每个工具崩溃边界、多工具、缺账本、审批中重启、答案由另一进程提交和 Worker/Host 同时接管；不复用事件序号、不重复副作用、不吞答案。持久续跑语义及授权范围应先由 CR 冻结。

<a id="arc-05"></a>

#### 15.3.5 ARC-05：流式输出需要贯通整个链路（历史评估）

**历史实现与证据。** [collectStep](../../packages/core/src/executor.ts)将普通文本 chunk 收进数组，等待 Provider 当前 Step 完成后才批量 `recordSafeSegments`。reasoning 会在流中节流持久化；普通文本不会随上游首段立即可见。批量落库减少事务开销是已有收益，但整个 Step 并没有按字节数或时间切成有界窗口。DSH Adapter 则先收齐事件，runner 本身也未使用流式请求。

**影响。** 长文本可能表现为持续等待后集中出现；进程中途退出时，已接收但未落库的普通文本没有重放依据。FND-06 处理 SSE 的下游慢连接，无法单独解决这个上游等待。本轮是源码审阅，没有测量真实首字延迟或内存峰值。

**建议。** 采用“Provider → 有界安全分段 → 批量持久提交 → 广播 → 有界 SSE”的链路。窗口由字节/时间双阈值控制，只有通过检查并提交的内容才可见；一旦输出已提交，Provider 重试要遵守已提交水位，不能重新播放整段。保留批量事务，不退回逐 token 写事务。Driver 的能力声明应说明真实增量输出还是整次响应后转事件。

**验收。** Fake Provider 慢速产生多段文本时，后段未到达前首个已批准窗口即可重放；中断只损失未提交窗口。对慢客户端同时验证 FND-06 的背压、分页重放与断连释放。分别记录上游首 chunk、首个安全持久段、客户端首渲染时间，避免用一个 TTFT 数字掩盖等待位置。

<a id="arc-06"></a>

#### 15.3.6 ARC-06：删除完成证明和恢复后的撤权保留（历史评估）

**活动路径的缺口。** [隐私路由](../../packages/host-runtime/src/modules/platform/privacy/routes.ts)创建 DeletionRequest，但没有物化目标；[删除 Worker](../../apps/worker/src/deletion-worker.ts)的 owner 清理仍是骨架，直接将目标标 completed 并生成 evidenceRef。空目标数组也可通过 `every(completed)`。已有消息/记忆软删与读取过滤有效，本项限定为统一删除编排，不能概括为所有删除入口无效。

**已复现。** 临时库创建一条记忆和对应删除请求/目标，执行真实 `runDeletionCycle` 后，请求与目标 completed、`verified_at` 已写、删除闸门由 true 变为 false，但记忆原文仍可通过仓储读取。[隐私仓储](../../packages/repositories/src/repositories/sqlite/privacy-repository.ts)的闸门只看 pending/in_progress，failed 也不继续阻断。完成状态不是零召回证明。

**建议。** 删除先形成范围化 deny/tombstone，再由数据所有者物化目标、幂等清理，最后独立核对真源、FTS/向量、附件及派生关系。只有验证成功才推进完成水位；空目标必须有范围确实为空的证据；失败或未知继续禁止受影响范围。先交付 Memory 与其索引的完整切片，再扩大到消息和派生数据，不把全局永久停用当作最终设计。

**恢复账本的区别。** [RecoveryLedgerRepository](../../packages/repositories/src/repositories/sqlite/recovery-ledger-repository.ts)目前仅见库/测试调用；撤权路由没有独立账本确认及恢复追平。[账本 Schema](../../packages/schema/src/ledger.ts)的 sequence 索引非唯一，追加使用 `MAX+1`；临时库并发追加得到 `[1,1]`，这是未接线库级问题。`tamperEvidence` 接收调用方值也不等于实现了防篡改链。

**演进与代价。** 基于既有恢复契约建立原子单调序列、幂等追加、账本确认后投影 deny、恢复水位追平。当前主库、Vault 与账本使用独立连接，不能据此获得跨库原子提交保证，应采用持久事件与幂等投影。独立文件也不自动具备独立故障域或防回滚能力；保留、密钥与备份部署按 ADR 明确。

**验收。** 删除中断、清理失败、并发新写、重复投递和旧备份恢复均不得让已删除/撤权内容重新可用；每个 completed 都有可重做的验证证据。账本不可读或水位不足时，受影响操作保持关闭。物理清理不应破坏用户数据恢复包的既定保留政策，继续遵循[数据隐私契约](DATA_PRIVACY.md)。

<a id="arc-07"></a>

#### 15.3.7 ARC-07：消息版本变更需要一个业务工作单元（历史评估）

**历史实现与复现。** [MessageStore.editMessage](../../packages/repositories/src/repositories/sqlite/conversation/message-store.ts)被 PATCH 消息路径直接调用。它先检查 expectedVersion，再依次标旧版本 superseded、插入新版本、更新当前指针，三步不在同一事务，写条件也没有真正的版本 CAS。临时库用触发器在插入第二版时抛错，结果是当前指针仍指第一版、第一版已 superseded、未被替代版本数为 0。

**建议。** 将“一个活动消息恰有一个当前版本”作为仓储命令不变量，以短写事务完成创建版本、版本条件更新和旧版本推进；核对影响行数。与编辑相关的索引失效或派生重建意图可同事务进入 Outbox，文件/模型 I/O 留在事务外。复用现有 Turn、工具结果和安全片段的原子实现经验，不为所有仓储强行增加泛型事务层。

**验收。** 每个写点失败只允许完整旧版或完整新版；两个相同 expectedVersion 并发最多一个成功；编辑与删除竞争不能复活消息。由写者连接验证不变量。若已有历史不一致，先报告并显式修复，不能按最大行号静默选择。此模式随后可用于审查 FND-02 的配置 CAS，而不是仅加一个全局锁掩盖多步写问题。

<a id="arc-08"></a>

#### 15.3.8 ARC-08：检索资格与派生索引生命周期（历史评估）

**历史读路径。** [createSqliteMemoryRecall](../../packages/host-runtime/src/modules/companion/conversation/memory-recall.ts)进行混合检索，再核对软删、verified 和 long_term；尚未统一执行 `aiRecallUntil`、用途与分类资格检查。临时夹具把记忆设为已过期且 Restricted，该条仍进入 recall。生产创建路径尚未见这些字段赋值，所以这是资格边界验证，不是已发现真实敏感数据泄露。按[隐私授权](DATA_PRIVACY.md)，Restricted 默认不进入普通记忆；`restricted.profile` 仅授权 CAP-033 指定范围的本地处理，不自动授权普通长期记忆召回，不能增加一个通用授权开关就放行。

**历史索引。** [记忆写工具](../../packages/host-runtime/src/modules/companion/memory/memory-store-tool.ts)先写业务记录，再更新 FTS，再调用 embedding；任一步失败不代表前一步已撤销。[FTS](../../packages/repositories/src/search/fts.ts)默认 `unicode61`，临时中文样本“今天学习数学”全文命中 1 条、子词“学习”命中 0 条；这说明需中文检索质量基线，不代表所有中文查询都失败。

**可选回填的缺口。** [Embedding Worker](../../apps/worker/src/embedding-migration.ts)默认没有注入 Provider，直接返回 0。注入最小 Provider 后，真实临时库报 `no such column: r.workspace_id`，说明扫描仍引用已移除的历史列；修复应采用当前 LocalContext，不能重新加入旧隔离列。扫描也未按模型区分缺失；[向量适配器](../../packages/repositories/src/repositories/sqlite/memory-embedding-repository.ts)的通用 upsert 使用 `vec_<memoryId>`，不符合多个模型版本共存方向。后者是库级静态风险，当前主要生产调用是 search，不能声称已经覆盖了用户旧向量。

**建议与权衡。** 业务记录继续是真源；FTS/向量是可删除重建的投影，携带来源修订、索引版本、模型/维度与资格水位。返回模型上下文前做权威资格检查，必要时过采样以补足合格 topK；写入通过 dirty/reindex 意图可恢复追平。新模型使用独立版本构建、验证再切换，避免就地覆盖。中文分词或字符 n-gram 需比较 Recall@K、空间与构建成本，不能只看返回条数。

当前向量检索仍读取模型下的 JSON 向量，在 JavaScript 做余弦评分；2026-10-12 的 CR-062 切片将全排序替换为保持同分顺序的有界 top-K。合成对照显示 JSON 解析仍占据主要成本，连续数组与 Rust 计算均值得进一步比较；尚无生产查询瓶颈证据。候选过滤、数据表示和原生计算须分别测量，再决定是否接入 SQLite 向量扩展。没有证据要求引入外置向量服务。

**验收。** 正常、过期、撤权、软删与 Restricted 数据混合，越权结果必须为零，且无资格旧索引不能挤掉合格结果；索引失败后可追平；模型 A→B→A 能切换并保持来源版本。权限验证、中文质量和检索性能分别报告，不能用一项通过代替另外两项。

<a id="arc-09"></a>

#### 15.3.9 ARC-09：启动建表、Schema 迁移和索引重建分工（历史评估）

**历史实现与复现。** API 与 Worker 默认启动均调用 `initDatabaseSchema`，已有索引等价性测试；现有 [runMigrations](../../packages/repositories/src/migration/migration-service.ts)提供名称/时间 journal，但本轮只见测试调用，未接入默认启动，也没有校验和或恢复状态。这些基础不等于完整旧版本升级已经验证。[buildCr030Staging](../../packages/repositories/src/migration/staging-migration.ts)只识别虚表 SQL，仍会复制 FTS shadow 表。两个当前完整 Schema 的临时库执行该流程，报 `UNIQUE constraint failed: memories_fts_config.k`；现有 staging 测试主要使用简单父子表。此路径属于迁移库/演练，正常启动不自动执行搬库，不能描述成线上搬库事故。

**建议。** 明确主库、Vault、账本各自的受支持 Schema 版本和迁移计划，业务表按清单迁移；排除虚表及其 shadow 表，FTS/向量从有效源记录重建。完善并接线现有迁移 Runner，记录步骤、校验和与恢复状态；服务启动只在兼容性检查和受控协调后放行，避免多个进程同时尝试未版本化 DDL。主库和 Vault 使用完整初始化的表集合可以后续收窄，不应因此合并隐私边界。

**验收。** 使用包含 FTS、外键、软删、多模型投影的完整小库，从每个受支持旧版本升级；核对权威行/哈希、查询结果、删除水位和失败后的连接设置。保持已有索引 parity 测试并扩展列默认值、外键与数据转换。生产操作仍按[停写、备份、范围选择、staging、校验、换库与回滚](../how-to/run-database-migration-drill.md)执行，不能用简单文件 rename 测试替代数据库恢复演练。

<a id="arc-10"></a>

#### 15.3.10 ARC-10：领域目录需要可执行的所有权边界（历史评估）

**实测结构。** 对 `packages/host-runtime/src/modules/<domain>/<module>/` 下 130 个 TypeScript 文件做只读 AST 统计，得到 6 域、26 模块、14 条不同的模块间有向边，其中 10 条跨域；语法层面 10 处 value import、19 处显式 type-only 引用，解析失败和未解析相对路径均为 0。统计仅含顶层静态相对 import/export，不包含动态导入、ModuleContext 服务调用或真实调用图；value import 不保证最终保留在编译产物中。

代表依赖为 conversation→proactive 的画像/授权实现、conversation→plugins 的 Turn 插件、plugins→conversation 的 `stream-hub`、persona→skills。模块图中 conversation 与 plugins 双向相依，不等于已证明文件级 ESM 初始化环。真正的问题是内部实现路径成为其它模块的依赖，而重构时没有稳定公开边界。

**门禁覆盖。** [边界脚本](../../scripts/import-boundary.mjs)有 5 条包层规则；本轮现有检查与 14 项脚本测试全部通过。用纯内存 fixture 让 conversation 导入另一个领域的 `routes.ts`，检查结果仍为 `[]`。另一个语法错误 fixture 也因 parser catch 返回空结果；Typecheck 可另行发现语法错误，这只说明边界工具没有报告漏检，不代表整个 CI 会接受非法代码。

**与 ADR 的差异。** [ADR-014](adr/ADR-014-modular-monolith-structure.md)要求模块仅 `index.ts` 对外、跨模块经 shared 总线，而 `event-bus.ts` 没有领域调用者（已在卫生清理中移除）；[ModuleContext](../../packages/host-runtime/src/modules/context.ts)仍提供 raw db/client 和按顺序填入的可选服务。对话模块也直接创建多个领域仓储。目录分组已经完成，数据所有权与接口强制还没有同等程度的保证。

**候选演进，需 ADR。** 同步查询/命令使用明确类型的公开 Port，异步业务副作用走有归属的持久 Outbox，短暂 UI 通知走进程内广播；三者各自声明失败和重放语义。先冻结实际需要的公开接口，再增加 API 内部深层引用限制、数据写入所有权和解析失败报告。已有违规用带 owner/退出条件的迁移清单逐步收敛，不一次性把所有业务塞进 shared，也不机械改成异步事件调用。

**验收与代价。** 注入跨模块私有路径必须失败；批准的公开 Port 必须通过；模块可在 Fake Port 下独立测试。将可变全局槽替换为每模块所需的窄依赖对象，组合根在启动时检查必需依赖。此举增加接口维护成本，但能让后续变更范围可预测；它不要求拆服务，也不需要立即改造所有 26 个模块。

<a id="arc-11"></a>

#### 15.3.11 ARC-11：模型制品接收需要受限且可验证（历史评估）

**生产范围。** [Model Runtime](../../packages/host-runtime/src/modules/ecosystem/model-runtime/index.ts)默认注册；下载端点受全局认证，生产/strict 要求 Token，开发 open 模式仅允许 loopback 监听。它不是未认证的公网接口，但仍需对已接收请求做路径和内容验证。

[请求 Schema](../../packages/contracts/src/model-runtime-schemas.ts)的 `fileName` 仅为可选字符串；[服务](../../packages/host-runtime/src/modules/ecosystem/model-runtime/service.ts)直接 `path.join(modelsDir, fileName)`。[下载器](../../packages/host-runtime/src/modules/ecosystem/model-runtime/downloader.ts)在 416/405 后重新全量请求，没有再次检查响应成功；206 续传没有核对 Content-Range 与实体版本。已有并发 2、`.part`、流式写入、rename、可选 SHA-256 和活动任务去重，应保留。

**三个安全复现。** 实验仅使用自建临时目录和 Fake fetch：`../escaped.gguf` 覆盖了模型目录外的临时哨兵文件且未被扫描注册；416 后返回的 500 错误正文仍保存为正式模型；旧前缀 `OLD` 遇到错误起点的 206 响应仍追加为 `OLDNEW`。没有访问下载源，也未读写真实用户数据或仓库文件。

**建议。** 请求规范化后进入私有 staging，服务端拒绝路径分隔/编码越界，最终 resolve 并检查根目录与 symlink 边界；逐次请求验证状态、范围、实体标识、总长和截断。内容验证后再原子提升并注册。可信摘要校验与“计算出了摘要”应区分，未验证来源应有明确状态。续传前缀哈希目前整段读入内存，可改为流式，并增加磁盘、大小与总时限配额。

**验收与代价。** 越界、符号链接、错误响应、内容变化和重启不得写出模型根或注册坏文件；成功下载与 autoStart 失败分开可见。代价是校验 I/O、侧车状态和失败恢复逻辑，收益首先是正确性；制品信任策略变更记录 ADR，无需新增下载服务。

<a id="arc-12"></a>

#### 15.3.12 ARC-12：进程代际、资源准入与真实就绪（历史评估）

**模型进程问题。** [LlamaServerManager](../../packages/host-runtime/src/modules/ecosystem/model-runtime/llama-server.ts)的启动 deadline 只在循环外计算，等待 `/health` 的 fetch 没有单次超时；旧 child 的 exit/error 回调可修改当前全局状态。Fake 实验中，设置 20 ms 超时后观察到 136 ms 仍在 starting，说明等待未受总截止控制，136 ms 不是性能基准。另一实验在新 child 已 running 后触发旧 child exit，状态变成 error、PID 为空。

可见日志虽有上限，内部 stderr chunks/无换行 partial 仍可增长；指标 fetch 无时限，2 秒采样无在途锁。这些是静态资源风险。已有 busy 拒绝、SIGTERM→SIGKILL、健康探测和 Fastify onClose dispose，不应重新实现一套接口。

**建议。** 每次启动分配 epoch，child、探针、取消与日志归属于同一运行对象；只有当前 epoch 可修改当前状态。start/stop/delete 控制串行化；stop 返回应区分确认退出和仍在清理，不能在旧进程状态未知时启动第二个模型。健康与指标 I/O 都继承总截止时间，探针最多一个在途，内部日志按字节限额。

**多模态资源事实。** [SenseVoice](../../packages/host-runtime/src/modules/platform/voice/asr-providers.ts)已缓存识别器、使用异步初始化/解码并串行 decode；不是每次都同步重载模型。但队列无长度/等待预算，语音请求 Port 没有统一取消和 dispose。模型状态/重配置路径存在约 227 MB 权重同步读取校验；远程 ASR/TTS 的 fetch 和整段音频读取也需时限/大小边界。内置 llama-server 默认 4 线程、SenseVoice 配置 2 线程、下载 2 并发只是局部配置，不能证明全机资源预算合适。

**资源演进。** 先给每个 Provider 有界队列、优先级、取消和等待上限，再以轻量协调器管理交互推理与后台下载/校验的竞争；模型切换执行停接单、drain/取消、释放、加载的生命周期。原生库难以取消或初始化显著阻塞时，再选择 Worker Thread/受限子进程隔离。不要因需要隔离计算而拆分全部业务服务。

**就绪等级。** [通用 LLM 探活](../../packages/host-runtime/src/modules/ecosystem/llm/health-prober.ts)已有 5 秒超时，但 `/models=200` 不证明目标模型存在或可推理；404/405 也不会触发其仅在异常分支实现的 fallback。建议区分配置有效、制品验证、进程存活、模型加载、推理可用。`GptSovitsLocalProvider` 与默认 `ocr.mock` 的占位问题仍需对照基础边界评估与硬件文档逐 Provider 复核；HTTP TTS 可指向同机真实服务，应单独验收，不能由一个占位 Provider 推断全部本地语音不可用。

**验收。** 永不返回的探针、旧 exit、取消队列项、旧初始化迟到、日志洪泛和模型切换都保持有界；`/models` 不含目标模型时不标 ready。先用 Fake 资源预算验证控制，再用固定设备测 CPU、RSS、排队和 event-loop delay；本轮没有给出任何实际性能提升比例。

<a id="arc-13"></a>

#### 15.3.13 ARC-13：部署主管与客户端访问边界（历史评估）

**认证组合已验证。** 按 [app.ts](../../apps/api/src/app.ts)的顺序装配真实 [auth hook](../../packages/host-runtime/src/shared/auth.ts) 与 CORS，用内存 `/probe` 路由注入请求：open 模式对未知 Origin 返回 200 并反射允许源；Token 模式对标准浏览器 OPTIONS 预检返回 401，而直接带正确 Bearer 的 POST 返回 200。实验只证明服务端配置，不代表已经绕过具体浏览器的本地网络权限策略。

[Desktop 主进程](../../apps/desktop/src/main/index.ts)的 JSON 代理与 SSE 带 Bearer，但活动 `uploadAttachment` 路径只设置 Content-Type。该项为静态接线核查，未启动 Electron。FND-03 的 iframe 资源认证属于同一客户端类型矩阵，不能通过关闭 Token 来修复。

**建议。** 明确合法 Web 来源及桌面 IPC，严格验证的预检交给 CORS，真实业务继续认证。统一受限 transport 为 JSON、SSE、附件注入凭据、取消和超时，长期 Token 不出现在 URL 或插件页面。新来源策略按信任边界评审；漏发已有认证头可独立修复。

**部署需要解决的事实。** 现有桌面打包没有后端运行包；API 入口没有信号到 `app.close()` 的完整链路，Worker stop 不 drain，默认数据路径仍从仓库定位。模块 `onClose` 存在不代表操作系统退出时一定被调用。完整单机分发需明确谁拥有 API/Worker/模型子进程、数据目录、端口、Token、启动就绪、版本兼容与退出顺序。

**候选方案与验收。** 开发环境可继续独立启动各进程；桌面产品可由 Electron 管理受限后端子进程；无屏硬件则可由系统服务主管托管同一后端。两种产品部署应复用服务协议，避免把硬件固件直接接 SQLite。新的主管以 CR 冻结。用干净用户目录安装、启动、升级、端口占用、磁盘满、后端异常退出和卸载保留数据逐项验收，桌面签名/公证与真实设备恢复另列发布门禁。

<a id="arc-14"></a>

#### 15.3.14 ARC-14：CI 必须证明冷启动和真实输入（历史评估）

锁文件安装、包外输入触发、插件制品恢复与可重现导出任务已由 [ITER-001](../../plan.md#iter-001) / PR [#221](https://github.com/3yearsZhuang/Aervox-harness/pull/221) 交付。回归入口为 [ci-scope](../../scripts/ci-scope.test.mjs) 与 [export-plugins](../../scripts/export-plugins.test.mjs)，实际 Job 步骤见 [CI 工作流](../../.github/workflows/ci.yml)。

冷检出可恢复产物、仅插件变动仍触发验证、缓存不替代构建前置条件，这三项仍是验收要求。产品导出端点的可重现性属于 ITER-005，不能以构建脚本通过推定它已完成；静态资源缓存归属见[基础边界评估](#foundation-review)。

<a id="foundation-review"></a>

### 15.4 FND-01～10：基础边界与资源反例

本节同属 2026-09-18 历史快照，旧安装/锁/流式/调度诊断不覆盖后续修复。保留触发条件和验证设计，不恢复旧工期、P1/P2 排序或第二张活动任务表。

#### 15.4.1 FND-01：Outbox 消费归属与失败恢复（历史评估）

原缺陷是通用审计消费者提前发布压缩事件，导致业务消费者无法读取。消费归属与失败恢复已纳入 [ARC-01](#arc-01) 的闭环，保留 FND 编号供历史引用。业务完成前不得由审计消费者确认、重复处理必须幂等；新增多订阅契约仍需单独评审。

#### 15.4.2 FND-02：插件升级与失败恢复（历史评估）

**证据。** [分发引擎](../../packages/host-runtime/src/modules/ecosystem/plugins/package-bundle.ts) `installPluginFromBundle` 第 410～412 行在覆盖时先卸载旧插件；第 477～531 行先建立主记录，随后注册配置、Page 和资源，后几步异常只记 warning 并继续返回成功。[配置服务](../../packages/host-runtime/src/modules/ecosystem/plugins/config-service.ts) `cleanupPlugin` 第 391～399 行会清除配置、Secret 和 Page 数据。

**触发与影响。** 升级过程中磁盘写满、Schema 无效或 Page 注册失败，可能同时失去旧版本配置并留下部分新版本；返回成功也不证明插件完整可用。对未来硬件插件，这会表现为设备集成升级后凭据或控制页面失效。

**已有保护。** 安装前已经进行结构预检、重复安装拦截、校验和计算与路径约束，卸载有资源清理。它们尚未构成跨数据库和文件系统的原子升级。

配置写入也有并发边界：[配置仓储](../../packages/repositories/src/repositories/sqlite/plugin-config-repository.ts) `saveConfig` 先读取 revision，再仅按 ID 更新，未用 revision 条件保护 UPDATE；并发旧版本请求可能都通过检查而互相覆盖。[配置服务](../../packages/host-runtime/src/modules/ecosystem/plugins/config-service.ts)还先写 Secret、后检查普通配置版本，发生 409 不保证 Secret 未变。现有串行过期版本测试不能证明原子 CAS。该判断来自源代码审阅，本轮未执行并发配置复现。

**建议与权衡。** 在独立 staging 目录验证全部声明、配置和资源，生成安装计划后再激活新版本；用持久安装状态记录、短数据库事务及目录切换构成可恢复流程。旧版本、配置修订与 Secret 引用保留到激活成功，配置迁移需明确而不能复用卸载清理。数据库事务内禁止进行解压和文件复制。代价是额外磁盘空间及崩溃恢复逻辑；升级/卸载语义改变需在相应 ADR 中明确。

**验收。** 对预检、文件写入、注册、激活的每个失败点注入异常或进程退出；重启后只能处于完整旧版本或完整新版本，旧配置与 Secret 不因失败升级丢失。返回成功必须表示所有声明入口可读取；同一包重试安装不生成重复能力。

配置保存应使用带预期 revision 的条件更新，核对影响行数，并使同库 Secret 变更与配置在短事务内一致提交；未来外部 SecretStore 需另定义补偿策略。增加两个窗口同时提交同一 revision 的验证，预期恰有一个成功，其余返回冲突且不留下 Secret 部分写入。

#### 15.4.3 FND-03：Page Bridge 的身份、权限与撤权（历史评估）

**证据。** [Page 宿主](../../surfaces/panels-ui/src/plugin/PluginPageDialog.vue) `onMessage` 第 97～104 行校验 nonce，但未校验 `event.source` 与当前 iframe 的绑定；`handleBridgeCall` 第 60～89 行对配置读写检查 capability，`notify` 与 `close` 未做同等检查。nonce 由时间与 `Math.random()` 生成。[配置服务](../../packages/host-runtime/src/modules/ecosystem/plugins/config-service.ts) `readPageEntry` 第 370～378 行直接读取 Page，未检查插件启用状态；一般资源读取已调用 `requirePlugin` 检查存在性与启用状态，因此缺口集中在入口路径。

**触发与影响。** 同窗口存在其它 frame、Page 发生导航或插件被禁用时，Bridge 身份和生命周期可能脱节；已知 nonce 的其它消息源缺少第二道窗口身份校验。禁用后入口仍可读取，不能把“界面已隐藏”等同于执行已撤权。本次未进行利用链或端到端攻击验证。

**已有保护。** iframe sandbox、禁止直连网络的 CSP、nonce、配置读写 capability 及服务端配置校验已存在。受 sandbox 影响，消息 origin 可能为 `null`，因此不能机械要求 origin 等于普通站点 URL。

正常授权访问也需要补齐：[API 认证](../../packages/host-runtime/src/shared/auth.ts)在 Token 模式检查 Bearer 请求头，而当前 iframe URL 与页面脚本资源请求不注入该头，Page 资源会被拒绝。应设计受限的页面资源授权通道并验证 Token 模式，不能把关闭生产认证或将长期 Token 放入 URL 作为修复。

**建议与权衡。** 首先绑定 `event.source === iframe.contentWindow`，为普通源与 opaque origin 分别定义可验证策略；每次加载/切换生成加密随机 nonce，异步响应绑定发起时的 Page 会话。以显式方法表统一全部 Bridge 权限，禁用/撤权时销毁会话并让入口、资产和命令走一致门控。能力名称、兼容策略及新信任边界由插件契约/CR 冻结，不在 UI 层临时发明权限。

**验收。** 覆盖错误窗口、错误 nonce、导航后的旧响应、无权限通知、禁用后直接访问入口、禁用期间未完成调用；被拒绝调用不能产生配置写入或 UI 副作用，拒绝原因可审计。

#### 15.4.4 FND-04：归档预检的资源配额（历史评估）

**证据。** [分发引擎](../../packages/host-runtime/src/modules/ecosystem/plugins/package-bundle.ts) `inspectPluginBundle` 第 76～108 行先 `unzipSync` 完整展开，再检查路径；`installPluginFromBundle` 第 415 行再次展开。[插件路由](../../packages/host-runtime/src/modules/ecosystem/plugins/routes.ts) 已设置 20 MiB HTTP body 上限，但这不是展开体积或文件数量上限。

**触发与影响。** 高压缩比或大量小文件归档即使满足上传限制，仍可能占用大量内存并同步阻塞 API 事件循环；同进程对话、心跳和设备请求会一起受影响。此项未通过压测量化。

**已有保护。** 上传体积限制、ZIP 格式检查和不安全路径拒绝已经存在。路径校验不会约束展开成本，校验和也不提供发布者签名认证。

**建议与权衡。** 在解压前读取归档目录，并在实际展开期间持续限制总字节、单文件字节、文件数、路径深度和处理时限；不能只信任归档声明大小。复用一次验证后的 staging 内容，把解压移入受控 Worker Thread/子进程或采用有界流式处理。签名信任根属于另一个准入决策，应单独冻结，不能把 SHA-256 摘要标为已验签。代价是预检流程更复杂、并发安装需限流。

**验收。** 使用高压缩比、多文件、声明大小不符、超时和正常最大包夹具；超额包在配额内终止，安装失败不改变旧插件，API 心跳仍可响应。具体配额经正常插件样本统计后确定。

#### 15.4.5 FND-05：宿主轮询故障与停机（历史评估）

**证据。** [Agent Host](../../packages/host-agent/src/agent-host.ts) `tick/start/stop` 第 186～235 行使用 `setInterval(() => void tick())`，候选查询没有轮询在途锁和异常收敛；`stop` 持续等待运行数归零，没有总截止时间。[WorkerHost](../../apps/worker/src/worker-host.ts) `stop` 第 162～172 行只清定时器，不等待已开始的 Job；[Worker 入口](../../apps/worker/src/index.ts) 启动后没有相应信号停机与连接关闭流程。当前 `createAgentHost` 的直接调用主要在测试，不能据此宣称默认 API 已经由此宿主驱动。

**触发与影响。** Agent Host 被接入时，慢候选查询可能重叠，后续查询拒绝可能成为未处理 Promise 拒绝；不响应取消的 Provider 可能使停机长期等待。当前 Worker 被终止时，在途 Job 是否完成依赖操作系统终止时点。

**已有保护。** Agent 有并发槽、fencing、健康状态与 drain；Worker 已隔离 Job 异常并禁止同一 Job 重叠。原生 Loop 已有流内取消检查和工具 AbortSignal，真实模型适配也有请求超时配置；需要补的是宿主总生命周期，不能重新实现一套工具取消。

**建议与权衡。** Agent 轮询用单次在途标记或完成后再调度，捕获 source 异常并计数退避；为两个宿主统一停止接单、等待在途、截止后取消、收敛状态和关闭连接的顺序。明确 Provider 不再产出 chunk 时如何被宿主取消，停机超时不得把未知副作用自动重放。较短停机预算改善退出速度，但会增加可恢复中断。

**验收。** 模拟 source 查询超过两个周期、连续拒绝、Provider 永不结束和 SIGTERM 到达写入中途；最多一个候选查询在途，无未处理拒绝，停机在配置截止时间内结束，重启后由原有恢复/幂等机制接续。无需为此拆成新服务。

#### 15.4.6 FND-06：SSE 的有界缓冲与持久恢复（历史评估）

**证据。** [SSE 路由](../../packages/host-runtime/src/modules/companion/conversation/routes.ts) 第 343～362 行忽略 `raw.write()` 的布尔返回值；第 371～438 行重放期间使用无容量上限的数组；[流事件仓储](../../packages/repositories/src/repositories/sqlite/conversation/stream-event-store.ts) `getStreamEvents` 第 92～107 行一次读取游标后的全部事件。路由第 470～481 行心跳不读取数据库；[恢复 Worker](../../apps/worker/src/attempt-recovery.ts) 在另一进程更新 Attempt，不会经过 API 的 [广播桥](../../packages/host-runtime/src/modules/companion/conversation/broadcasting-store.ts)。

**触发与影响。** 慢客户端或很长的事件重放会扩大应用/Socket 缓冲；后续独立执行宿主写入、或 Worker 恢复终态时，当前连接不能仅靠进程内广播获知状态变化。持久化数据仍可用于重连，不应把这一风险描述为所有 SSE 数据丢失。

**已有保护。** 先订阅再重放、序号去重、稳定游标查询、15 秒心跳、10 分钟连接时限及终态排空均已存在。

**建议与权衡。** 使用按序号分页的高水位重放，写入遇到背压时等待 `drain`，对单连接和全局缓冲设上限；超限慢消费者可主动断开，客户端按持久游标续传。跨进程终态优先增加受控状态通知，必要时使用低频、有界的持久水位核对；继续保留当前总线用于低延迟路径。不要恢复每连接高频空查询。跨进程通道若改变部署/信任边界需 ADR。

**验收。** 覆盖限速客户端、10 万条合成事件重放、重放中断线、终态发生于另一进程和广播遗漏；连接内存受配置上限约束、重连无缺号、重复事件可去重、终态在规定窗口内可见。合成规模用于暴露边界，不代表当前用户会产生此流量。

#### 15.4.7 FND-07：会话锁回收与 SQLite 写竞争（历史评估）

**证据。** [会话锁](../../packages/repositories/src/session-lock.ts) `runExclusive` 第 38～44 行把 `run.then(...)` 存进 `tails`，第 54 行却比较 `tails.get(key) === run`，两者不是同一个 Promise。本次对 100 个不同 key 依次执行空任务后，纯内存复现得到 `activeLockCount=0`、实际 `tails.size=100`。仓库搜索只发现定义和测试调用，未找到 `apps/` 生产接入，因此这是库级缺陷，不能推断它已造成当前 API 长期内存增长。

SQLite 写竞争的独立证据在 [客户端](../../packages/repositories/src/client.ts) `createDatabase` 与 [重试封装](../../packages/repositories/src/write-retry.ts) `withBusyRetry`：默认忙等待 5 秒，部分操作最多尝试 5 次；事务 BEGIN 因当前驱动状态问题明确不自动重试。进程内会话锁无论是否接入，都不能解决不同进程争用同一 SQLite 写锁。

**触发与影响。** 库调用者创建大量不同会话 key 时，表面锁计数归零而尾链 Map 保留；API、Worker 同时进行写事务时，BEGIN 忙错误仍可能暴露。实际锁竞争率、等待分位数和影响范围本次未测量。

**已有保护。** WAL、忙等待、操作级退避、短事务、fencing 和 Worker 错峰已存在；安全片段也已批量提交，不能直接把逐 token 事务当作现状。读写一致性断言继续使用写者连接，不能通过放宽测试来隐藏快照滞后。

**建议与权衡。** 先保留实际存入 Map 的尾 Promise 并以该对象进行比较回收，补充不同 key 与排队重入的资源回收验证。随后记录 BEGIN/提交耗时、忙错误次数和重试耗时，以真实竞争决定是否增加每进程写入调度、批次限额或带抖动的总等待预算。只有可证明没有提交且操作幂等时，才在重新取得安全连接/事务状态后重试整个业务操作；不得盲目重试失败 BEGIN 或带外部副作用的事务函数。全局单写者服务会改变架构，当前没有测量证据支持直接引入。

**验收。** 10,000 个不同 key 完成后真实内部尾链条目归零，同 key 顺序和异常后继续执行不变；用两个独立进程写同一临时库测量 P50/P95/P99 等待及失败率，并测试长读快照。先记录基线再设改善目标，不能承诺未经测试的吞吐倍数。

#### 15.4.8 FND-08：完整上下文预算与保真压缩（历史评估）

**证据。** [历史读取](../../packages/repositories/src/repositories/sqlite/session-history.ts) 已限制 20 轮、32,000 字符，保留完整对话轮并排除删除/脱敏内容；[上下文组合根](../../packages/host-runtime/src/modules/companion/conversation/agent-executor.ts) 第 449～500 行还会加入技能、工具说明、召回和画像。[规则压缩](../../packages/core/src/context-builder.ts) `createSummaryCompaction` 第 154～168 行在超过消息数阈值后只保留首尾各两条，中间用数量说明占位，并不含中间内容摘要；该模式默认关闭，通过 `AERVOX_LOOP_COMPACTION=rule` 启用。

**触发与影响。** 较小上下文模型、大型工具 Schema 或长工具结果可能使完整 Prompt 超出模型窗口，即使历史本身已限长；启用规则压缩后，未完成目标、约束和工具对应关系可能被丢弃。消息数量和字符数都不是模型 token 预算的精确替代。

**已有保护。** 历史上限、安全过滤、按 Turn 缓存历史查询、压缩 Port 和上下文快照已经存在；无需重新建立上下文基础设施。

**建议与权衡。** 在最终组装后按 Provider 窗口预留输出预算，覆盖 system、技能、工具 Schema、召回、历史与在途工具消息；工具调用/结果成组保留，根约束与未完成事项不可随意删除。规则模式应准确标记为裁剪，或替换成有来源水位和验收的摘要；模型摘要额外增加延迟与成本，先采用可解释的整轮选择。新摘要必须继续受删除/撤权水位保护。

**验收。** 对长中文、代码、大型 Schema、工具多轮和删除后再召回建立固定回放；最终输入不超窗口，工具消息结构合法，最近目标与关键约束可追溯，压缩前后按任务完成率和上下文成本比较，而非只验证消息条数减少。

#### 15.4.9 FND-09：让已有观测能支持决策（历史评估）

**证据。** [SQLite 观测门面](../../packages/host-agent/src/sqlite-observability.ts) `createSqliteObservability` 第 65～74 行将 metrics 存入最多 10,000 条的内部数组，`flush` 为空，返回接口未提供读取这些样本的路径；审计插入失败在第 90～92 行输出错误后返回。[WorkerHost](../../apps/worker/src/worker-host.ts) 只在处理数量大于零时记录完成日志，跳过重叠周期直接返回。这些是具体实现的限制，不能推断整个仓库没有任何指标或日志。

第二轮确认 [API 组合根](../../apps/api/src/app.ts)已通过独立的 Metrics Registry 提供受认证的 `/v1/metrics`，支持 JSON 与 Prometheus；本项缺口仅限定于 Host 专用观测实现和未覆盖的运行信号。建议复用 API 已有注册表与导出能力，并核对 Worker/Host 是否实际接入，不另建重复端点。

**触发与影响。** 设备长期运行时，很难区分“没有工作”“一直跳过”“写竞争”“审计落库失败”；内存中样本存在也不等于运维或性能检查能使用它们。

**已有保护。** 日志、Metrics/Audit Port、Agent 健康检查及审计持久化已经存在；日志不应包含完整 Prompt、凭据或私密画像。

**建议与权衡。** 使用有界聚合器维护计数、直方图和最近错误，并通过受限本地诊断或脱敏诊断包读取；复用现有 Port，先不部署外部监控系统。补充队列最老事件年龄、Job 跳过数、忙等待、SSE 缓冲、上下文裁剪、审计失败等指标。指标可丢样，关键授权/副作用审计的失败策略则应依既有契约分别处理，不统一吞错或统一阻断。

**验收。** 人工注入一次队列积压、数据库忙、审计失败和慢连接，诊断数据能明确指出受影响路径；清空队列后相应 gauge 恢复。诊断输出不含用户正文、Secret 或设备敏感原始数据，存储容量长期有界。

#### 15.4.10 FND-10：静态资产与构建缓存的产物归属（历史评估）

**证据。** [Turbo 配置](../../turbo.json) 对 `@aervox/live2d#build`、`@aervox/public#build` 和移动端构建明确设置 `cache: false`。[Live2D 复制脚本](../../packages/live2d/scripts/copy-assets.mjs) 与 [公共资源复制脚本](../../packages/public/scripts/copy-assets.mjs) 从依赖包直接写入消费端目录，因此普通包内 `outputs` 不能完整表达其副作用。

**触发与影响。** 重复构建会重复复制资源；随着模型和多端资源增长可能增加 I/O。当前关闭缓存已保护正确性，本次没有测量这部分耗时，也未发现需要立即开启缓存的依据。

**建议与权衡。** 若冷/热构建统计显示复制占比显著，可让资源包只生成自身确定性产物，消费包在自己的构建生命周期复制到自有输出，或使用可追踪输入的打包资源导入。内容哈希避免无变化复制；迁移成本包括开发模式资源路径和打包兼容。保持受控测试并发及模板克隆，不要为追求表面 CI 速度扩大 SQLite 测试并发。

**验收。** 分别测量冷构建、热构建和更改单个资源的构建时间；删除消费端产物后，仅依赖可用缓存也能恢复完整资源；修改源资源能正确失效缓存。完成这些验证前继续保留现有 `cache: false`。

<a id="audit-findings"></a>

### 15.5 2026-10-08 审计的交付范围

审计基线 `d7fd6d87`，第一方 Git 文件与关键链路抽查；外部 reference 仅核对边界。以下是 PR #258 的历史交付，不等同关联 ITER 的全部合同或正式发布完成。

以下八项由 [PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) 承接；严重性描述的是原缺陷。源码和测试是行为证据，关联队列的其它验收仍独立保留。

1. **P1：删除完成没有清理证明（ITER-003，有限切片）。** [删除 Worker](../../apps/worker/src/deletion-worker.ts) 已按明确 owner/target 派发 [Memory 清理与独立验证](../../packages/repositories/src/repositories/sqlite/memory-deletion-store.ts)，清除正文、版本正文、摘要、FTS 和向量，保留无正文的 tombstone；索引写入端拒绝已删除记录的迟到结果。失败可重复轮询，空目标、未知范围/目标、旧占位证明不能解闸；已有共享树、时态事实或技能派生关系的目标明确拒绝完成，留待其 owner 实施清理。实效与保留无关数据由[删除回归](../../apps/worker/test/deletion-worker.test.ts)证明，完整来源传播和独立 deny 账本仍未闭环。
2. **P1：接单存在分离提交窗口（ITER-002）。** [Turn Store](../../packages/repositories/src/repositories/sqlite/conversation/turn-store.ts) 以一个写者事务关联 next-turn Inbox、Turn、消息、Outbox 和首个 Attempt；重复幂等键不再次消费或派发，执行器读取实际持久化输入。[接单回归](../../packages/repositories/test/turn-acceptance.test.ts)覆盖五个写点失败及并发，[API 回归](../../apps/api/test/conversation-dispatch-resilience.test.ts)覆盖 HTTP 重试、预加载失败和恢复。
3. **P1：动态工具没有收到调用级取消（ITER-007，接线切片）。** [Tool Provider](../../packages/host-runtime/src/modules/companion/conversation/tool-providers.ts) 的全部调用路径已传递 signal/controlContext；[Runtime](../../packages/host-runtime/src/modules/ecosystem/tools/runtime.ts) 合并调用、控制上下文和注册信号，结束/取消时解绑，MCP 代理继续传至 HTTP 请求。[生命周期回归](../../apps/api/test/tool-runtime-lifecycle.test.ts)与 [MCP 回归](../../apps/api/test/mcp-client.test.ts)覆盖预取消、在途取消、下一副作用拒绝和注册替换。取消需要 handler 在 I/O/副作用边界协作，尚不等于所有 Driver、子任务和授权修订合同完成。
4. **P1：消息版本更新缺乏原子 CAS（ITER-004）。** [Message Store](../../packages/repositories/src/repositories/sqlite/conversation/message-store.ts) 将旧版废弃、新版插入与指针切换纳入短事务和条件更新，同一消息在进程内按键串行；[组合写回归](../../packages/repositories/test/atomic-edits.test.ts)验证三处失败回滚与同版本竞争仅一项成功。
5. **P1：返回配置冲突前已改 Secret（ITER-004）。** [配置仓储](../../packages/repositories/src/repositories/sqlite/plugin-config-repository.ts) 同事务校验 revision、写 Config/Secret，重置也一致提交；不存在的配置仅接受初始 revision 或显式无条件写。[组合写回归](../../packages/repositories/test/atomic-edits.test.ts)与 [API 回归](../../apps/api/test/plugin-config.test.ts)证明 409 不改凭据、中途失败回滚、同 revision 仅一次成功；外部 SecretStore 补偿不在此范围。
6. **P2：取消后崩溃无法收敛（ITER-010，恢复切片）。** [Attempt 恢复](../../packages/repositories/src/repositories/sqlite/conversation/attempt-store.ts) 将过期 CancelRequested 收敛为 Cancelled，并在同事务推进 fencing、Turn 与终态事件；pending 工具结果记为 outcome_unknown，不自动重放。[重连回归](../../apps/api/test/conversation-dispatch-resilience.test.ts)验证旧 fencing 拒绝落库、重复恢复幂等及 SSE 观察终态；自动 Resume 仍不启用。
7. **P2：会话锁尾链泄漏（ITER-004）。** [SessionLockManager](../../packages/repositories/src/session-lock.ts) 现在比较实际存储的尾 Promise，观测值直接读取尾链 Map；[锁回归](../../packages/repositories/test/session-lock.test.ts)验证一万个 key 回收及异常后队列仍保留到末项完成。
8. **P2：共享资产与消费产物双份入库（ITER-017，资产切片）。** `packages/public` 成为介绍页和标记图的唯一源码；九个消费文件取消跟踪并忽略。冷构建已逐字节验证 Desktop/Web 消费目录和打包输入，已有禁用缓存保护保留；[资产回归](../../packages/public/scripts/copy-assets.test.mjs)验证从空目录恢复与重建清除旧派生文件。正式签名分发不由构建输入检查证明。

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
