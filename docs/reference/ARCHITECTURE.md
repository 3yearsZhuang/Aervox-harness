# Aervox｜思隅 系统架构设计（SAD）

> 文档编号：AVX-SAD-001  
> 类型：Explanation  
> 版本：v0.1（评审候选）  
> 更新日期：2026-08-25
> 状态：Review Candidate  
> 关联 PRD：[PRD.md](PRD.md) · 追踪：[REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md)

本文回答“系统如何实现、怎样扩展和怎样在故障/删除/模型变更下保持正确”。产品目标和用户级验收以 PRD 为准；本文件不能扩大 PRD 已批准的权限、数据用途或生命周期范围。

## 1. 架构结论

采用 **TypeScript-first 模块化单体 + 独立 Worker/Scheduler**。Web、API、后台任务和桌面壳共享契约、领域类型和 UI；SQLite (WAL 模式) + 仓储抽象是业务真源，Redis 只负责缓存/队列，S3 负责附件；AI、记忆、日记和插件通过稳定的内部 Port 解耦。

MVP 不采用微服务，也不让 DSH、pi、BaiShou-Next 或任何模型供应商成为核心运行时依赖。等 P3 的流量、组织权限或合规边界确实需要拆分时，再通过 ADR 把单一模块提取为服务，并保持业务事件、数据删除和客户端兼容。

## 2. 技术栈基线

| 层 | 选择 | 约束 |
|---|---|---|
| Runtime | Node.js 24 LTS | `engines`、容器和 CI 精确锁定；参考仓库最低 Node 22.19，适配器独立兼容 |
| Language/build | TypeScript 6.x strict、pnpm 11、Turborepo 2.x | lockfile 必须提交；禁止 `latest`；Renovate 升级需通过契约/安全测试 |
| Web | Vue 3、Vite 7、Element Plus（Vue 全栈单栈，见 ADR-015） | Web 复用桌面端 renderer 核心（composables/主题），首发是登录后流式应用；不依赖任何框架私有后端能力 |
| UI/editor | Element Plus + 定制主题（迁移自 desktop styles）、CodeMirror 6 | 组件共享、键盘可用和 WCAG 2.2 AA |
| API | Fastify 5、Zod 4、OpenAPI 3.1、POST Turn + GET SSE（Fetch 消费） | 客户端和插件通过契约访问；事件 envelope、重连、取消、幂等和安全持久化遵循[流式协议契约](STREAMING_PROTOCOL.md)；不以 tRPC 锁定消费者 |
| Database | SQLite (WAL 模式) + Drizzle ORM + Repository Port | 事务、约束、RLS、递归 CTE、全文检索；禁止跨模块直接写表 |
| Retrieval | SQLite FTS5 + VectorSearchPort（`sqlite-vec`/内存适配） | 记录 embedding 模型/维度/版本，可离线重建；MVP 不引入 Neo4j/独立向量库 |
| Queue | Redis 7、BullMQ 5 | 至少一次投递、幂等键、重试、指数退避和 DLQ；Redis 不是真源 |
| Object | S3 兼容存储、短期签名 URL | 上传前后做大小/格式/解压比/病毒扫描；删除遵循数据 SLA |
| AI | Vercel AI SDK 6 + 内部 `ProviderPort` | SDK 负责流式表现层，业务通过内部接口调用模型；模型不能直写业务表 |
| Desktop/mobile | Electron（P1）、Capacitor（后续，打包 web UI） | `contextIsolation`、关闭 `nodeIntegration`、受限 IPC、签名更新包、逐项设备授权；移动端优先 WebView 壳，团队用 RN 仅当细粒化需要原生能力时评估 |
| Test/observability | Vitest、Playwright、Testing Library、Testcontainers、fast-check、OpenTelemetry、Pino、Prometheus/Grafana、Sentry | 正常 CI 不依赖实时供应商；日志默认不含完整用户内容 |

## 3. 仓库与领域边界

```text
apps/
  web/          # Vue 3 工作台（复用 desktop renderer 核心，见 ADR-015 / AVX-WEB-001）
  api/          # Fastify HTTP/SSE，按领域模块组织（见 §3.1）
  worker/       # 幂等后台任务和 DLQ
  desktop/      # P1 Electron 壳，复用 web/ui
  mobile/       # 后续 Capacitor 打包 web UI
packages/
  contracts/ identity-consent/ conversation/ learning/
  practice-review/ memory/ diary/ ai-runtime/ safety/
  content-ingestion/ integrations/ plugin-sdk/
  database/ observability/ ui/ domain/
```

