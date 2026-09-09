---
id: AVX-PLUG-001
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.2.0
updated_at: 2026-09-09
reviewed_at: 2026-09-09
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
---

# 插件 Config、Page 与 UI 扩展规范

- 提出人：3yearszhuang · 2026-08-26
- 修改人：linge · 2026-09-09

> 文档编号：AVX-PLUG-001
> 类型：Reference
> 版本：v0.2
> 更新日期：2026-09-09
> 状态：Review Candidate
> 关联：[CR-006](changes/CR-006-plugin-config-and-pages.md)、[能力组合与可选化目录规范](capability-composition.md)、[ADR-009](adr/ADR-009-electron-plugin-sandbox.md)、[ADR-015](adr/ADR-015-vue-full-stack.md)、[AI 质量与安全规范](AI_QUALITY_SAFETY.md)

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

配置按 `(workspaceId, subjectUserId, pluginId)` 持久化：

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

## 4. 前端 UI 插槽扩展规范（UI Extension Slots）

工作台采用声明式插槽容器（`ExtensionSlot`）承载多插件并存的 UI 扩展需求。

### 4.1 插槽架构与清单

插槽使用 Vue 响应式状态进行按需渲染。工作台在核心交互层内置了 10 个标准命名插槽：

| 插槽名称 | 挂载组件与位置 | 典型用途与设计意图 |
|---|---|---|
| `workbench:header-actions` | `WorkbenchHeader.vue` 右侧操作区 | 插件全局快捷动作按钮、状态常驻指示芯片 |
| `nav:menu-items` | `WorkbenchNavPill.vue` 胶囊展开区 | 插件主功能入口、独立视图抽屉触发器 |
| `sidecards:widgets` | `WorkbenchSideCards.vue` 侧边卡槽区 | 自定义常驻卡片、插件信息监控面板、辅助小工具 |
| `conversation:top` | `ConversationConsole.vue` 顶部区域 | 会话级全局公告横幅、置顶任务卡、引导信息 |
| `conversation:bottom` | `ConversationConsole.vue` 底部流式后 | 对话流底部快捷推荐、下一轮建议芯片 |
| `message:bubble-actions` | `ConversationConsole.vue` 与 `HistoryDrawer.vue` 分句下方 | 单条消息气泡下方的操作栏（朗读、翻译、摘录、纠错） |
| `composer:toolbar-actions` | `ComposerDock.vue` 输入坞工具栏 | 输入框左下角附件/语音旁的小工具按钮 |
| `composer:bottom-bar` | `ComposerDock.vue` 输入坞最底部 | 针对当前输入内容的辅助提示横幅或快捷模板栏 |
| `settings:tabs` | `SettingsModal.vue` 左侧或顶部分类项 | 插件在系统设置中的独立分类页签 |
| `settings:panels` | `SettingsModal.vue` 主内容展示区 | 插件在系统设置中对应的配置控制面板 |

### 4.2 注册接口与生命周期

插件通过工作台提供的单例或依赖注入 `uiRegistry` 注册插槽组件：

```ts
import { uiRegistry, type ExtensionSlotName, type SlotItem } from '@aervox/ui';

// 注册插槽组件，返回注销函数
const unregister = uiRegistry.registerSlotItem(
  'composer:toolbar-actions',
  {
    id: 'my-plugin-tool-btn',
    component: MyPluginButton,
    priority: 10, // 可选，默认 0；数值越大展示顺序越靠前
    props: { title: '自定义翻译' }, // 可选静态 Props
  },
);

// 插件卸载或停用时调用清理
unregister();
```

注册规则：

- `id` 全局唯一，重复注册相同 `id` 将替换旧组件；
- 排序按 `priority` 降序排列；相同时保持注册先后顺序；
- 注销函数必须在插件卸载、热重载或停用时调用，避免内存泄漏与无效渲染。

## 5. 核心组件替换契约（Component Overrides）

