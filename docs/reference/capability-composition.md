# Aervox 能力组合与可选化目录规范

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-29

> 文档编号：AVX-CAP-001  
> 类型：Reference  
> 版本：v0.4
> 更新日期：2026-08-29
> 状态：Review Candidate  
> 关联：[架构设计](ARCHITECTURE.md)、[ADR-001](adr/ADR-001-modular-monolith.md)、[ADR-004](adr/ADR-004-outbox-idempotent-jobs.md)、[ADR-005](adr/ADR-005-provider-port.md)、[ADR-009](adr/ADR-009-electron-plugin-sandbox.md)、[ADR-010](adr/ADR-010-dsh-pi-adapters.md)、[ADR-014](adr/ADR-014-modular-monolith-structure.md)、[能力注册表](capability-registry.md)、[submodule 协作指南](../how-to/submodule-collaboration.md)、[需求追踪基线](REQUIREMENTS_TRACEABILITY.md)

本文规定 Aervox 的能力组合模型、**必选交付与自选机制**、最终形态目录、Manifest、生命周期、依赖解析和外部运行时适配边界。它是能力组合与交付的当前执行基线：原"可选功能模块化方案"（AVX-MOD-001）已并入本文（见[交付载体与自选机制](#交付载体与自选机制必选)），其不变量、双轴自选、接口边界与边界判定提升为必选机制，功能清单迁至[能力注册表](capability-registry.md)。文中标为目标形态的目录、Manifest/Profile 与状态机，只有在对应代码、迁移和契约测试落地后才可视为运行能力，当前仓库照此渐进迁移（见[当前仓库迁移](#当前仓库迁移)）。

## 范围与非目标

本文覆盖所有用户可感知能力如何独立发现、安装、选择、替换和组合，以及 Aervox 原生能力、DSH（DeepSeek Harness）、pi 和 MCP 如何进入统一 Host。本文同时规定 `Manifest`、`Profile`、`Bundle`、`Overlay`、`Provider` 和 `Contribution` 的目录与接口边界，以及构建选择、运行时激活、撤权、卸载、回滚和删除传播的共同规则。

本文不覆盖具体 CAP 的产品验收条件、数据库表结构或外部项目的 API 承诺。产品范围以 [PRD](PRD.md) 和 [SRS](SRS.md) 为准，数据引擎以 [DATABASE.md](DATABASE.md) 为准；DSH/pi 只能经适配器接入。

## 核心结论

### 所有业务能力都可选

Conversation、Learning、Practice、Review、Memory、Diary、Identity、Notification、Tools 等业务能力一律由 Profile 选择，不存在不可替换的业务 `core` 目录。某个 Profile 可以省略任一业务能力，也可以为同一个 Definition 选择不同 Provider。

“所有能力可选”不表示安全与数据权利可以被关闭。以下 `Kernel Substrate` 不是业务能力包，而是 Host 对所有组合强制施加的不变量：

| Kernel Substrate | 不可绕过的责任 |
|---|---|
| Composition/Lifecycle | 解析、激活、停用、资源回收和状态机 |
| Contract/Protocol | Manifest、Port、事件版本和输入输出校验 |
| Policy/Consent | 身份上下文、租户、权限、同意、撤销和最小权限 |
| Data Rights | 数据所有权、保留、导出、更正和删除传播 |
| Outbox/Audit | 事务事件、幂等投递、审计和可追溯性 |
| Sandbox/Revocation | 外部代码隔离、超时、配额、杀停和撤权 |
| Observability/Recovery | 健康状态、告警、回滚、恢复和证据 |

Profile 可以没有用户能力，但不能关闭 Kernel Substrate。任何外部代码、模型或持久化能力如果无法满足 Policy、Consent、Deletion 和 Audit，Resolver 必须拒绝激活。

### 能力与代码载体分离

| 概念 | 准确定义 |
|---|---|
| `Capability` | 用户或系统可选择的语义能力，例如对话、复习、会话地图 |
| `Definition` | 能力稳定的 Port、事件、错误和数据语义 |
| `Provider` | 对某个 Definition 的实现，例如 SQLite Memory、远程 LLM |
| `Consumer` | 调用或展示 Definition 的能力、API、Worker 或 Shell |
| `Plugin/Extension` | 向 Host 注册 Provider、Consumer 或 Contribution 的代码载体 |
| `Adapter` | 把外部运行时翻译为 Aervox Contract 的边界 |
| `Host` | 执行生命周期、权限、隔离和调用调度的进程 |
| `Contribution` | Tool、Provider、Event Listener、Command、UI Slot 等受限贡献 |
| `Manifest` | 身份、版本、依赖、权限、数据和入口的机器可读声明 |
| `Bundle` | 可一起分发的一组能力、Provider 和适配器 |
| `Profile` | 一套可运行的能力选择和 Provider 绑定 |
| `Overlay` | 对 Profile/Bundle 的环境、租户或用户级覆盖 |

`modules/*`、npm、git submodule、DSH Bundle 和 pi Package 都只是代码来源或分发载体，不是能力语义本身。

## 交付载体与自选机制（必选）

能力语义（Definition/Provider/Profile）与代码载体分离，见上文；本节约束标准产品中每个能力**如何交付与自选**。原"可选功能模块化方案"（AVX-MOD-001）已并入本节：机制部分提升为必选执行，功能清单迁至[能力注册表](capability-registry.md)，落地步骤见[submodule 协作指南](../how-to/submodule-collaboration.md)。

### 模块化交付不变量

以下不变量是强制约定，违反任一即需先停止并走 `CR-*`：

1. **核心承诺不因自选关闭**。P0（CAP-001~013）是学习/陪伴闭环的必要能力，始终进入标准 Profile 与默认构建产物（Profile 可按环境裁剪，但标准形态必须包含）；自选只影响非核心体验与扩展，不改变安全、隐私、删除与导出承诺。
2. **独立演进的功能必须子仓库开发**。任何被判定纳入自选机制的非核心功能，其代码必须位于独立 git 仓库并经 git submodule 挂入 `modules/*` 后消费；禁止在主仓 `packages/` 内维护"可选却同仓开发"的平行实现。
3. **消费一律走 workspace 包**。`modules/<name>` 在 pnpm workspace 中成为 `@aervox/mod-<name>` 包，主 app 通过 `workspace:^` 依赖，不通过路径 hack 或复制代码引用。
4. **接口单一事实源不分裂**。模块接口只输出一个事实源：OpenAPI / 事件 schema（走 `packages/contracts` 或模块自带 schema，二选一并登记），或 TypeScript 类型 + 契约文档；不得为同一功能在模块与主仓维护两套互相漂移的接口定义。
5. **默认不启用**。未被显式纳入默认构建集的能力不进入默认产物；启用才产生依赖与运行时成本。

### 两轮自选（构建 + 运行时）

自选在两个粒度上分开控制，可同时存在（双机制）；每个纳入自选的能力必须至少落入其一，并声明于[能力注册表](capability-registry.md)。

#### A. 构建时自选（发布/打包时决定默认集）

- 主仓通过 workspace 依赖与构建配置决定"默认打包哪些能力"；
- 未在默认列表的能力不进入产物，减少体积与攻击面；
- 用于：桌面端（CAP-018）、Live2D / 桌宠皮肤、本地优先（CAP-027）等在发布边界上更自然的候选。

#### B. 运行时自选（端用户在设置里开关）

- 已打包进产物的能力在运行时按用户配置启用/停用；
- 运行时开关只影响"功能是否可被触发"，不影响已存在数据、安全与删除边界；
- 用于：插件系统（CAP-020）、第三方接入、知识库/收藏项等以"安装/授权/开关"为交互形态的候选。

CAP-033「全域感知与个人画像（主动智能模式）」采用双机制：构建时提供受信桌面 Privacy Host/OS Broker 载体，运行时由用户确认版本化来源、后台和动作 grant 后激活。其本地私密存储、撤权、导出和删除责任属于 Kernel Substrate 的强制边界，不能被自选开关关闭。

CAP-034/035 采用运行时连接机制：构建产物包含本地连接网关和工具定义，用户在 CAP-033 active 后分别配置 HA 或健康 Provider。连接开关可以停止同步和工具，但不能关闭凭据删除、审计、租户隔离和数据权利责任。

> 二者关系：构建时决定**能力是否存在**，运行时决定**对当前用户是否可用**。

### 版本锁定与升级

- 每个 `modules/*` 子模块固定 commit / tag；升级需走 `CR-*` 并记录变更原因、依赖画廊（peer 版本）与回归结果（对齐 [PRD 15.1](PRD.md#prd-reference-manifest) 参考仓库规则）。
- 主仓记录各模块的"已批准版本"，作为构建清单事实源；升级前在 CI 中跑模块自身测试 + 主仓集成测试（见 [submodule 协作指南](../how-to/submodule-collaboration.md)）。

### 接口边界

- 能力模块不得拥有 Aervox 核心业务数据的直接写入权；需要读写学习/记忆/日记时，只能使用主仓暴露的受限接口或提交"候选"，由主仓领域规则决定最终落库（对齐 PRD 14.3 的 dsh/pi/MCP 接线约束）。
- 模块输出的数据生命周期（召回、保留、删除、导出）仍服从主仓 `DATA_PRIVACY`，模块不得自建独立的删除/同意旁路。

### 核心与可选的边界判定

判定一个功能"是否纳入自选机制"用以下四条正向条件，**全部满足**才可纳入：

1. **不构成闭环必要条件**：移除后核心"目标→引导→练习→复习→记忆"闭环仍完整成立；
2. **存在清晰接口边界**：可用适配器/包级接口与主仓隔离，不依赖修改核心领域实体代码；
3. **启用/停用可撤销且无数据破坏**：开关不破坏已保存数据，可回滚；
4. **独立版本化有意义**：该能力可单独演进、单独发布或单独授权。

**反向检查（防误伤）**：尽管某些期望/表现可被伪装成"可选"（例如桌宠形象 CAP-001 的表现层、NFR 的无障碍/性能），凡是承担学习闭环、安全、隐私、删除/导出或学习事实真源的功能，**一律保留主仓**，不因"看起来像皮肤"而纳入自选。

> 决策边界：把某个 P0 判定为"可选"（即使表现层）属不可逆架构决策，必须新增 ADR；P1/P2/P3 纳入自选机制不改变其增长路线，只改变其交付载体。

### 风险与替代方案

| 风险 | 缓解 |
|---|---|
| **git submodule 用于运行时功能被普遍视为反模式** | 本机制把 submodule 仅作为"开发代码来源 + 版本锁定"，消费一律走 pnpm workspace 包；运行时开关由主仓构建/配置表驱动，不在运行时动态拉取 submodule |
| 子模块未初始化 / commit 漂移导致构建假绿或失败 | CI 显式校验 `modules/*` 初始化与 pin；未 pin 视为失败 |
| 能力模块私自读写核心数据 | [接口边界](#接口边界)强制受限接口/候选制，字段级来源约束 |
| "可选"被滥用为绕过 P0 责任 | [边界判定](#核心与可选的边界判定)反向检查把安全/闭环/隐私规定为核心不选，误判需新 ADR |
| 生态与插件系统（CAP-020）与自选机制演化重叠 | 本机制提供**构建时**载体（`@aervox/mod-*`），CAP-020 提供**运行时**插件运行与沙箱；两者未来可统一到插件宿主，本文保留该演进路径 |
| 与 `reference/` 只读参考混淆 | `reference/` 不消费、不运行；`modules/` 是会被 workspace 消费的交付载体。参考项要转功能时先按许可证评估（对齐 PRD 15.1），再另建独立 `modules/*` 仓库，不把 reference 直接提升为模块 |

## 目标依赖模型

```text
Profile / Overlay
        │ selects
        ▼
Resolver ── verifies ── Manifest / Lock / License / Signature
        │
        ▼
Capability Host ── mounts ── Capability / Provider / Adapter
        │                         │
        └──── CapabilityContext ──┘
                    │
                    ▼
Policy + Data Rights + Outbox + Audit + Sandbox
```

依赖方向固定为：

```text
Consumer -> Definition/Port <- Provider
Adapter -> External Runtime + Aervox Contract
Host -> Provider selection + lifecycle
```

能力和 Consumer 不得导入 `Drizzle` schema、`@libsql/client`、具体 SQLite 类或外部运行时内部类型。只有 Host 的组合根可以选择 Provider；跨能力写入只能调用公开 Command Port、提交候选或发布 typed event。

## 最终形态目录

```text
apps/
  api/                         # HTTP/SSE Shell 与 composition root
  worker/                      # Job Shell；调度、租约、重试、DLQ
  web/                         # Web Shell；只消费 UI/Client Contribution
  desktop/                     # Electron Shell；Typed IPC 与设备授权
  mobile/                      # Capacitor Shell

packages/
  capability-kernel/           # Context、Lifecycle、Policy、Data Rights 接口
  capability-contracts/        # Manifest、Profile、Contribution、Event Envelope
  capability-sdk/              # 能力作者 SDK；不依赖数据库或具体 Host
  host-api/                    # Fastify Host 与 API Contribution registry
  host-worker/                 # Job registry、lease、retry、DLQ、shutdown
  host-web/                    # Web slots、client module registry
  host-desktop/                # IPC、窗口、设备和外部 Host bridge
  api-client/                  # 跨端 transport 与 composables
  ui/                          # 无 Shell 依赖的共享展示组件
  observability/               # 日志、指标、Trace、审计 exporter
  database/                    # 迁移期 facade；schema 只供 Provider 内部使用
  contracts/                   # 迁移期兼容出口

capabilities/
  identity/
  conversation/
  learning/
  practice/
  review/
  memory/
  diary/
  knowledge/
  branch-view/
  safety-response/
  content/
  notification/
  analytics/
  tools/
  plugins/
  skills/
  pet-presentation/

providers/
  identity/{anonymous,oidc}/
  conversation/{sqlite,remote}/
  memory/{sqlite,postgres}/
  llm/{internal,deepseek,replay}/
  embedding/{local,remote}/
  notification/{in-app,system}/

adapters/
  dsh/{adapter-dsh,loader,profiles,bundles}/
  pi/{adapter-pi,loader,packages}/
  mcp/adapter-mcp/
  dsh-synapse/adapter-view/

profiles/
  empty/                        # 仅 Kernel 与管理/恢复入口
  learning/
  desktop/
  dsh-lab/
  pi-lab/
  local/
  full/
  overlays/{dev,ci,tenant.example}.yaml

registry/
  manifests/
  locks/
  signatures/
  licenses/
  migrations/

modules/                       # 独立演进能力的 submodule 交付载体（必选机制）
reference/                     # 固定 commit 的只读参考
```

### 目录所有权

| 目录 | 可以包含 | 禁止包含 |
|---|---|---|
| `capabilities/*` | Definition、Application、Consumer、Manifest | 具体数据库连接、Shell API、外部运行时类型 |
| `providers/*` | Definition 的实现 | HTTP 路由、UI、其他领域业务编排 |
| `adapters/*` | 外部协议翻译、进程管理、Contribution 映射 | 核心数据表直写、产品业务真源 |
| `packages/host-*` | 组合根、生命周期、registry、调用调度 | 具体能力规则 |
| `profiles/*` | 选择、绑定、Overlay 和 lock 输入 | TypeScript 业务实现 |
| `registry/*` | 来源、版本、许可和完整性证据 | 未固定版本的可执行代码 |

### 单个能力与 Provider

```text
capabilities/tools-memory-store/
  capability.yaml
  package.json
  src/
    definition.ts
    application.ts
    consumers/{api,worker}.ts
    activate.ts
  migrations/
  tests/{contract,lifecycle,security}.test.ts

providers/memory/sqlite/
  provider.yaml
  package.json
  src/{adapter,activate}.ts
  tests/port-contract.test.ts
```

如果 Definition、Provider 和 Consumer 始终一起演进，可以在早期放在一个 workspace 包中，但目录和 import 仍须分层；出现第二个 Provider、第二个 Consumer 或独立发布需求时必须物理拆分。

## Manifest 与 Profile

### Capability Manifest

`capability.yaml` 是 Aervox 事实源。外部 Manifest 只作为 `sourceMetadata`，不能替代此 schema。

```yaml
apiVersion: aervox.dev/v1
kind: CapabilityManifest
metadata:
  id: aervox.tools.memory-store
  version: 0.1.0
  displayName: Memory Store
  source: native                 # native | dsh | pi | mcp
  sourceRef: workspace:capabilities/tools-memory-store
  license: MIT
spec:
  roles: [definition, consumer]
  provides: [tool.aervox.memory.store]
  requires: [aervox.memory.command, aervox.policy.approval]
  conflicts: []
  defaultActivation: disabled
  platforms: [api, worker, desktop]
  permissions:
    - id: memory.candidate.write
      mode: candidate_only
      scope: workspace
  data:
    owner: aervox.memory
    reads: [SessionExcerpt]
    writes: [MemoryCandidate]
    retention: inherited
    deletion: delegated
  events:
    subscribes: [turn.completed]
    publishes: [memory.candidate.created]
  entrypoints:
    host: process
    activate: ./dist/activate.js
  compatibility:
    kernel: ">=0.1.0 <1.0.0"
    contracts: "^0.1.0"
  integrity:
    checksum: sha256:<digest>
    signature: optional
```

Provider 使用相同的身份、兼容和完整性字段，并声明它实现的 Definition、优先级、隔离级别和迁移能力。只有 Kernel Substrate 不进入能力选择列表。

### Profile

```yaml
apiVersion: aervox.dev/v1
kind: CapabilityProfile
metadata:
  id: dsh-lab
  version: 0.1.0
spec:
  capabilities:
    - aervox.identity
    - aervox.conversation
    - aervox.learning
    - aervox.memory
    - aervox.tools
  providers:
    aervox.identity: aervox.provider.identity.anonymous
    aervox.conversation.store: aervox.provider.conversation.sqlite
    aervox.memory.command: aervox.provider.memory.sqlite
    aervox.llm: aervox.provider.llm.internal
  adapters: [dsh.readonly-tools]
  activation:
    dsh.readonly-tools: enabled
  overlays: [dev]
```

Profile 合并顺序固定为：Kernel Substrate → Capability Bundles → Provider Bindings → Host/Shell Bindings → User/Tenant Overlay。构建时选择决定代码是否进入产物；运行时选择决定已安装能力是否激活，两者必须分别记录。

## 依赖解析与生命周期

Resolver 必须：

1. 校验 Manifest schema、版本范围、来源 ref、checksum、许可证和签名/撤销状态；
2. 为每个 `requires` 解析唯一且兼容的 Provider；缺 Provider、冲突 Provider 或超权限必须显式失败；
3. 校验 `conflicts`、平台、信任域、数据 Owner 和迁移兼容性；
4. 按依赖图拓扑排序，文件顺序不能代替依赖声明；
5. 输出 `profile.lock`，记录版本、SHA、checksum、许可证、权限交集和 activation plan。

单个能力 activation 失败可以进入 `degraded`，但 Kernel Substrate 失败必须中止启动。Resolver 不能静默跳过缺失能力。

```text
discovered -> verified -> resolved -> installed -> enabled
  -> activating -> ready -> degraded | disabled | revoked
  -> uninstalling -> removed
```

所有注册、监听器、Provider、定时器、子进程和临时资源都必须绑定到能力实例，并在停用时逆序释放。`disable` 保留数据；`revoke` 立即阻断访问并触发控制事件；`uninstall` 必须先完成导出、迁移或删除；重复 disposer 必须幂等。

## DSH（DeepSeek Harness）适配

本文中的 `DSH` 专指 `reference/deepseek-harness`，固定参考 commit 为 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，许可证为 MIT。

| DSH 概念 | Aervox 映射 | 约束 |
|---|---|---|
| Cordis `apply(ctx)` / `inject` | Provider/Consumer activation | Cordis Context 不穿过 Adapter |
| Cordis service key | Definition ID | 登记 Aervox 版本和语义 |
| Cordis typed event | Aervox typed event / Outbox | schema、租户和权限校验 |
| `ctx.effect()` / disposer | Capability disposer | 停用必须可逆 |
| `package.json.dsh.bundle/profile` | Bundle source metadata | 不是 Aervox 事实源 |
| `cordis.patch.yml` | Overlay 输入 | 只在 `adapter-dsh` 解析 |
| `disabled` / `isolate` | Activation/trust scope | 不得绕过 Aervox Policy |

DSH agent loop、Session log、工具执行和权限系统不能直接替代 Aervox 的 Session、Message、学习事实或删除传播。外部 DSH 插件只获得受限 Context，写记忆只能提交候选。

## pi 适配

pi 固定参考 commit 为 `c49906ec77788625aacbdc53ebca6fbe65bd20f5`，许可证为 MIT。pi Extension 默认拥有宿主系统权限，因此不能在 API、Worker、Electron Renderer 或 Node.js `vm` 中直接加载；必须使用进程外 Host、Project Trust、Permission Broker、配额、超时和 kill switch。

| pi 概念 | Aervox 映射 | 约束 |
|---|---|---|
| `ExtensionAPI` factory | Plugin activation | 只获得受限 Bridge |
| `registerTool()` | Tool Contribution | 参数重新校验，调用经过 Policy |
| `on()` | Event Contribution | 转成版本化 typed event |
| `registerProvider()` | Provider Contribution | 只能实现声明的 Definition |
| `registerCommand()` / UI | Command/UI Slot | 不能直接修改业务真源 |
| `appendEntry()` | Extension-owned data | 声明保留、导出和删除 |
| `package.json.pi` | Bundle resource metadata | 只允许白名单资源类型 |
| npm/git/local + scope | Source Locator + Trust Scope | 固定版本或 commit |
| `pi config` | Activation Overlay | 不能替代 Aervox 撤权 |

## dsh-synapse 边界

`dsh-synapse` 是 DSH 的独立 Web 视图插件，不是 DSH 本体。它只能作为视图投影能力：Session、Message、权限和删除仍由 Aervox/DSH Host 拥有；视图只保存节点位置、分支锚点、折叠和布局等可重建元数据，不能把画布数据作为第二套会话真源。

## 数据、安全与运维

| 数据 | Owner | 外部能力允许动作 |
|---|---|---|
| Session/Message/Turn | Conversation | 受限 Command 或候选事件 |
| Learning/Attempt/Review | 对应学习能力 | 提交候选，不能改最终掌握事实 |
| MemoryRecord/Revision | Memory | 提交 `MemoryCandidate` |
| Diary/Version | Diary | 提交授权素材或生成候选 |
| Consent/Deletion/Audit | Kernel Data Rights | 只允许 Host 受控操作 |
| View metadata | 对应 View Capability | 可重建、可导出、不可覆盖真源 |
| CAP-033 Profile/Action/Source | CAP-033 Privacy Host | 只在用户确认的 grant/revision、OS 能力和本地处理边界交集内观察、提炼和动作；原始副本七天且提炼后清理 |
| CAP-034/035 Connection/Entity/HealthSample | CAP-033 本地连接网关 | 只暴露脱敏连接状态、授权实体和规范化每日指标；凭据不进入 Contribution，撤销连接删除凭据与对应缓存 |

外部能力的有效权限是 Manifest 声明、用户/租户授权和当前 Policy 的交集。模型请求、插件声明或外部运行时自报的租户字段不能产生授权。删除必须传播到摘要、索引、缓存、视图投影和外部副本，不能只删除安装记录。

## 当前仓库迁移

| 阶段 | 当前落点 | 目标动作 |
|---|---|---|
| A | `packages/contracts`、`apps/api/src/shared` | 冻结 Manifest、Port、Event Envelope 和依赖规则 |
| B | `apps/api/src/modules/*` | 路由改为 Application Service + Port Consumer |
| C | `apps/worker/src/*.ts` | cycle 改为可注册 Job Handler |
| D | `packages/database/src/repositories/sqlite` | 具体实现迁移到 `providers/*` |
| E | `apps/api/src/modules/tools/plugins/skills` | 注册为原生 Capability |
| F | 尚无正式 Adapter | 接入 DSH、pi、MCP 外部 Host |
| G | `apps/api/src/app.ts` 手工清单 | Profile + Resolver 驱动组合 |

迁移使用兼容 facade 和 Expand/Contract。旧 HTTP 路由、表和 `@aervox/database` 出口只有在新能力通过契约、生命周期和删除测试后才移除。

## 验收与机器验证

- `empty` Profile 只启动 Kernel、管理、导出、删除和恢复入口；
- `learning`、`desktop`、`dsh-lab`、`pi-lab` 和 `full` Profile 能生成稳定 lock；
- API/Worker 业务代码不导入 schema、`Drizzle`、`@libsql/client` 或具体 SQLite 类；
- 缺依赖、冲突、许可证、完整性或权限失败均显式报告；
- 激活、停用、撤权、卸载和 disposer 有幂等测试；
- 无 DSH/pi 时，选择原生 Provider 的 Profile 仍能运行；
- DSH/pi 来源、SHA、checksum、许可证、权限和回滚证据进入 `registry/`；
- 外部插件不能直接写核心数据库，删除后零召回测试通过；
- 同一 Profile + lock 解析出相同 activation plan。

目标实现应建立 `manifest-schema.test`、`capability-graph.test`、`lifecycle.test`、`port-contract.test`、`plugin-security.test`、`deletion-zero-recall.test` 和 `profile-reproducibility.test`。代码门禁使用 `mise tasks run ci-code`，文档门禁使用 `mise tasks run ci-docs`。

## 决策关系与变更

- `ADR-009` 对本规范构成安全约束：其进程外隔离、默认无权、签名、配额、超时、撤销和 kill switch 从 Electron 场景扩展到所有外部 Host。
- `ADR-010` 由本规范扩展：继续保持 DSH/pi 是可选 Adapter、Aervox 数据为唯一真源，并补充统一 Manifest/Profile/Contribution。
- `ADR-014` 是迁移期结构：`apps/api/src/modules/*` 可以继续作为起点，但最终由组合根选择 Provider，能力不能自行实例化具体 SQLite 类。
- `AVX-MOD-001`（可选功能模块化方案）已并入本文（见[交付载体与自选机制](#交付载体与自选机制必选)）：不变量、双轴自选、接口边界与边界判定提升为必选机制，功能清单迁至[能力注册表](capability-registry.md)，落地步骤见 [submodule 协作指南](../how-to/submodule-collaboration.md)；原 `docs/explanation/optional_modules.md` 已删除。

接受该目标前必须建立 `ADR-016`（或等效决策）并完成相关 `CR-*`。字段、目录、Kernel 范围、外部代码信任域或数据所有权的改变都必须保留迁移、回滚和追踪证据。