### 3.1 apps/api 内部结构（演进式模块化单体）

`apps/api/src/` 采用**按领域模块组织**的结构，每个模块自管路由与仓储实例化，通过 `shared/event-bus.ts` 做进程内跨模块通信：

```text
apps/api/src/
├── modules/                        # 业务模块（每个自管 routes + 依赖注入）
│   ├── conversation/                #   对话模块：Session、Turn、Message、SSE 流式
│   │   ├── routes.ts
│   │   └── index.ts
│   ├── learning/                    #   学习模块：目标、题目、作答、知识点、复习
│   │   ├── routes.ts
│   │   └── index.ts
│   ├── diary/                       #   日记模块：日记查询、计划、窗口调度
│   │   ├── routes.ts
│   │   └── index.ts
│   ├── feedback/                    #   反馈模块：用户反馈记录与查询
│   │   ├── routes.ts
│   │   └── index.ts
│   ├── privacy/                     #   隐私模块：同意授权、撤回、删除请求
│   │   ├── routes.ts
│   │   └── index.ts
│   ├── analytics/                   #   埋点模块：伪匿名事件记录
│   │   ├── routes.ts
│   │   └── index.ts
│   ├── content/                     #   内容模块：附件元数据、引用
│   │   ├── routes.ts
│   │   └── index.ts
│   └── notification/                #   通知模块：通知列表查询
│       ├── routes.ts
│       └── index.ts
├── shared/                          # 跨模块共享（严格限制：只放通用工具）
│   ├── tenant.ts                    #   租户上下文解析（从请求 Header 提取 TenantContext）
│   ├── event-bus.ts                 #   进程内事件总线（pub/sub，未来可替换为消息队列）
│   └── errors.ts                    #   共享错误类型（NotFoundError、ValidationError 等）
├── app.ts                           #   Fastify 应用工厂：组装模块、注册路由
└── index.ts                         #   进程入口：创建 app、listen

apps/api/test/                       # 集成测试
  └── api-integration.test.ts
```

**核心约束**：

| 规则 | 说明 |
|---|---|
| 模块自管仓储 | 每个 `modules/*/index.ts` 内部实例化该模块的仓储，不引用全局容器 |
| 路由函数签名 | `routes.ts` 导出函数接收**该模块专属的仓储实例**，而非全局 `RepoContainer` |
| shared 严格受限 | `shared/` 只放跨 2 个以上模块的通用工具，禁止放业务逻辑 |
| 跨模块通信 | 仅限 `shared/event-bus.ts` 的 pub/sub + `shared/` 中的纯工具函数直接调用 |
| 单一数据库 | 仍是一个 SQLite/PostgreSQL 实例，通过表前缀做逻辑分区 |
| 对外入口唯一 | 每个模块只有 `index.ts` 对外可见，`routes.ts` 内部函数不被其他模块引用 |

**模块与仓储对应关系**：

| 模块 | 仓储（来自 `@aervox/database`） | 对应路由前缀 |
|---|---|---|
| conversation | `SqliteConversationRepository` | `/v1/sessions/*`, `/v1/turns/*`, `/v1/messages` |
| learning | `SqliteLearningRepository` | `/v1/learning/*`, `/v1/questions/*`, `/v1/review-items/*` |
| diary | `SqliteDiaryRepository` | `/v1/diaries/*` |
| feedback | `SqliteFeedbackRepository` | `/v1/feedback` |
| privacy | `SqlitePrivacyRepository` | `/v1/consent*`, `/v1/deletions` |
| analytics | `SqliteAnalyticsRepository` | `/v1/analytics/events` |
| content | `SqliteContentRepository` | `/v1/attachments/*` |
| notification | `SqlitePlatformRepository` | `/v1/notifications` |

**与 ADR-001 的关系**：本结构是 ADR-001（模块化单体）在 API 层的细化设计，由 ADR-014 记录完整决策。未来当某个模块满足拆分条件（团队边界、独立扩缩容、部署独立性）时，可将该模块的进程内 EventBus 调用替换为消息队列，仓储实例化替换为 HTTP/gRPC 客户端，业务逻辑代码零改动。

### 3.2 UI 共享包规划（packages/ui / api-client）

