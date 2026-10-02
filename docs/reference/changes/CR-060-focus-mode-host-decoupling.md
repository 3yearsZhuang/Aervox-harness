---
id: CR-060
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: proposed
delivery_status: planned
version: 0.4.0
updated_at: 2026-10-03
reviewed_at: 2026-10-03
review_interval_days: 30
review_triggers:
  - plugins/**
  - packages/host-plugin-api/**
  - packages/ui/src/plugins/**
  - packages/ui/src/composables/workbench-context.ts
  - packages/ui/src/registry/**
  - packages/core/src/index.ts
  - packages/core/src/ports.ts
  - apps/api/src/modules/ecosystem/plugins/**
  - apps/api/src/app.ts
  - apps/api/src/plugin-assembly.ts
  - scripts/check-host-domain-purity.mjs
  - scripts/check-removable-implementation.mjs
sources:
  - docs/reference/PRD.md
  - docs/reference/ARCHITECTURE.md
  - docs/reference/capability-composition.md
  - docs/reference/plugin-config-and-pages.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/reference/adr/ADR-014-modular-monolith-structure.md
  - docs/reference/adr/ADR-016-base-boundaries.md
  - docs/reference/adr/ADR-021-aervox-core-standalone-package.md
---

# CR-060 专注模式宿主去领域化与插件实现内聚

- 提出人：3yearszhuang · 2026-10-03
- 修改人：3yearszhuang · 2026-10-03

关联：[PRD](../PRD.md) · [架构设计](../ARCHITECTURE.md) · [能力组合规范](../capability-composition.md) · [插件开发规范](../plugin-config-and-pages.md) · [需求追踪基线](../REQUIREMENTS_TRACEABILITY.md) · [CR 工作流指南](../../how-to/cr-workflow.md)

- 状态：Proposed / Planned（切片 S1～S6 已落地于 `feat/iter-026-focus-mode-decoupling`，宿主领域纯净性棘轮豁免已清零；剩可移除目标/移除演练与文档闭环）
- 代码核验基线：`169720c`（2026-10-03 `origin/main`，含 PR #243/#244）；实施分支：`feat/iter-026-focus-mode-decoupling`。
- 关联能力：主能力 `CAP-002`；协同 `CAP-007`、`CAP-016`（均为本插件 Manifest 声明范围）；不改变 `CAP-003/004/006` 的交付载体与状态。
- 目标迭代：`ITER-026`（伴学业务与会话执行器深度解耦插件化）。该条目此前仅存在于 [plan.md §1](../../../plan.md) 变更说明、未进入唯一活动队列，本提案一并补录。
- 决策边界：**本提案不把学习闭环转为可选模块**。按[能力组合 · 边界判定](../capability-composition.md#核心与可选的边界判定)反向检查，承担学习闭环与学习事实真源的功能一律保留主仓；按[模块化交付不变量](../capability-composition.md#模块化交付不变量)第 1 条，`CAP-001~013` 始终进入标准 Profile 与默认构建产物。`plugins/` 属主仓目录，故本提案满足「保留主仓」，不触发新增 ADR。

## 1. 变更原因与现状证据

「专注模式」当前是**声明与实现分离**的形态：`plugins/focus-mode/` 只有 `plugin.manifest.json`、`config.schema.json`、`SKILL.md` 三个声明文件（零代码，可核验），而 `CAP-002/007/016` 的实现散落在宿主层。审计（2026-10-03，`169720c` 非测试源码全量核验）确认 **43 个宿主文件**携带专注模式领域知识，其中 31 个显式含 `focus`/`study`/`quiz` 字样。

该形态不满足[插件开发规范 §4.2](../plugin-config-and-pages.md#42-提示词动态插槽机制dynamic-extra-sections)自身提出的约束「禁止向通用 Base Prompt 增加插件业务分支」，也不满足[能力组合 · 目录所有权](../capability-composition.md#目录所有权)对 `packages/host-*`「禁止包含具体能力规则」的要求。

| 当前证据 | 已有基础 | 待补差量 |
|---|---|---|
| [turn-plugins/types.ts:26-29](../../../apps/api/src/modules/ecosystem/plugins/turn-plugins/types.ts#L26-L29) | 通用 Hook 契约支持 `extraSections` 提示词插槽 | 契约内另有 `allowQuizTrigger`/`quizMode` 两个刷题私有标识；全仓非测试代码**无任何消费者**，属失效协议 |
| `apps/api/src/modules/ecosystem/plugins/turn-plugins/focus-mode.ts:246-322`（已于 `c68e3a8` 迁出） | 回合插件实现前置提示词注入与后置术语抽取 | 实现位于宿主 `ecosystem/plugins` 模块，且带 `study-mode`/`quiz-mode` 历史别名 |
| [ecosystem/plugins/index.ts:7,43](../../../apps/api/src/modules/ecosystem/plugins/index.ts#L43) | 组合根显式注册 Hook（符合规范 §4.1） | 组合根硬 import 具体插件文件；`plugins/` 下另外 6 个内置插件均为纯声明式，唯此一个有编译代码 |
| [core/src/index.ts:22,27](../../../packages/core/src/index.ts#L22-L27) | `@aervox/core` 为最小发行内核（[ADR-021](../adr/ADR-021-aervox-core-standalone-package.md)） | 内核公共出口导出专注模式提示词与 `CAP-016` 刷题落库工具；`QUIZ_MODE_SYSTEM_PROMPT` 无生产消费者 |
| [core/src/ports.ts:337-368](../../../packages/core/src/ports.ts#L337-L368) | 内核端口层为纯类型、零运行时依赖 | `PracticeAttemptPort` 三型（`CAP-016` 刷题落库）位于内核 |
| `apps/api/src/modules/learning/terms/routes.ts`（已于 `c68e3a8`/本切片迁出） | `CAP-007` 概念探索具备独立路由 | 整个模块位于宿主，文件头自述「仅在专注模式 / 学习上下文中被激活调用」，内容为硬编码模板文案 |
| [agent-executor.ts:386-389](../../../apps/api/src/modules/companion/conversation/agent-executor.ts#L386-L389) | 工具贡献走 Provider 组合 | `record_practice_attempt` 只看端口是否存在，**无插件启用门控**；禁用插件后模型仍持有该工具 |
| `apps/api/src/modules/companion/conversation/practice-attempt-port.ts:42`（已于本切片迁出） | 作答落库经端口委托宿主 | 落库证据硬编码 `source: "quiz-mode"` |
| [core/src/base-prompt.ts:75-83](../../../packages/core/src/base-prompt.ts#L75-L83) | 基础系统提示词已提供 `customGuidance?: ToolGuidance[]` 通用注入位 | 通用基础提示词内硬编码 `record_practice_attempt` 的 `whenToUse`/`whenNotToUse`/`constraints` 产品域工具指南 |
| [stream-projection.ts:22,35-36](../../../packages/contracts/src/stream-projection.ts#L22-L36) | 投影白名单按事件类型泛化校验 | 核心投影函数特判 `tool.name === "record_practice_attempt"` 并内联 `practiceResultSchema`，为单个插件工具开后门 |
| [useWorkbenchLayout.ts:78-79,186-205](../../../packages/ui/src/composables/useWorkbenchLayout.ts#L78-L205) | 工作台宿主提供通用 layout/composer/conversation 组合式函数 | 插件域状态 `focusModeEnabled` 长在通用 layout 组合式函数内，含插件专属活动事件名与**插件 DOM class** `.floating-study-switch-wrap` |
| [useWorkbenchCards.ts:625-634](../../../packages/ui/src/composables/useWorkbenchCards.ts#L625-L634) | 卡片目录由核心卡片与 `registry.getCards()` 合并 | 核心组合式函数硬编码插件贡献的卡片 id：`cardSlots.value = ['study', 'timer']` |
| [AervoxWorkbench.vue:243-245](../../../packages/ui/src/components/AervoxWorkbench.vue#L243-L245) | Turn 协议的 `metadata` 为开放结构 `z.record(z.string(), z.unknown())` | 宿主壳体直接产出插件私有语义 `{ mode: 'focus', intent: 'quiz' }` |
| [plugin-runtime.ts:68,73-74,110-111,127-131](../../../packages/ui/src/plugins/plugin-runtime.ts#L68-L74) | 插件运行时按 id 泛化同步启用状态 | 宿主加载器硬编码 `focus-mode ↔ study-mode` 别名映射、配置回退与双向可用性回退 |
| [workbench-context.ts:26](../../../packages/ui/src/composables/workbench-context.ts#L26)、[registry/types.ts:48,56](../../../packages/ui/src/registry/types.ts#L48) | 宿主上下文与 Composer 契约是通用扩展面 | 契约内写死 `quizMode` 插件私有标识 |
| [theme/workbench.css:96-184,1186-1316](../../../packages/ui/src/theme/workbench.css#L96-L184) | 宿主主题承载全局 Token 与布局 | 全套插件组件样式位于宿主主题；插件单文件组件除 `TermExploreDialog.vue` 外均无 `<style>` 块 |
| [LearningDrawer.vue](../../../plugins/focus-mode/src/ui/LearningDrawer.vue)（299 行） | 抽屉经 `workbench:drawers` 槽位挂载 | 学习闭环界面物理位于宿主组件目录，仅由插件把**宿主组件**注册进槽位 |
| [ui/src/index.ts:21,25](../../../packages/ui/src/index.ts#L21) | `@aervox/ui` 是共享展示组件包 | 公共出口反向 re-export 插件组件，并以泛化别名 `TermsBar` 掩盖领域 |
| [useWorkbenchConversation.ts:188-190](../../../packages/ui/src/composables/useWorkbenchConversation.ts#L188-L190) | 会话组合式函数管理对话状态 | 术语抽取状态机与追问探索入口位于通用会话组合式函数内，插件仅剩视图 |
| [projector.ts:123-124](../../../packages/api-client/src/projector.ts#L123-L124)、[schemas.ts:39](../../../packages/contracts/src/schemas.ts#L39) | 流事件类型与安全投影白名单是内核契约 | `terms_extracted` 插件事件类型写入内核枚举与投影白名单 |

### 1.1 实施期新发现的耦合点（守卫与端到端用例逼出）

以下问题不在初始审计清单内，均在对应切片实施时由机器门禁或集成用例暴露，已并入本 CR 范围：

| 位置 | 性质 | 处理 |
|---|---|---|
| `apps/api/src/modules/learning/terms/routes.ts`、`apps/api/src/modules/learning/learning/cap016-017-routes.ts`（均已于本切片迁出） | `CAP-007` 概念探索与 `CAP-016` 报告端点物理位于宿主模块目录 | 以 `PluginHttpEndpoint` 迁入插件，宿主装配点适配为真实路由（S3b） |
| `apps/api/src/modules/companion/conversation/practice-attempt-port.ts:47`（已于本切片迁出） | 作答落库证据硬编码 `source: "quiz-mode"`（插件 id 字面量写进宿主适配层） | 证据来源标签改由插件在窄端口入参中自述（S3b） |
| [replay-scripts.ts:34-53](../../../apps/api/src/modules/companion/conversation/replay-scripts.ts#L34-L53) | 宿主内建 `scripted-quiz` 回放夹具，直接写死插件工具名与参数 | 新增 `replayScripts` 贡献，夹具归插件；宿主模式名改为领域中立的 `scripted-plugin`（S3b） |
| [package-bundle.ts:769-781](../../../apps/api/src/modules/ecosystem/plugins/package-bundle.ts#L769)（`installFromMarket`） | 出厂集市就地打包走**目录递归**：把 `src/`、`dist/`、`node_modules/` 一并压入校验和载体；工作区依赖在包内是指向目录的符号链接，`Dirent.isDirectory()` 为假 → `readFile` 抛 `EISDIR`，集市安装整体 404 | 与构建期导出共用同一允许清单（fail-closed），并加工件级一致性断言（S3b） |
| [config/src/index.ts:259](../../../packages/config/src/index.ts#L259) | `AERVOX_LOOP_PROVIDER` 枚举含插件领域模式名 `scripted-quiz` | 改为 `scripted-plugin`（插件自带夹具，宿主不复述插件领域）（S3b） |
| [stream-projection.ts:22-38](../../../packages/contracts/src/stream-projection.ts)（改前） | 内核安全投影函数硬编码 `tool.name === "record_practice_attempt"` 并内联 `practiceResultSchema`，为单个插件工具开后门；且 `projectSafeEventData` 全仓**无生产消费者**，缺陷长期潜伏 | 改为通用登记表：插件经 `toolResultProjections` 声明白名单，内核泛化查表（S4b） |
| [schemas.ts:39](../../../packages/contracts/src/schemas.ts)（改前） | 内核 `streamEventTypeSchema` 枚举含插件事件 `terms_extracted` | 枚举收敛为内核事件；插件事件类型经 `streamEventTypes` 登记，envelope 的 `eventType` 改为开放字符串（S4b） |
| [openapi.ts:1310-1335](../../../packages/contracts/src/openapi.ts)（改前） | 内核 OpenAPI 文档硬编码 `/v1/terms/explore` 与插件报告端点及其实例模式 | 插件经 `openApiRoutes` 声明片段，内核泛化补 scope 请求头；文档改为惰性生成以反映装配期登记（S4b） |
| [useAervoxTurn.ts:56](../../../packages/api-client/src/useAervoxTurn.ts)（改前）、[projector.ts:123](../../../packages/api-client/src/projector.ts)（改前） | 宿主传输层为插件事件预留专用回调 `onTermsExtracted`，并为插件端点提供具名包装 `exploreTerm` | 改为通用 `onPluginEvent(eventType, data)` 与 `requestAervoxApi(method, path, body)`；插件 UI 自行订阅与调用（S4b/S5） |

减量证据：宿主源码中 `loadFocusModeRuntimeConfig`、`parseFocusConfig`、`extractFocusTerms`、`DEFAULT_FOCUS_MODE_CONFIG`、`isFocusModeMessage`、`isQuizTriggered`、`studyModeTurnPlugin`、`quizModeTurnPlugin`、`QUIZ_TRIGGER_KEYWORDS` **均无生产消费者**，仅被测试引用；`extractTerms` 的唯一消费者即本插件。因此服务端迁移以「整体搬迁 + 删除失效导出」为主，无需保留兼容层。

### 1.2 服务端迁出后的宿主接缝（契约冻结细节）

插件不再直接接触仓储与宿主实时总线，宿主侧由组合根文件承担**唯一实现点**：

| 接缝 | 宿主实现 | 插件消费方式 |
|---|---|---|
| 回合切面 | [runner.ts](../../../apps/api/src/modules/ecosystem/plugins/turn-plugins/runner.ts) 提供窄端口上下文（`stream` 读写、可选 `llm`）与启停/配置门控 | `turnPlugins` |
| 工具贡献 | [agent-executor.ts](../../../apps/api/src/modules/companion/conversation/agent-executor.ts) 按当前本地上下文构造贡献，并按插件启用状态与可用性门控；`guidance` 经 `customGuidance` 注入位合入基础提示词 | `toolContributions(services)` |
| HTTP 端点 | [plugin-assembly.ts](../../../apps/api/src/plugin-assembly.ts) `mountPluginHttpEndpoints`：鉴权、限流、本地上下文解析、出参包装与异常兜底归宿主 | `httpEndpoints`（handler 收 `services`） |
| 宿主服务窄端口 | [plugin-host-services.ts](../../../apps/api/src/plugin-host-services.ts) 把会话仓储与学习事实仓储收敛为 `sessions` / `learningFacts` 两个意图级端口 | `PluginHostServices` |
| 回放夹具 | [llm-adapter.ts](../../../apps/api/src/modules/companion/conversation/llm-adapter.ts) 按 `AERVOX_LOOP_PROVIDER` 模式名分发，插件脚本不得覆盖宿主已内建模式 | `replayScripts` |

判据差异（有意为之）：**面向模型的行为**（提示词注入、工具可见性）按插件**启用状态与可用性**门控；**插件自有 HTTP 端点**随**代码存在性**挂载（代码缺席即无该路由），与 CR-056「代码缺席不等于显式卸载」一致。学习事实真源（`packages/schema` 表结构、`packages/repositories` 仓储、`packages/review` 排期）不随插件迁出，插件仅经 `learningFacts` 窄端口读写；报告行按不透明载荷转发，插件不解析宿主表字段。

### 1.3 许可证分层边界（新增论据）

[ADR-021](../adr/ADR-021-aervox-core-standalone-package.md) Decision 3 与 Alternatives 将 `packages/core` 定为 **Apache-2.0**，意图是「内核宽松、产品护城」，面向闭源与商业下游。但该宽松内核当前公共出口包含**产品域**内容：苏格拉底教学提示词（`focus-mode-prompt.ts`）与 `CAP-016` 刷题落库工具及端口。把这两项移出内核，既满足去领域化，也修正许可分层的边界，避免产品域提示词随宽松许可外流。

### 1.4 前置缺陷修复（独立 Patch，已落地）

本提案的门禁强制依赖 `scripts/import-boundary.mjs`，而审计发现其存在**早于本提案**的覆盖缺陷，已在 `3ede34e` 独立修复（按 Patch 处理，不并入本 CR 范围）：

- `agent-loop-no-db` 规则的 `fromDir` 仍指向 `packages/agent-loop/`，PR #244 改名后内核 `packages/core/` 脱管；
- `ban-tenant-core-packages` 的 `filePattern` 未含 `core`，CR-030 不变量对内核失效；
- AST 提取未开启 `createImportExpressions`（动态 `import()` 落入死分支）且 `TSImportType` 读错字段，使 `await import("@libsql/client")` 与 `type X = import("@aervox/repositories").X` 可整体绕过门禁。

该修复同时把 `test:unit` 快层过滤由 `agent-loop` 改为 `core`（此前快层测试空壳而遗漏内核），并清理 PR #244 遗留的陈旧路径引用。

## 2. 当前行为 vs 目标行为

| 维度 | 当前行为 | 目标行为 |
|---|---|---|
| 插件实现落点 | 声明在 `plugins/focus-mode/`，实现分散在 `apps/api/src/modules`、`packages/core/src`、`packages/ui/src` | 声明与实现**全部**位于 `plugins/focus-mode/`；实现目录不进分发包 |
| 宿主装配 | `createServerPluginRegistry()` 内硬 import 注册；UI 侧 `defaultBuiltinPlugins` 内建 | 宿主只提供通用注册表；由唯一装配文件（`apps/api/src/plugin-assembly.ts`、`apps/web/src/App.vue`、`apps/desktop/src/renderer/src/App.vue`）显式注入 |
| 插件自有状态 | 宿主 `layout.focusModeEnabled` + `localStorage` 的 `aervox-settings` 键 | 已落地：宿主提供命名空间化的 `pluginState`（`aervox-plugin-state:<pluginId>`）；状态归插件所有，宿主无该字段 |
| 出站模式语义 | `sendMessage(text, { quizMode })` → 宿主拼 `{ mode: 'focus' }` | 宿主透传 `metadata`；由插件自行组装模式语义 |
| 插件流事件 | 宿主会话组合式函数持有 `currentExtractedTerms`，宿主壳体接 `onTermsExtracted` | 已落地：宿主提供 `pluginEvents` 通用总线与 `onPluginEvent` 传输出口；术语状态归插件 |
| 卡片布局 | 宿主硬编码 `['study','timer']` | 已落地：宿主提供 `applySlotPreset(slots)`；由插件传入自身卡片 id（`applyStudyCardLayout`/`restoreStudyCardLayout` 已删除） |
| 组件与样式归属 | 插件组件与学习抽屉在 `packages/ui`；样式在宿主主题 | 已落地：组件、学习抽屉与专属样式全部迁入 `plugins/focus-mode/src/ui/`；宿主主题零插件类名，插件经 `@aervox/ui` 公共子路径接入 |
| 历史别名 | `study-mode`/`quiz-mode` 服务端别名 + 前端双向回退 + 旧配置回退 | **仅 `focus-mode`**；别名与旧配置回退逻辑删除 |
| 代码缺席语义 | 前端插件列表缺记录时默认启用（fail-open）；服务端缺记录时不执行（fail-closed） | 已落地：两端一致 fail-closed（`isPluginAvailable` 无记录即不可用）；与[插件规范 §5.2](../plugin-config-and-pages.md#52-注册接口与生命周期)同步修订 |
| 刷题工具可见性 | 只要装配端口即无条件注入模型工具面 | 随插件启用状态与可用性门控（与 Runner 同判据）；其模型侧使用指南由插件经 `customGuidance` 注入位提供 |
| 插件自有 API | `/v1/terms/explore`、`/v1/hierarchy/explore`、`/v1/practice-reports*` 等路由物理位于宿主模块目录，宿主负责业务处理 | 插件以 `httpEndpoints` 声明，宿主装配点只做框架适配（上下文解析、出参包装、异常兜底）；端点随代码存在性挂载 |
| 宿主服务获取 | 宿主代理层直接持有会话/学习仓储，并把插件 id 写进落库证据 | 插件经 `PluginHostServices` 窄端口（`sessions` / `learningFacts`）声明意图；来源标签由插件自述；`plugin-host-services.ts` 为宿主唯一实现点 |
| 前端包边界 | 无插件包，插件 UI 寄居 `packages/ui` | 插件包 `@aervox/plugin-focus-mode` 提供 `./ui`（源码出口，`src/ui`）与 `./server`（产物出口）；`import-boundary` 新增 `host-no-plugin-implementation` 规则，宿主源码仅组合根可接入插件实现包 |
| 确定性回放夹具 | 宿主 `replay-scripts.ts` 内建插件工具名与参数，模式名含插件领域词 | 夹具归插件（`replayScripts`），宿主只按中立模式名 `scripted-plugin` 分发，且插件不得覆盖宿主已内建模式 |
| 内核出口 | 公共出口含产品域提示词与刷题工具 | 内核出口零产品域内容，与 Apache-2.0 分层一致 |

## 3. 受影响范围与契约

| 层 | 落点 | 变更类型 |
|---|---|---|
| 新包 | `packages/host-plugin-api`（仅类型、零运行时依赖）：`ServerTurnPlugin`、`TurnPluginContext`（含窄端口 `stream`、`llm`）、`BeforeTurnResult`、`AfterTurnContext`、`ServerPluginRegistration`（`turnPlugins` / `toolContributions(services)` / `httpEndpoints` / `replayScripts`）、`PluginHostServices`（`sessions` / `learningFacts`） | 新增公共扩展契约 |
| 新文件 | `apps/api/src/plugin-host-services.ts`：把宿主会话与学习事实仓储收敛为意图级窄端口的**唯一实现点**；`apps/api/src/plugin-assembly.ts` 增补端点挂载适配与注册单元回收 | 新增组合根接缝 |
| 新包 | `plugins/focus-mode`（`@aervox/plugin-focus-mode`）：`./` → UI 贡献源码出口，`./server` → 构建产物出口 | 新增 workspace 包 |
| 契约 | `packages/contracts/src/schemas.ts`：`streamEventTypeSchema` 收敛为内核事件；新增 `streamEventTypeNameSchema`（开放字符串）；新增 `plugin-api-registry.ts` 承载 `registerPluginApiContribution` | 破坏性契约变更（需同步 OpenAPI 生成） |
| 契约 | `packages/contracts/src/index.ts`：`termsExtractedEventDataSchema`、`extractedTermSchema`、`termExplore*` 迁出至插件；`openApiDocument` 常量改为惰性 `buildOpenApiDocument()` | 破坏性导出变更 |
| 契约 | `packages/ui`：`sendMessage` 选项由 `{quizMode,resend}` 改为 `{metadata,resend}`；新增 `pluginState`、`pluginEvents` 通用事件总线、`applySlotPreset`、`composer:indicator` 槽位、`/plugin-api` 与 `/markdown` 子路径出口 | 破坏性契约变更 |
| 契约 | `packages/api-client`：删除插件专用回调 `onTermsExtracted` 与具名端点包装 `exploreTerm`，改为通用 `onPluginEvent` 与 `requestAervoxApi` | 破坏性导出变更 |
| 服务端 | `apps/api/src/modules/ecosystem/plugins/turn-plugins/*`（保留 `registry.ts`、`runner.ts`）；`modules/learning/terms/**` 删除；`companion/conversation/practice-attempt-port.ts`、`learning/learning/cap016-017-routes.ts` 迁出；`replay-scripts.ts` 删除插件夹具；新增 `apps/api/src/plugin-assembly.ts` | 结构重组 + 路由迁移 |
| 服务端 | `apps/api/src/modules/ecosystem/plugins/package-bundle.ts`：`installFromMarket` 由目录递归改为允许清单；`packages/config`：`AERVOX_LOOP_PROVIDER` 的 `scripted-quiz` → `scripted-plugin` | 缺陷修复 + 领域词清除 |
| 内核 | `packages/core/src/{focus-mode-prompt,practice-attempt-tool}.ts` 删除并移出出口；`ports.ts:337-368` 的 `PracticeAttemptPort` 下沉；`base-prompt.ts:75-83` 的工具指南改由插件经既有 `customGuidance` 通用注入位提供 | 破坏性导出变更（向 ADR-021 最小发行边界收敛） |
| 契约 | `packages/contracts/src/stream-projection.ts`：删除 `record_practice_attempt` 核心特判与内联 `practiceResultSchema`，改为插件工具贡献的通用投影声明 | 破坏性契约变更 |
| 内核 | `packages/core/src/base-prompt.ts`：删除 `record_practice_attempt` 的 `BASE_TOOL_GUIDANCE` 条目（已由插件 `guidance` 承载） | 破坏性内容变更 |
| 仓储/数据 | **无表结构变更、无数据迁移**。`learning.ts` 12 张表与既有仓储保持不动；插件以普通消费方身份经窄端口读写 | 不变 |
| 门禁 | 新增 `scripts/check-host-domain-purity.mjs` 与其豁免清单（收敛后清零）；`check-removable-implementation.mjs` 增加 `focus-mode-plugin` 目标（BTD-11）与 `removalPlan`；`import-boundary` 增加 `host-no-plugin-implementation` 规则；`import-boundary`/`check-banned-identifiers`/`check-dep-hoisting`/`check-type-boundary`/`check-architecture-topology` 扫描根扩展至 `plugins` | 新增机器强制 |
| 文档 | `plugin-config-and-pages.md`（§0 打包排除、§4.1 装配点、§4.2 删除死字段、§5 新接缝、§5.2 fail-closed）、`ARCHITECTURE.md` §3/§3.1、`REQUIREMENTS_TRACEABILITY.md` §4.2、`plan.md`（`ITER-026` 渲染） | 事实源同步 |

**明确不在本提案范围**：`packages/schema/src/learning.ts` 表结构、`/v1/mistakes`、`/v1/review-items`、`/v1/learning-plans`、`/v1/practice/sessions*`、`packages/practice-review` 的复习排期算法。这些属 `CAP-003/004/006` 的学习事实真源，按反向检查保留主仓，其自选化需另立 CR 与 ADR。

## 4. 验证与测试标准

```bash
# 1. 宿主纯净性棘轮（新增）与既有守卫
pnpm check:guards

# 2. 物理移除演练：删除插件实现 → 冷构建 API/Worker → 数据权利相位 → 还原
node scripts/run-removability-drill.mjs

# 3. 分发包仍字节可重现，且只含声明文件（构建期导出与出厂集市就地打包共用允许清单）
node scripts/export-plugins.mjs && node --test scripts/export-plugins.test.mjs
pnpm --filter @aervox/api exec vitest run test/plugin-bundle-allowlist.test.ts

# 4. 定向回归与全量门禁
./aervox test fast
./aervox ci all
mise tasks run ci-docs && mise tasks run plan-render && mise tasks run plan-check
```

| 验收项 | 判据 | 证据 |
|---|---|---|
| 宿主零领域知识 | `check-host-domain-purity` 零违规且豁免清单空 | 新增守卫与其 `node --test` 用例 |
| 实现可物理移除 | 移除演练三相位通过：删除 `plugins/focus-mode/` 并剥离三处组合根与包清单引用后，API/Worker 冷构建成功；宿主编译无悬空导入 | `run-removability-drill.mjs`（BTD-11） |
| 分发包最小化 | 包内仅 `plugin.manifest.json`、`config.schema.json`、`SKILL.md`；SHA-256 稳定 | `export-plugins.test.mjs` 正反断言 |
| 别名清除 | 全仓无 `study-mode`/`quiz-mode` 生产引用 | `check-host-domain-purity` 禁词表 |
| 刷题工具门控 | 插件禁用时模型工具面无 `record_practice_attempt`，且不产生学习事实 | `apps/api/test/focus-mode-loop.test.ts`（含停用后门控用例）、`apps/api/test/study-term-plugins.test.ts` |
| 插件端点适配 | 插件声明的端点可经宿主路由访问，分支会话经 `sessions` 窄端口创建，非法入参 fail-closed | `apps/api/test/focus-mode-loop.test.ts`、`apps/api/test/terms-explore.test.ts` |
| 窄端口无泄漏 | 插件包不 import `@aervox/(database\|schema\|repositories)`、`@libsql/*`、`drizzle-orm` 或宿主 Shell 包 | `scripts/import-boundary.mjs` 规则 `plugins-domain-no-db-no-host` |
| 允许清单单一事实源 | 构建期导出与出厂集市就地打包的允许清单逐项一致；`node_modules` 符号链接不再触发 `EISDIR` | `apps/api/test/plugin-bundle-allowlist.test.ts` |
| 宿主无插件夹具 | 宿主内不出现插件工具名与领域模式名 | `check-host-domain-purity` 规则 `practice-tool` 零命中 |
| 内核出口纯净 | `@aervox/core` 公共出口不含产品域提示词与刷题工具 | `packages/core/test/context-builder.test.ts` 负向断言 |
| 双端装配 | Web 与桌面各一条渲染回归，确认插件贡献可见 | `packages/ui/test/standard-workbench.test.ts` |

## 5. 回滚条件与应急方案

- **分片交付**：S0～S7 每片独立功能分支与 PR，任一时刻 `main` 保持全绿；单片回滚只需 revert 该 PR。
- **迁移期过渡壳**：服务端实现已整体搬迁且**未**保留 re-export 壳（审计确认旧导出无生产消费者）；如后续切片需要过渡期，旧路径只保留一层 re-export 壳并登记退役条件，回滚时无需恢复文件物理位置。
- **装配点回滚**：插件装配集中在三个装配文件；禁用只需移除该行，宿主其余部分不受影响。
- **fail-closed 变更回滚**：若「未安装即不可用」引发体验回退，可将插件列表策略回退为「无记录视为启用」，但须同时把服务端门控改为一致策略，禁止两端再次不对称。
- **触发回滚的条件**：分发包校验和变化导致已安装用户升级失败；移除演练失败；`./aervox ci all` 连续两次不可修复失败。
- **数据安全**：本提案无表结构与数据迁移，回滚不涉及数据恢复；插件卸载沿用既有 CR-056 代码缺席语义，保留安装记录、配置与数据管理入口。
