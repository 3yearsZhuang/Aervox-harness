---
id: AVX-PLUG-001
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.4.0
updated_at: 2026-09-11
reviewed_at: 2026-09-11
review_interval_days: 90
review_triggers:
  - packages/ui/src/registry/**
  - packages/ui/src/components/extension/**
  - packages/ui/src/components/workbench/ComposerDock.vue
  - apps/api/src/modules/plugins/**
sources:
  - docs/reference/changes/CR-006-plugin-config-and-pages.md
  - docs/reference/capability-composition.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
  - docs/reference/adr/ADR-015-vue-full-stack.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/reference/changes/CR-030-pure-local-sqlite-database.md
---

# 插件 Config、Page 与 UI 扩展规范

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-11

关联：[CR-006](changes/CR-006-plugin-config-and-pages.md)、[能力组合与可选化目录规范](capability-composition.md)、[ADR-009](adr/ADR-009-electron-plugin-sandbox.md)、[ADR-015](adr/ADR-015-vue-full-stack.md)、[AI 质量与安全规范](AI_QUALITY_SAFETY.md)

本文是插件配置、沙箱页面与前端 UI 扩展的运行时契约与实现规范。设计参考 [AstrBot 插件配置指南](https://docs.astrbot.app/dev/star/guides/plugin-config.html) 与 [插件页面指南](https://docs.astrbot.app/dev/star/guides/plugin-pages.html)（AGPLv3，仅借鉴公开设计），结合 Aervox 自有 ADR-009、ADR-015 与 AVX-CAP-001 规范，提供后端 Config Schema v1、受限 iframe 沙箱 Page，以及工作台前端插槽注入（Extension Slots）与契约化核心组件替换（Component Overrides）。

## 1. Config Schema v1

插件 Bundle 内 `config.schema.json` 遵循：

```json
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginConfigSchema",
  "schemaVersion": 1,
  "fields": [
    {
      "key": "endpoint",
      "type": "string",
      "label": "服务地址",
      "description": "插件调用的服务地址",
      "default": "",
      "required": true,
      "validation": { "maxLength": 2048 }
    },
    { "key": "apiKey", "type": "secret", "label": "API 密钥" }
  ]
}
```

支持字段类型：`string`、`text`、`integer`、`number`、`boolean`、`select`、`multi_select`、`object`、`array`、`secret`。

统一字段属性：`key`、`type`、`label`、`description`、`hint`、`placeholder`、`default`、`required`、`options`、`children`、`items`、`validation`、`visibleWhen`。

约束：

- 字段键仅允许字母、数字、下划线与短横线；
- `object` 必须声明 `children`，`array` 必须声明 `items`，`select`/`multi_select` 必须声明结构化 `options`；
- 最大嵌套深度 5，单个 Schema 最多 200 个字段，配置载荷最大 256 KB；
- `visibleWhen` 仅控制界面显隐，不承担权限控制；
- 文案支持字符串或按 locale 映射的对象，回退顺序为当前 locale → `zh-CN` → 首个可用语言；
- 暂不支持文件上传、模板列表与代码编辑器。

Schema 升级规则：

- 新增字段自动补默认值；
- 类型兼容时保留原值；
- 已移除字段进入 `orphanedValues`，不立即丢弃；
- 重置必须用户显式确认。

## 2. 配置存储与 API

目标配置按 `pluginId` 持久化；CR-030 D2 完成后，最终表结构不再包含租户列，调用层的 `LocalContext` 仅为兼容参数：

- `plugin_configs`：非敏感配置值、secret 键列表、schemaVersion、revision、orphanedValues；
- `plugin_config_secrets`：secret 字段（本地默认实现存储值但不对外回显；生产必须注入加密 SecretStore Port）；
- `plugin_pages`：Page 元数据（系统级，生命周期归插件）；
- `plugins.config_schema_json`：插件配置 Schema（系统级）。

API：

```text
GET    /v1/plugins/:pluginId/config/schema
PUT    /v1/plugins/:pluginId/config/schema
GET    /v1/plugins/:pluginId/config
PUT    /v1/plugins/:pluginId/config
POST   /v1/plugins/:pluginId/config/reset
GET    /v1/plugins/:pluginId/pages
POST   /v1/plugins/:pluginId/pages
POST   /v1/plugins/:pluginId/pages/:pageId/assets
GET    /v1/plugins/:pluginId/pages/:pageId/assets/*
GET    /v1/plugin-pages/bridge.js
```

规则：

- `secret` 读取接口只返回 `{ configured: boolean }`；
- 保存请求中缺少 secret 字段表示保持原值，`null` 表示清除；
- 保存使用 revision CAS，冲突返回 `409 PLUGIN_CONFIG_REVISION_CONFLICT`；
- 配置读写、重置、插件启停与 Page 打开写入 `AuditRecord`；
- 插件禁用后配置仍保留，但 Config/Page 操作被拒绝；卸载后按删除规则清理。

## 3. Page 与 Bridge

插件 Bundle 目录约定：

```text
plugin-bundle/
├── plugin.manifest.json
├── config.schema.json
└── pages/
    └── <page-id>/
        ├── index.html
        ├── app.js
        ├── style.css
        └── assets/
```

Page 约束：

- 第一版只加载已安装且校验过的 Bundle 本地资源，禁止远程 URL；
- iframe 固定 `sandbox="allow-scripts allow-forms allow-downloads"`、`referrerpolicy="no-referrer"`；
- Page 静态资源响应的 CSP 使用 `frame-ancestors *`（宿主 Web/Desktop 与 API 不同源，不能用 `'self'`），页面内 `connect-src 'none'`，所有业务操作必须经过 Bridge；
- 禁止 `allow-same-origin`、`allow-top-navigation`、`allow-popups`；
- 禁止访问宿主 Cookie、LocalStorage、父 DOM 或直接请求 API/数据库/外部网络。

Bridge SDK 由 `GET /v1/plugin-pages/bridge.js` 注入，暴露 `window.AervoxPluginPageBridge`：

```ts
interface AervoxPluginPageBridge {
  ready(): Promise<PluginPageContext>;
  getContext(): PluginPageContext | null;
  getConfig(): Promise<PluginConfigSnapshot>;
  saveConfig(input: {values: Record<string, unknown>; secretValues: Record<string, string | null>}): Promise<PluginConfigSnapshot>;
  notify(input: {type: "success" | "info" | "warning" | "error"; message: string}): void;
  close(): void;
  onContext(handler: (context: PluginPageContext) => void): () => void;
}
```

Page 能力声明（`plugin.manifest.json` 的 `spec.pages[].capabilities`）：

- `config.read`：读取本插件配置；
- `config.write`：保存本插件配置；
- `host.notify`：显示宿主通知；
- `host.close`：关闭 Page 弹窗。

## 4. 服务端会话回合插件体系（Server Turn Plugin Pipeline）

除了只读的 UI 呈现与受限 Page，深度参与 AI 交互与业务逻辑闭环的插件需接入服务端会话回合插件体系（Server Turn Plugin）。

### 4.1 核心契约与执行生命周期

服务端回合插件运行于 Fastify API 服务的会话执行主循环（`apps/api/src/modules/plugins/turn-plugins/`），契约接口定义如下：

```ts
export interface ServerTurnPlugin {
  id: string;
  beforeTurn?: (
    ctx: TurnPluginContext,
    configValues?: Record<string, unknown>,
  ) => Promise<BeforeTurnResult | void> | BeforeTurnResult | void;
  afterTurn?: (
    ctx: AfterTurnContext,
    configValues?: Record<string, unknown>,
    beforeResult?: BeforeTurnResult,
  ) => Promise<void> | void;
}
```

插件执行生命周期划分为两个核心切面：

1. **`beforeTurn` 前置切面**：
   - 在 Agent Loop 组装上下文与调用模型之前执行；
   - 接收会话上下文（`turnId`、`sessionId`、`userMessage`、`metadata`、`tenant` 等）以及当前租户的插件配置载荷（`configValues`）；
   - 负责动态构造并返回系统提示词扩展段（`extraSections: string[]`）以及模式控制标记（`quizMode`、`allowQuizTrigger`）；
   - 单个插件在 `beforeTurn` 抛出未捕获异常将被执行器捕获并记录警告日志，绝不阻断核心回合创建。

2. **`afterTurn` 后置切面**：
   - 在回合达成终态（如 `status === "Completed"`）且主文本流排空后异步分发执行；
   - 接收包含 `llm`（轻量级 LLM 可调用对象，用于独立单步语义分析）、`status` 以及 `beforeResult` 的后置上下文；
   - 典型用于执行轻量异步增强：关键术语抽取（`terms_extracted` 事件）、知识图谱沉淀、错题归因审计等；
   - 异步后处理完全运行在响应返回之后，不增加用户等待延迟，异常自动隔离。

### 4.2 提示词动态插槽机制（Dynamic Extra Sections）

为了防止模型核心底座退化为臃肿的大单体，系统确立了**纯净底座与切面扩展**的绝对边界：

- **底座零污染红线**：`packages/agent-loop/src/base-prompt.ts` 为完全通用的系统根提示词底座，严禁在其中硬编码或内嵌任何特定插件、教学法或业务模式的分支逻辑（如严禁在底座添加 `if (isFocusMode)` 或包含特定模式词）；
- **动态切面注入**：所有模式特有提示词（如专注模式苏格拉底教学原则、严格防剧透脚手架规则、出题考官判定契约）一律由插件在 `beforeTurn` 中通过 `extraSections: string[]` 返回；
- **Driver 一致性**：原生 Agent Loop 与 DSH 等进程外 Adapter 必须消费同一组已审核 `extraSections`，不得因切换 Driver 丢失插件安全或教学约束；
- **确定性层级顺序**：`agent-executor.ts` 会将收集到的 `extraSections` 插入到通用工具使用规范之后、个性化人格设定与全局输出格式之前，确保全局输出格式规范（禁 emoji / 纯文本）始终保持最高约束力。

### 4.3 本地配置与运行时门控（Gating & Config Injection）

回合插件编排器（`executeBeforeTurnPlugins` 与 `executeAfterTurnPlugins`）在调用插件前自动执行本地插件安全门控：

1. **启停门控**：向 `IExtensionRepository` 检查本地插件的激活状态（`record.enabled === 1`）。未安装或处于禁用状态的插件自动跳过执行；
2. **配置自动注入**：向 `IPluginConfigRepository` 读取本地保存的配置 JSON，反序列化后作为 `configValues` 参数直接传入切面函数。插件开发者无需在插件代码中直接处理数据库查询与连接；
3. **别名与平滑迁移**：插件注册表与编排器内置别名映射能力（例如 `focus-mode` 与旧版 `study-mode`）。读取、保存、重置及 secret 清理都必须先解析到同一真实插件 ID，避免旧别名产生孤立配置。

### 4.4 结构化请求元数据契约（Structured Request Metadata）

在插件交互触发方面，系统废弃易产生文本污染的硬编码前缀（如旧版在聊天文本中拼接 `[模式：xxx]`）：

- 前端在调用 `POST /v1/turns` 时，通过可选的 `metadata: Record<string, unknown>` 字段传递插件意图（例如 `{ mode: 'focus', intent: 'quiz' }`）；
- `metadata` 直接送入 `TurnPluginContext.metadata`；
- 插件的 `beforeTurn` 优先检查结构化元数据识别意图；仅在兼容旧客户端时才保留文本前缀回退识别；
- 用户的原始消息正文（`userMessage`）保持纯净，不在历史记录与展示界面中残留技术标记。

## 5. 前端 UI 插槽扩展规范（UI Extension Slots）

工作台采用声明式插槽容器（`ExtensionSlot`）承载多插件并存的 UI 扩展需求。

### 5.1 插槽架构与清单

插槽使用 Vue 响应式状态进行按需渲染。工作台在核心交互层内置了 10 个标准命名插槽：

| 插槽名称 | 挂载组件与位置 | 典型用途与设计意图 |
|---|---|---|
| `header:before` | `WorkbenchHeader.vue` 左侧操作区前置 | 标题/标识前置插件图标、状态胶囊 |
| `header:actions` | `WorkbenchHeader.vue` 右侧操作区 | 插件全局快捷动作按钮、状态常驻指示芯片 |
| `nav:menu-items` | `WorkbenchNavPill.vue` 胶囊展开区 | 插件主功能入口、独立视图抽屉触发器 |
| `sidecards:widgets` | `WorkbenchSideCards.vue` 侧边卡槽区 | 自定义常驻卡片、插件信息监控面板、辅助小工具 |
| `conversation:top` | `ConversationConsole.vue` 顶部区域 | 会话级全局公告横幅、置顶任务卡、引导信息 |
| `conversation:bottom` | `ConversationConsole.vue` 底部流式后 | 对话流底部快捷推荐、下一轮建议芯片 |
| `message:bubble-actions` | `ConversationConsole.vue` 与 `HistoryDrawer.vue` 分句下方 | 单条消息气泡下方的操作栏（朗读、翻译、摘录、纠错） |
| `composer:toolbar-actions` | `ComposerDock.vue` 输入坞工具栏 | 输入框左下角附件/语音旁的小工具按钮 |
| `composer:bottom-bar` | `ComposerDock.vue` 输入坞最底部 | 针对当前输入内容的辅助提示横幅或快捷模板栏 |
| `settings:tabs` | `SettingsModal.vue` 左侧或顶部分类项 | 插件在系统设置中的独立分类页签 |

### 5.2 注册接口与生命周期

插件通过工作台提供的单例或依赖注入 `uiRegistry` 注册插槽组件（支持 `registerSlotComponent` 与 `registerSlotItem` 别名，且支持对象参数或组件+选项双签名）：

```ts
import { uiRegistry, type ExtensionSlotName, type SlotItem } from '@aervox/ui';

// 方式一：对象参数形式注册插槽组件（registerSlotItem / registerSlotComponent 均支持）
const unregister = uiRegistry.registerSlotItem(
  'composer:toolbar-actions',
  {
    id: 'my-plugin-tool-btn',
    component: MyPluginButton,
    priority: 10, // 可选，默认 0；数值越大展示顺序越靠前
    props: { title: '自定义翻译' }, // 可选静态 Props
  },
);

// 方式二：三参数形式
// const unregister = uiRegistry.registerSlotComponent('composer:toolbar-actions', MyPluginButton, { id: 'my-plugin-tool-btn', priority: 10 });

// 插件卸载或停用时调用清理
unregister();
```

注册规则：

- `id` 全局唯一，重复注册相同 `id` 将替换旧组件；
- 排序按 `priority` 降序排列；相同时保持注册先后顺序；
- 注销函数必须在插件卸载、热重载或停用时调用，避免内存泄漏与无效渲染。

## 6. 核心组件替换契约（Component Overrides）

当插件需要深度定制或整体替换工作台核心表现层（例如深度定制的输入框交互）时，使用组件替换体系。

### 6.1 替换机制

插件调用 `overrideComponent` 注册目标组件实现：

```ts
import { uiRegistry } from '@aervox/ui';
import CustomComposer from './CustomComposer.vue';

// 替换默认输入底座组件
uiRegistry.overrideComponent('ComposerDock', CustomComposer);
```

工作台解析原则：

- 宿主通过 `registry.getComponent(name, DefaultComponent)` 解析当前渲染组件；
- 当存在合法替换组件时优先使用插件提供物；当无替换或替换被注销时自动平滑回退至内置默认实现。

### 6.2 ComposerContractProps 契约规范

被替换组件必须严格遵守强类型策略契约，确保数据流、流式状态与发送通道不被破坏。

契约接口定义（位于 `packages/ui/src/registry/types.ts`）：

```ts
export interface ComposerContractProps {
  input: string;
  streaming: boolean;
  isComposing: boolean;
  enterToSend: boolean;
  placeholder?: string;
  onSend: (text?: string, options?: { quizMode?: boolean; resend?: boolean }) => Promise<void>;
  onVoiceTrigger?: () => void;
  onAttachmentPicker?: () => void;
  'onUpdate:input'?: (value: string) => void;
  onUpdateInput?: (value: string) => void;
}
```

核心事件与交互要求：

- **输入受控与双向绑定**：必须通过 `props.input` 展示输入内容，通过 `emit('update:input', val)` 回传更改；
- **回车与禁用控制**：当 `streaming` 为 `true` 时禁用提交；当 `enterToSend` 为 `true` 且未处于输入法合成状态（`isComposing`）时响应回车；
- **单通道派发原则**：若宿主传入了 `props.onSend` / `props.onAttachmentPicker` / `props.onVoiceTrigger` 等回调函数，组件在相应触发时**仅调用该回调**，不得在同一次交互中再次触发 `emit('send')` 或执行默认逻辑，防止多通道重复提交；
- **宿主并发互斥保护**：宿主 `sendMessage` 内置 `isSendingMessage` 锁与 `attachmentUploading` 守卫，跨越异步附件上传到 SSE 结束的全周期，彻底阻断并发连击。

### 6.3 消息变换管道（Message Transformers）

当插件需要修饰、过滤或动态增强用户发送的消息内容时，通过 `uiRegistry.registerMessageTransformer` 挂载至发送管道。对于模式意图声明，优先采用结构化 `metadata` 传递；文本前缀变换仅作为兼容后备方案。

契约接口定义（位于 `packages/ui/src/registry/types.ts`）：

```ts
export interface MessageTransformContext {
  quizMode?: boolean;
  [key: string]: unknown;
}

export type MessageTransformer = (message: string, context?: MessageTransformContext) => string;

// 注册消息变换拦截器（支持可选 priority 优先级，降序执行）
const unregister = uiRegistry.registerMessageTransformer('my-plugin:prefix', (text, context) => {
  if (context?.quizMode) return text;
  const prefix = '[模式：专属模式] ';
  return text.startsWith(prefix) ? text : `${prefix}${text}`;
}, 100);
```

执行原则与安全约束：

- **幂等性原则**：变换器必须支持重复处理幂等，针对静态前缀必须通过 `startsWith` 防御，避免重发或二次管道流转时前缀重复堆叠；
- **确定性执行序**：宿主执行 `registry.transformMessage(message, context)` 时严格按照 `priority` 降序串行流水线执行；
- **容错隔离**：单个变换器执行抛出异常时由宿主捕获告警，保证核心发送通道不被阻断。

## 7. 宿主上下文注入与容灾隔离（Workbench Context & Error Boundaries）

### 7.1 工作台上下文依赖注入

工作台通过 Vue `provideWorkbenchContext()` / `useWorkbenchContext()` 向深层子组件及插件暴露受控领域状态：

```ts
import { useWorkbenchContext } from '@aervox/ui';

const {
  layout,       // 布局与弹窗：focusModeEnabled (兼容 studyModeEnabled), enterToSend, openTool, etc.
  timer,        // 番茄钟状态：timerRunning, formattedTime, timerMinutes
  composer,     // 输入状态与附件队列：input, pendingAttachments, clearPendingAttachments
  conversation, // 对话流状态：story, streaming, activeQuestion, pendingApproval
  cards,        // 侧边卡槽状态：activeQuestion, slotCards
  proactive,    // 主动智能状态：proactiveActive, recordProactiveActivity
  sendMessage,  // 统一消息发送方法：(text?, options?) => Promise<void>
} = useWorkbenchContext();
```

插件组件应将其作为只读或调用受控方法，禁止直接修改非自身持有的内部只读属性。

### 7.2 双轨安全模型

遵循 `ADR-009` 与 `CR-006`，系统建立双轨运行机制：

- **第一方 / 受信扩展**：由系统或官方签名分发的组件，可直接作为 Vue 原生组件注册至 `uiRegistry`，在主工作台上下文内渲染；
- **第三方外部插件**：出于安全边界隔离要求，严禁直接向主 DOM 树挂载未经审计的代码。第三方插件只能使用 `PluginPageDialog` 沙箱，通过受限 iframe 与 Bridge SDK 进行交互。

### 7.3 错误隔离沙盒（Error Boundaries）

为杜绝插件异常引发主工作台白屏或交互瘫痪，插槽系统具备运行时错误隔离能力：

- 每个插槽子组件均被 `ExtensionSlotItem` 独立包裹；
- `ExtensionSlotItem` 使用 Vue `onErrorCaptured` 拦截子组件的一切渲染及运行时生命周期错误，阻断异常向上冒泡；
- 发生错误的插件组件 ID 将被自动计入 `failedComponentIds` 集合并被卸载，原位置降级展示警告占位徽标；
- 单个插槽插件崩溃完全不影响工作台主对话、计时器及其他插件的正常运转。

## 8. 验证

- `apps/api/test/study-term-plugins.test.ts`：验证 `ServerTurnPlugin` 门控、配置注入、`extraSections` 提示词切面注入与异步术语抽取；
- `apps/api/test/quiz-mode.test.ts`：验证统一 `focus-mode` 结构化元数据触发、出题与答题判定落库；
- `packages/agent-loop/test/context-builder.test.ts`：验证 Base Prompt 纯净底座与 `extraSections` 顺序注入；
- `packages/ui/test/ui-registry.test.ts`：验证 `createUIRegistry` 工厂、插槽注册、优先级排序、组件替换与注销；
- `packages/ui/test/study-mode-plugin.test.ts`：验证第一方 UI 插件加载与槽位挂载；
- `packages/ui/test/workbench-composables.test.ts`：验证 Layout 与 Composer 间 `enterToSend` 状态同步、番茄钟自定义时长持久化等；
- `packages/database/test/plugin-config.test.ts`：租户隔离、CAS、reset、secret 状态、Page 元数据；
- `apps/api/test/plugin-config.test.ts`：Schema 注册/校验、保存/回显保护、409 冲突、重置、Page 资源与路径穿越、Bridge SDK、卸载清理；
- 门禁命令：
  - `pnpm --filter @aervox/ui typecheck`
  - `pnpm --filter @aervox/ui test`
  - `pnpm --filter @aervox/web build`
  - `node scripts/docs-governance.mjs`