**现状（2026-08-25）——逻辑层与核心工作台已收敛为共享包，平台壳按端保留**：

| 层级 | 桌面端（Electron/Vue） | Web 工作台（Vue） | 复用形态 |
|---|---|---|---|
| 契约/协议 | `@aervox/contracts`、`@aervox/api` | 同一份 | ✅ 真共享（import 同一包） |
| 逻辑（transport + composables） | 注入 `desktopTransport`（preload IPC 适配，`@aervox/api-client`） | 默认 `fetchTransport`（浏览器 fetch/SSE，同包） | ✅ 真共享：两端各注入传输适配，composables（`useAervoxApi`/`useAervoxTurn`）收敛到 `@aervox/api-client`，本地副本已删除 |
| UI 组件/主题 | `AervoxWorkbench`（含桌宠区）+ `AppTitlebar` / `PetWindow` 等窗口壳 | 同一 `AervoxWorkbench`（`showCompanion=false`，不渲染桌宠）+ 浏览器顶栏 | ✅ 真共享：对话、学习、工具面板、主题和响应式布局来自 `@aervox/ui`；窗口壳与桌宠表现层仍按端适配 |

- 共享包清单：`@aervox/api-client`（transport 抽象 + Vue composables，源码出口）与 `@aervox/ui`（AervoxWorkbench / PetHero / MessageBubble / 主题 token，源码出口）均由两端直接消费源码。
- 渲染层差异收敛为同一对话、学习与设置工作台；设置窗口采用共享的左侧分类/右侧详情结构，偏好只存储在当前 renderer 设备；Electron 的标题栏、独立桌宠窗口和桌宠区属于平台壳能力，Web 不提供桌宠表现层。

**规划（ADR-014/015 演进式，仍有触发式上收）**：

- **创建时机**：当同一展示组件被 ≥2 个端（web / desktop / mobile）真实复用且实现开始分叉时，把两端实现收敛为 `packages/ui` 的共享组件 + 主题 token（以 desktop styles 为基础），例如对话消息渲染、学习卡片和工作台工具面板。
- **内容边界**：只放跨端复用且**无壳依赖**（Electron IPC / Capacitor）的展示组件与主题 token；页面壳、窗口控制、preload 桥接、平台通道逻辑一律留在各端。
- **允许端内差异**：Electron 多窗口桌宠与 Web 无桌宠表现层属于壳能力差异；桌面保留桌宠区域和 `pet.html`，Web 只承载共享工作台。
- **约束**：建包不改变 ADR-014/015 决策；若仅两端复用亦可在各自端内先收敛再提升，避免为假想需求建包。

领域模块：

- **Identity & Consent**：账户、工作区、角色、年龄组、同意和设备授权。
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
[Learner / Creator / Organization Member]
                  │ uses and controls personal data
                  v
             [Aervox System]
      ┌───────────┼──────────────┐
      v           v              v
[OIDC Identity] [AI Providers] [Notification Providers]
 authenticate   inference only  email/push by consent
      │           │              │
      └────── contractual privacy/security boundaries ──────┘

[External Content/Question Banks] <-> [Aervox Integrations]
[DSH/pi/MCP Plugins]               <-> [Permissioned Adapters]
```

用户和工作区数据的控制面始终在 Aervox；身份、模型、通知、外部题库和插件均为外部信任边界。任何外部方只能获得已批准 purpose/scope 的最小数据，且必须支持撤销、故障隔离和审计。

### 4.2 Containers

```text
Web / Electron / Mobile
          │ HTTPS/SSE
       CDN + WAF
          │
       Stateless API instances
        ├── SQLite (business truth + FTS5, WAL mode)
        ├── Redis/BullMQ (queue/cache)
        ├── S3 (attachments/exports)
        ├── RecoveryControlLedger (independent immutable control events)
        └── AI Provider Gateway

Scheduler ──> BullMQ ──> Worker pools
                         ├── memory
                         ├── diary
                         ├── embedding
                         ├── OCR/import
                         └── notification

