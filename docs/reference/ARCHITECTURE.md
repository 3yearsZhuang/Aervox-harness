---
id: AVX-SAD-001
---

# Aervox｜思隅 系统架构设计（SAD）

<a id="AVX-WEB-001"></a>

关联 PRD：[PRD.md](PRD.md) · 追踪：[REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md)

本文回答“系统如何实现、怎样扩展和怎样在故障/删除/模型变更下保持正确”。产品目标和用户级验收以 PRD 为准；本文件不能扩大 PRD 已批准的权限、数据用途或生命周期范围。

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
| Language/build | TypeScript 6.x strict、pnpm 11、Turborepo 2.x | lockfile 必须提交；禁止 `latest`；Renovate 升级需通过契约/安全测试 |
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

### 3.1 apps/api 内部结构（演进式模块化单体）

`apps/api/src/` 采用**按领域模块组织**的结构（ADR-014 0.3.0 两层分组：25 模块 → 6 域，归属表见 `CR-052 §3.1`（已归档）），每个模块自管路由与仓储实例化，跨模块解耦走持久化的 SQLite Outbox 表由 Worker 轮询投递：

```text
apps/api/src/
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
├── app.ts                           #   Fastify 应用工厂：组装模块、注册路由（按域分组注释）
└── index.ts                         #   进程入口：创建 app、listen

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

两端主工作台均可显示共享 `Live2DPet`；Electron 另保留 `pet.html` 独立桌宠窗口、标题栏和窗口控制。Web 不提供 Electron 窗口能力。设置共用左侧分类/右侧详情结构，窄屏采用横向分类；主题、称呼、发送偏好、密度和提醒保存在当前设备，桌面主题通过受限 IPC 同步壳窗口。

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