当插件需要深度定制或整体替换工作台核心表现层（例如深度定制的输入框交互）时，使用组件替换体系。

### 5.1 替换机制

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

### 5.2 ComposerContractProps 契约规范

被替换组件必须严格遵守强类型策略契约，确保数据流、流式状态与发送通道不被破坏。

契约接口定义（位于 `packages/ui/src/registry/types.ts`）：

```ts
export interface ComposerContractProps {
  input?: string;
  streaming?: boolean;
  isComposing?: boolean;
  enterToSend?: boolean;
  placeholder?: string;
  toolApprovalMode?: 'confirm' | 'full_access';
  proactiveActive?: boolean;
  onSend?: (text: string) => void | Promise<void>;
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

## 6. 宿主上下文注入与容灾隔离（Workbench Context & Error Boundaries）

### 6.1 工作台上下文依赖注入

工作台通过 Vue `provideWorkbenchContext()` / `useWorkbenchContext()` 向深层子组件及插件暴露受控领域状态：

```ts
import { useWorkbenchContext } from '@aervox/ui';

const {
  layout,       // 布局与弹窗：studyModeEnabled, enterToSend, openTool, etc.
  timer,        // 番茄钟状态：timerRunning, formattedTime, timerMinutes
  composer,     // 输入状态与附件队列：input, pendingAttachments, clearPendingAttachments
  conversation, // 对话流状态：story, streaming, activeQuestion, pendingApproval
  cards,        // 侧边卡槽状态：activeQuestion, slotCards
  proactive,    // 主动智能状态：proactiveActive, recordProactiveActivity
  sendMessage,  // 统一消息发送方法：(text?, options?) => Promise<void>
} = useWorkbenchContext();
```

插件组件应将其作为只读或调用受控方法，禁止直接修改非自身持有的内部只读属性。

### 6.2 双轨安全模型

遵循 `ADR-009` 与 `CR-006`，系统建立双轨运行机制：

- **第一方 / 受信扩展**：由系统或官方签名分发的组件，可直接作为 Vue 原生组件注册至 `uiRegistry`，在主工作台上下文内渲染；
- **第三方外部插件**：出于安全边界隔离要求，严禁直接向主 DOM 树挂载未经审计的代码。第三方插件只能使用 `PluginPageDialog` 沙箱，通过受限 iframe 与 Bridge SDK 进行交互。

### 6.3 错误隔离沙盒（Error Boundaries）

为杜绝插件异常引发主工作台白屏或交互瘫痪，插槽系统具备运行时错误隔离能力：

- 每个插槽子组件均被 `ExtensionSlotItem` 独立包裹；
- `ExtensionSlotItem` 使用 Vue `onErrorCaptured` 拦截子组件的一切渲染及运行时生命周期错误，阻断异常向上冒泡；
- 发生错误的插件组件 ID 将被自动计入 `failedComponentIds` 集合并被卸载，原位置降级展示警告占位徽标；
- 单个插槽插件崩溃完全不影响工作台主对话、计时器及其他插件的正常运转。

## 7. 验证

- `packages/ui/test/ui-registry.test.ts`：验证 `createUIRegistry` 工厂、插槽注册、优先级排序、组件替换与注销；
- `packages/ui/test/workbench-composables.test.ts`：验证 Layout 与 Composer 间 `enterToSend` 状态同步、番茄钟自定义时长持久化等；
- `packages/database/test/plugin-config.test.ts`：租户隔离、CAS、reset、secret 状态、Page 元数据；
- `apps/api/test/plugin-config.test.ts`：Schema 注册/校验、保存/回显保护、409 冲突、重置、Page 资源与路径穿越、Bridge SDK、卸载清理；
- 门禁命令：
  - `pnpm --filter @aervox/ui typecheck`
  - `pnpm --filter @aervox/ui test`
  - `pnpm --filter @aervox/web build`
  - `node scripts/docs-governance.mjs`