All processes ──> OpenTelemetry Collector ──> metrics/logs/traces
```

用户消息、答题和权限变更先在 SQLite 事务中落库，同时写 Outbox；API 再流式请求模型。记忆、日记、附件、嵌入和通知异步执行。客户端不能直接调用模型服务；附件通过短期签名 URL 上传，API 在提交前检查授权和扫描状态。

### 4.3 关键组件与信任边界

| 容器 | 关键组件 | 可写数据 | 外部信任边界 |
|---|---|---|---|
| Web/Desktop/Mobile | UI、离线草稿、流式渲染、授权界面 | 本地最小草稿/设置 | 浏览器、OS 权限、Electron IPC |
| API | Auth/Consent、Conversation、Learning、Review、Context Builder、Provider Gateway | SQLite 领域表、Outbox；按 `(workspaceId, subjectUserId)` 做租户边界 | OIDC、AI Provider、对象签名服务 |
| Worker/Scheduler | Memory、Diary、OCR、Embedding、Notification、Deletion Orchestrator | 各领域模块公开仓储；不得绕过所有权；所有 Job 包含 `workspaceId/subjectUserId` | Redis、对象存储、通知供应商 |
| Plugin Host（P2） | Manifest、Policy Proxy、Adapter、Kill Switch | 插件自有状态；核心数据只经命令/候选 | 第三方代码和远程 Host |
| Recovery Control Ledger | 删除、Consent/Plugin/External Grant 撤销的最小控制事件、单调序列、防篡改证据 | 独立账号/凭据/保留策略的追加写存储；不含用户正文 | 与业务 SQLite 和其备份分离故障域 |
| Observability | trace/metrics/脱敏日志 | 运行元数据，不得成为用户内容副本 | 监控/错误平台供应商 |

主要威胁与架构控制：

| 威胁 | 控制 | 验证 |
|---|---|---|
| 跨工作区/组织数据泄露 | 应用鉴权 + TenantContext 仓储强校验、workspaceId 约束、伪匿名分析主体 | `TC-SEC-TENANT-001` |
| Prompt injection/恶意附件 | 不可信上下文分区、工具权限代理、扫描、引用验证 | `TC-SEC-PROMPT-001` |
| 插件远程代码执行/数据外泄 | 进程外沙箱、默认无权限、签名、Host allowlist、配额和 kill switch | `TC-SEC-PLUG-001` |
| 删除后数据复活 | `RecoveryControlLedger` 撤权先行、DeletionTargets、零召回验证、恢复前校验水位并按序重放 | `TC-PRIV-DEL-001`、`TC-RES-LEDGER-001` |
| 供应商保留/训练超出用途 | Provider metadata、合同/地区/保留审查、脱敏、可替换路由 | `TC-PRIV-PROVIDER-001` |
| Electron 主进程越权 | contextIsolation、禁用 nodeIntegration、schema 化 IPC、签名更新 | `TC-SEC-DESKTOP-001` |

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
Worker -> DB/Redis/FTS/Vector/S3/Diary/Memory/Suppliers: clear or rebuild
Worker -> Verification: zero-recall + target evidence
Verification -> DeletionRequest: Completed or Failed + alert
Restore process -> RecoveryControlLedger: verify signature/sequence/watermark + replay before serving traffic; fail closed on gaps
```

<a id="arch-consistency"></a>

## 5. 关键数据与一致性

- SQLite 事务是跨模块状态变更的边界；数据库迁移使用 expand/contract，API 保持当前及上一版本客户端兼容。
- 队列按至少一次投递设计。Job 必须有 `idempotencyKey`、最大尝试次数、可取消状态、DLQ 和人工重放工具。
- Memory 的 `MemoryRecord` 只保存临时/短期/长期身份和版本；系统记忆树由有效长期记忆构建可重建投影，避免两份永久真源。`MemoryProjectionOverride` 记录用户锁定、改名和父节点调整，重建时先投影再叠加覆盖。
- 日记使用 `Diary` + 不可变 `DiaryCycle` + `DiaryScheduleRevision` + `DiaryRunAttempt` + `DiaryVersion` + `DiaryParagraphSource`；每个段落带来源版本和生成时权限快照。`DiaryCycle` 以 `occurredAt` 计算窗口，`DiaryMaterialBuffer` 必须关联 `cycleId`；周期终态与 `lastCutoffAt/cursorVersion` 通过 scheduleVersion CAS 在同一事务提交，使用 lease/fencing token 拒绝过期 Worker。
- 删除、同意撤销和插件/外部授权撤权先以确定性 `controlEventId/idempotencyKey` 追加独立故障域的 `RecoveryControlLedger` 并取得 durable ack，再幂等提交 SQLite 的即时 deny 投影、`DeletionRequest`/Targets 和 Outbox；账本已写而业务提交失败由 reconciler 按 sequence 重放，账本不可用、序列有缺口或水位未追平时受影响范围 fail closed。业务投影不得反向覆盖账本事实；恢复后必须先校验并重放账本、验证零召回/零越权后再开放流量。
- 所有个人学习状态按 `(workspaceId, subjectUserId)` 隔离；运营者/组织成员作为 `actorId` 另记，不得代替数据主体。
- 用户查看历史消息的保留策略与 AI 召回 TTL 分离。临时记忆过期只代表不能进入模型上下文，不代表聊天历史必须被删除。

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

1. 临时层保留精确消息版本、答案、工具结果和上下文，数小时内可召回；原始会话历史是否保留由独立策略决定。
2. 临时转短期必须使用结构化 schema，至少保留目标、约束、尝试、错误、因果、时间和代表性例子；首次整理不得过度省略。
3. 短期转长期只能由可审计规则批准：客观学习事件可自动沉淀；用户事实、偏好和经历默认需显式确认；掌握度可算法推断但必须标记为推断；无来源推断不得写成用户事实。
4. 长期转系统记忆只生成稳定主题和关系的树状投影。树有唯一 canonical parent 且层级边无环；跨主题、因果和对比关系用独立有向边，不把“树”误作严格单父数据模型。
5. 去重、合并、纠错和冲突产生新版本，不物理覆盖证据。用户删除来源后立即禁止召回；没有其他有效证据的高层记忆失效并重建。

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

附件、网页、插件输出和外部题库都是不可信数据，不能覆盖系统提示或直接触发工具。模型只能请求工具，权限代理根据用户授权、工作区和工具策略作最终决定。插件默认无数据库、文件、网络、记忆和日记权限；云端插件在容器/microVM 中运行，桌面插件使用受限子进程，Node `vm` 不作为安全沙箱。

## 8. 日记调度与时区

- `DiarySchedule.nextRunAt` 和 `lastCutoffAt` 保存 UTC 时间点，另存 IANA 时区及首次启用的 `initialWindowStart`；Scheduler 每分钟批量锁定到期记录，不为每个用户注册长期 Cron。所有调度、通知和 Job 都必须携带 `(workspaceId, subjectUserId)`。
- `Diary` 的业务唯一约束为 `(workspaceId, subjectUserId, localDate)`（仅针对 `autoGenerated=true`），保证每个 `localDate` 标签最多一个自动日记身份；这不是本地 00:00～24:00 的素材分片。`DiaryCycle` 是窗口真源，`DiaryRunAttempt` 只表示执行尝试，旧任务必须先校验 `scheduleVersion`。缓冲只能按 `cycleId` 关联，不得以日期标签替代窗口身份。
- 生成前固化 `previousCutoffAt`、`sourceWindowStart`、`sourceWindowEnd`、`cutoffAt`、来源 ID/版本、`occurredAt/ingestedAt` 和权限快照；本次窗口为 `(previousCutoffAt, cutoffAt]`，首次运行为 `[initialWindowStart, cutoffAt]`。`localDate` 只是 `cutoffAt` 在时区快照下的本地日期标签，不要求窗口从本地零点开始。设置默认 30 分钟晚到宽限期：`bufferClosedAt = cutoffAt + 30m`。首版不等待宽限期结束，必须在设定时间后 15 分钟内发布；`bufferClosedAt` 前写入且 `occurredAt` 落在本次窗口的迟到事件只生成用户可见的补写候选，确认后创建新版本；关闭后到达的本窗口事件不自动改写或生成候选。只有 `occurredAt > cutoffAt` 的事件进入下一滚动周期；早于或等于窗口起点的历史迟到事件不得重复分配。滚动窗口素材缓冲不能因为临时记忆过期而丢失当前窗口内已授权素材。
- 修改时间或时区时，已锁定/已到期运行的 `cutoffAt` 不移动；新计划从上一次 `lastCutoffAt` 之后的第一个合格截止点生效，允许窗口变长或变短但不得重叠或产生空洞。停用结束当前 `scheduleEpochId`；重新启用创建新的周期并以启用时点作为 `initialWindowStart`，默认不回填停用期间素材。
- DST 缺口取下一个合法时点；重复时间只执行一次。撤销授权会取消未执行任务；保存成功后再发送通知。
- 日记验证失败不得发布；重试不得生成重复版本，失败进入可见状态和 DLQ。用户明确编辑或确认的内容才能产生记忆候选，不自动写入系统记忆。
- `DiaryScheduleRevision` 不可变；Scheduler 声明 `DiaryCycle` 后用 `scheduleVersion` CAS、lease 和单调 fencing token 进行领取。周期状态为 `Scheduled -> Claimed -> Generating -> Validating -> Published | Skipped | Failed | Cancelled`；只有 `Published` 或有原因/操作者/时间证据的 `Skipped` 能与 `lastCutoffAt/cursorVersion` 在同一 SQLite 事务提交，过期 Worker、`Failed` 和 `Cancelled` 不推进 cursor。空日记如已发布则属于 `Published`，只有用户或明确策略选择不生成才属于 `Skipped`。
- 来源必须区分 `occurredAt` 和 `ingestedAt`，周期归属只使用 `occurredAt`。只有 `occurredAt > cutoffAt` 的事件进入下一周期；`occurredAt <= previousCutoffAt`（首次为 `< initialWindowStart`）但后写入的来源标记为历史迟到，只能手动关联原周期或忽略。超过 `bufferClosedAt` 才写入的本周期来源不自动改写或生成候选。
- 失败跨过下一截止点或多日宕机时，Scheduler 按 `cutoffAt` 从旧到新建立独立周期并顺序恢复，不自动合并或静默跳过；超过已批准自动补写上限时转为待决定队列。quiet hours 只延迟/合并通知，不改变 cutoff、生成或 cursor。首次 `initialWindowStart` 为启用和授权持久化时点；同日标签已存在自动日记时，新 revision 顺延到下一个未占用标签。

<a id="arch-nfr"></a>

## 9. 非功能、容量与灾备

| 指标 | MVP 基线 | 成长期目标 |
|---|---:|---:|
| 核心 API 可用性 | 99.5%/月 | 99.9%/月 |
| 非 AI 读/写 P95 | 300/500 ms | 200/300 ms（需负载验证） |
| 模型 TTFT P95 | 8 s（从 Turn 接受至首个通过安全门且已持久化的可见 `delta`） | 5 s（按供应商和模型分层） |
| 日记首版按时发布 | 95% 在设定后 15 分钟内；不等待晚到宽限期 | 99% |
| 在线删除清除 | 24 小时内 | 24 小时内 |
| RPO/RTO | 每日加密备份；每季度恢复演练 | RPO ≤ 5 分钟，RTO ≤ 1 小时 |

MVP 容量模型为 10,000 注册用户、1,000 DAU、100 并发流式会话；上线前完成 2 倍峰值压测。告警覆盖 API 错误、TTFT、队列延迟/DLQ、日记迟到、来源验证失败、删除积压、AI 成本和安全分类异常。

### 9.1 成本与供应商降级

- G2 前由产品/技术/财务批准 `每有效学习会话成本`、`每活跃用户月成本 P50/P95` 和总月预算；当前数值为待定阻断项，不用缺乏依据的虚假精度填充。
- 预算达到 70% 触发预测告警，85% 停止非核心高成本任务（自动扩展阅读、批量重写等），100% 只保留已批准的核心模型/固定降级；不得通过降低安全分类或删除能力省钱。
- Provider 路由记录模型能力、地区、保留、成本、限流和健康状态。超时/5xx/限流达到熔断阈值后切换已评估备用模型；无合格备用时保留输入并显示可重试状态。
- Redis 丢失时以 SQLite Outbox/ScheduledJob 为真源重建队列；消费者使用幂等键和水位线，重放后执行重复结果检查，不从 Redis 反向恢复业务状态。

## 10. 参考项目适配边界

- `BaiShou-Next` 的 TypeScript monorepo、AI SDK、Drizzle、Electron/Expo、SQLite/Markdown 导出和日记/记忆设计用于模式验证；其 AGPLv3 代码不进入核心服务，除非完成许可证评审。
- `dsh-synapse` 的会话分支和“内容真源/画布投影分离”用于 P1 设计；画布只保存节点位置、折叠、锚点和真实 ID，不复制会话内容。
- `deepseek-harness`、`pi`、DSH、ACP/RPC 和 MCP 通过 `adapter-dsh`、`adapter-pi`、`adapter-mcp` 可选接入；版本精确锁定、契约测试和全局 kill switch 必须存在。
- 参考仓库不是运行时依赖。MVP 核心学习、记忆、日记、删除和导出流程必须在不安装这些仓库的情况下可用。

## 11. 首批 ADR

| ADR | 决策 |
|---|---|
| ADR-001 | 模块化单体 + Worker，而非 MVP 微服务 |
| ADR-002 | Superseded by ADR-015 — 原 React/Vite + Fastify + OpenAPI/SSE 的 Web 基线已改为 Vue 单栈 |
| ADR-003 | 仓储抽象架构：SQLite 业务真源与 FTS5/Vector Port |
| ADR-004 | 业务状态 + Outbox + 幂等队列，而非全系统 Event Sourcing |
| ADR-005 | 内部 Provider Port 包裹 AI SDK，模型和 Prompt 可替换 |
| ADR-006 | AI 召回期限与用户可见数据保留期限分离 |
| ADR-007 | 系统记忆树是长期记忆的可重建投影；跨主题使用独立边 |
| ADR-008 | Cloud-first；P2 通过 Repository/Sync Port 增加 SQLite/自托管 |
| ADR-009 | Electron 最小权限桌面壳；插件进程外运行 |
| ADR-010 | DSH/pi 仅为可选适配器，不拥有核心业务数据 |
| ADR-011 | 日记不可变周期、计划修订、cursor 连续性、迟到事件与 lease/fencing |
| ADR-012 | POST Turn + GET SSE、分段安全门、重连去重与部分响应持久化 |
| ADR-013 | 独立恢复控制账本与撤权先行 |
| ADR-014 | 演进式模块化单体：apps/api 按领域模块组织，自管仓储 + 进程内事件总线 |
| ADR-015 | Vue 全栈单栈：Web 复用桌面端技术族，替代 ADR-002 的 Web 基线 |

每个 ADR 需要记录上下文、备选方案、决策、后果、迁移和回滚。未批准的技术建议不能写成已承诺架构。

独立记录已建立在 `docs/reference/adr/ADR-###-slug.md`；上表是 canonical 索引，其他文档不得给同一个 `ADR-*` 赋予不同含义。当前状态均为 `Proposed`，不代表已经通过 G2 或取得技术负责人批准。

### 11.1 技术版本冻结规则

本文中的 Node 24 LTS、TypeScript 6.x、Vue/Vite/Fastify/Zod、PostgreSQL、AI SDK 等是目标基线（React 相关基线已随 ADR-015 更新为 Vue），不是尚未存在 `package.json`/lockfile 时的可构建证明。G2 前必须：

- 验证实际发布日期、LTS/支持周期、peer dependency、Node ABI、Electron 和参考适配器兼容；
- 在根 `package.json`、`packageManager`、`engines`、lockfile、容器 digest 和 CI matrix 中精确冻结版本；
- 生成 SBOM/许可证清单和升级 Owner；主版本升级建立 ADR/CR，小版本通过自动回归；
- 若目标版本不可用或不兼容，使用最近受支持稳定版并记录偏差，不为满足文档数字使用预发布依赖。

#### 实测偏差记录（2026-08-24 骨架）

- **TypeScript**：目标 6.x 尚无稳定版（6.0.0 为 beta，属预发布）；按本节规则采用最新稳定 **7.0.2** 并记录偏差。
- **Node**：目标 24 LTS；骨架在本机 **26.7.0** 验证，`engines` 设为 `>=22.19`（兼容参考仓库下限）；CI 目标仍为 24 LTS。
- **pnpm**：目标 11，实测 **11.22.0**（brew）对齐。
- **Turborepo**：目标 2.x，实测 **2.10.11** 对齐。
- 以上在 G2 前按本节清单复核 peer dependency / Node ABI 后冻结；后续主版本升级建立 ADR/CR。

## 12. 架构发布门禁

- C4、数据所有权、威胁模型、容量/成本、备份恢复和删除传播评审通过；
- OpenAPI/事件契约无破坏性差异，数据库迁移可回滚或有明确 expand/contract 阶段；
- 记忆、日记、附件、插件和外部同步均有幂等、撤销、权限和 DLQ 测试；
- 依赖、许可证、SBOM、Secret scan、漏洞扫描和参考项目许可边界通过；
- Playwright 覆盖学习闭环、日记、删除、导出和弱网恢复；AI 回归集覆盖教学、安全、来源、过度压缩和删除后零召回；
- 生产演练证明模型供应商中断、Redis 丢失、数据库备份恢复、对象恢复、队列重放和功能开关回滚可执行。
