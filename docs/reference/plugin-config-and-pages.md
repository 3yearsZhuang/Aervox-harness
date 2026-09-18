---
id: AVX-PLUG-001
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.0.1
updated_at: 2026-09-18
reviewed_at: 2026-09-18
review_interval_days: 90
review_triggers:
  - plugins/**
  - packages/contracts/src/plugin-config-schemas.ts
  - packages/repositories/src/repositories/sqlite/*plugin*
  - packages/ui/src/registry/**
  - packages/ui/src/plugins/**
  - packages/ui/src/components/extension/**
  - packages/ui/src/components/plugin/**
  - packages/ui/src/composables/workbench-context.ts
  - apps/api/src/modules/ecosystem/plugins/**
  - apps/api/src/modules/ecosystem/tools/**
  - scripts/export-plugins.mjs
sources:
  - docs/reference/capability-composition.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
  - docs/reference/adr/ADR-015-vue-full-stack.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - packages/contracts/src/plugin-config-schemas.ts
---

# Aervox 插件开发规范

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-18

关联：[开发指南](../how-to/develop-plugin-ui-extension.md)、[能力组合规范](capability-composition.md)、[ADR-009](adr/ADR-009-electron-plugin-sandbox.md)、[ADR-015](adr/ADR-015-vue-full-stack.md)、[数据隐私](DATA_PRIVACY.md)、[落地追踪](REQUIREMENTS_TRACEABILITY.md)。

本文冻结截至 2026-09-18 工作区可核实的插件开发接口、作者规则与交付边界。文档版本 `1.0.0` 表示本规范完成整理，不表示插件 API 已稳定发布，也不改变 CAP、ADR 或 CR 的批准/交付状态。Config/Page 分别借鉴 AstrBot [配置指南](https://docs.astrbot.app/dev/star/guides/plugin-config.html)与[页面指南](https://docs.astrbot.app/dev/star/guides/plugin-pages.html)的公开设计（`AST-08` / `AST-09`；仅设计借鉴，不复制其 AGPL 代码）；参考来源登记遵循 [PRD](PRD.md)。

## 0. 适用范围、事实源与插件分类

运行时字段以 [Zod 契约](../../packages/contracts/src/plugin-config-schemas.ts) 为准；本文补充接入与发布规则；操作步骤只在[开发指南](../how-to/develop-plugin-ui-extension.md)维护。全文使用三个状态标签：**机器强制**表示现有调用路径执行检查；**作者规则**表示开发者和评审必须遵守、机器未全面保证；**未实现**表示不得向用户承诺的能力。

| 接入形态 | 当前可交付内容 | 执行位置与边界 |
|---|---|---|
| 声明式 Bundle | Manifest、Config、Page、Skill、工具元数据、主动规则 | `.aervox-plugin` 安装登记；不会自动加载包内任意服务端 JavaScript |
| Page | 包内 HTML/CSS/JavaScript 与 Bridge | 浏览器受限 iframe；只暴露本插件配置、通知、关闭接口 |
| 第一方 UI 扩展 | Vue 插槽、卡片、消息转换与组件替换 | 随宿主编译的受信代码；具有宿主渲染进程权限，不是第三方沙箱 |
| 第一方 Server Turn 扩展 | `beforeTurn` / `afterTurn` | 随 API 编译并显式注册；运行于 API 进程，拥有受信代码能力 |
| MCP | 外部工具服务的发现、同步与调用 | 独立 MCP 接入流程；插件 Manifest 的 `mcpServers` 不自动连接服务 |
| Skill | 面向模型的说明与渐进披露内容 | 提示词资料，不等于可执行工具、OS 权限或脚本自动执行入口 |

**作者规则**：第三方 Bundle 不得注入宿主 DOM、导入宿主内部路径或把第一方 Hook 当作动态插件执行入口。未来执行第三方服务端代码仍须满足 ADR-009 的进程外隔离要求；iframe、Vue 错误边界、Node `vm` 都不能替代该要求。

能力组合规范中的 `CapabilityManifest`、Provider/Profile、依赖 Resolver、签名与锁文件是另一层契约，不能直接作为当前 `PluginManifest` 安装。其独立可执行可选模块通过 `modules/*` 子仓库交付的要求仍有效；当前 `plugins/*` 是声明与资源包，第一方 UI/Turn 是随主仓交付的受信实现，不能与独立可执行模块混同。单纯制作声明式 Bundle 不要求新建子仓库；真正新增独立可选业务模块、改变目录责任或放宽 ADR 边界，先按能力注册表与 [CR 流程](../how-to/cr-workflow.md)裁定。

### 0.1 Manifest、版本与命名

标准包根必须有 `plugin.manifest.json`；安装器也接受旧名 `manifest.json`，新包使用标准名。最小契约如下：

```json
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginManifest",
  "metadata": {
    "id": "acme-focus-card",
    "displayName": "专注提示卡",
    "publisher": "acme",
    "version": "0.1.0",
    "description": "显示可配置的专注提示",
    "license": "AGPL-3.0-or-later"
  },
  "spec": {}
}
```

| 字段 | 当前机器契约 | 作者规则及限制 |
|---|---|---|
| `apiVersion` / `kind` | 固定 `aervox.dev/v1` / `PluginManifest` | 不支持替换为 `CapabilityManifest` 或自造 API 版本 |
| `metadata.id` | 非空字符串，最长 128 | 使用 `publisher-feature`、小写 ASCII 字母/数字/短横线；不得含路径段、斜杠、反斜杠、`.`/`..`，不得冒用官方 ID；安装器尚无完整 ID 路径校验 |
| `publisher` / `displayName` | 非空字符串，最长 128 | `publisher` 是声明值，不代表身份认证 |
| `version` | 非空字符串，最长 64 | 使用 SemVer；运行时未执行 SemVer 兼容解析或降级阻断 |
| `description` / `license` | 可选字符串 | 发布必须提供说明和真实许可证；预检默认许可证不构成授权证据 |
| `spec.config` | `schemaVersion: 1`，可声明 `entry` | 当前包安装只读取根 `config.schema.json`；不要依赖自定义入口 |
| `spec.pages` | 最多 50 个 Page | 入口位于 `pages/<pageId>/`，ID 唯一 |
| `spec.tools` / `skills` | 最多 100 个工具 / 50 个声明技能 | 元数据登记不保证工具可调用；技能使用唯一全局名称 |
| `spec.skill` / `skills[].entry` | 可声明字符串路径 | 当前通用包安装没有按这两个入口读取内容；使用 §8 的已支持布局 |
| `spec.mcpServers` | 最多 20 个字符串 ID | 当前用于声明/预检展示，不自动安装 MCP 或赋予其 Token |
| `spec.proactive` | 受限感知源与规则 DSL | 见 §8.5；不支持任意脚本感知源或规则代码 |

Manifest 外层及部分对象采用 Zod 默认的未知字段剔除行为，不能用“请求成功”证明扩展字段被支持。Config DSL 和主动声明的严格对象会拒绝未知字段。**未实现**：插件间依赖解析、`engines`/宿主版本范围、加载 `entrypoints`、签名信任链、跨插件 API 和独立稳定的 npm 插件 SDK。

### 0.2 SDK 与依赖边界

| 接口 | 可用范围 | 依赖规则 |
|---|---|---|
| `window.AervoxPluginPageBridge` | Page 脚本 | 从宿主 `/v1/plugin-pages/bridge.js` 加载；先等待 `ready()` |
| `@aervox/ui` 导出的注册表和上下文 | 本仓受信 UI 代码 | 私有 workspace 包、源码出口，不承诺可从 npm 安装；包内实现使用相对导入避免自循环 |
| `@aervox/api-client` | 宿主前端/已评审适配器 | 封装本地 API，不能据此向 Page 开放任意 API |
| `ServerTurnPlugin` / `ToolRuntime` | API 组合根与第一方实现 | 内部 TypeScript 接口，必须随宿主构建；不可从 Bundle 动态装入 |

前端遵循 Vue 单栈，不直接依赖数据库、仓储或 Electron 主进程。依赖版本以根锁文件和 [mise.toml](../../mise.toml) 为准；新增依赖在根执行 `mise exec -- pnpm add -w <pkg>`（开发依赖 `-Dw`），不得在子包独立安装。第三方 Page 的运行依赖必须编译为本地静态资源，不依赖 CDN；避免在包中夹带 `node_modules`、私钥、`.env` 或用户数据。

## 1. Config Schema v1

Config 是 Aervox 自有 DSL，不是任意 JSON Schema，也不兼容 AstrBot 配置文件直接导入。[契约](../../packages/contracts/src/plugin-config-schemas.ts)和[解析器](../../apps/api/src/modules/ecosystem/plugins/config-schema.ts)共同定义行为。

```json
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginConfigSchema",
  "schemaVersion": 1,
  "fields": [
    { "key": "message", "type": "string", "label": "提示", "default": "一次专注一件事", "validation": { "maxLength": 120 } },
    { "key": "minutes", "type": "integer", "label": "时长", "default": 25, "validation": { "min": 1, "max": 120 } },
    { "key": "apiKey", "type": "secret", "label": "API 密钥" }
  ]
}
```

**机器强制**：字段类型为 `string`、`text`、`integer`、`number`、`boolean`、`select`、`multi_select`、`object`、`array`、`secret`；字段键匹配 `[A-Za-z0-9_-]+`、最长 128；顶层字段数组最多 200、递归深度最多 5。`object` 必须有 `children`，`array` 必须有 `items`，选择类型必须有非空 `{value, label}` 选项。

属性包括 `key/type/label/description/hint/placeholder/default/required/options/children/items/validation/visibleWhen`。数值校验键是 `min/max`，不是 `minimum/maximum`；字符串支持 `minLength/maxLength/pattern`。文案可用字符串或语言映射，回退至 `zh-CN`/首个文案。`visibleWhen` 只控制 UI，不是权限门禁。

**作者规则**：同层 key 唯一；默认值必须符合约束；`secret` 仅放顶层且无默认值。当前保存与状态回显只遍历顶层 Secret；嵌套 Secret、复杂对象数组应先提交契约用例再使用。不要使用文件上传、模板列表或代码编辑器等未支持类型。

**兼容限制**：`diffSchema` 能补默认值、计算被移除的顶层字段，但当前注册/读取流程没有完整的类型迁移与 orphan 持久化闭环。不要宣称更名、删字段或改类型会自动无损迁移；此类变更必须说明手工映射、备份和恢复步骤。当前未实现通用版本化配置迁移器。

## 2. 配置存储与 API

当前为纯本地单用户。`LocalContext` 是本地调用上下文，部分内部参数名保留历史拼写不代表存在多租户边界；不得新增多租户契约。配置表以 `pluginId` 唯一，Page 以插件和 Page ID 关联，见 [SQLite Schema](../../packages/schema/src/plugin-config.ts) 与 [Repository](../../packages/repositories/src/repositories/sqlite/plugin-config-repository.ts)。

| HTTP 接口 | 行为 |
|---|---|
| `GET /v1/plugins/:id/config/schema` | 读取 DSL；没有 Schema 返回 404 |
| `PUT /v1/plugins/:id/config/schema` | 注册经过解析的 DSL |
| `GET /v1/plugins/:id/config` | 返回 `revision/schemaVersion/values/secretFields/orphanedValues/issues` |
| `PUT /v1/plugins/:id/config` | 输入 `revision`、`values`、`secretValues`；校验失败 400，版本冲突 409 |
| `POST /v1/plugins/:id/config/reset` | 恢复默认值并清除该插件 Secret |

**机器强制**：普通值保存按已有顶层对象合并；省略字段保留旧值。Secret 输入位于 `secretValues`，省略保留、字符串写入、`null` 清除；API 只返回 `{configured: boolean}`。禁用插件的配置读写返回 `409 PLUGIN_DISABLED`。普通配置在更新前读取并比较 revision，能拒绝串行的旧版本保存；成功保存递增 revision，保存/重置写审计。

**边界**：当前仓储先 SELECT 比较 revision，再仅按 ID UPDATE，不是原子 CAS；两个并发请求可能都通过前置检查并覆盖，尚未完整实现并发防丢更新。[当前 Secret Repository](../../packages/repositories/src/repositories/sqlite/plugin-config-repository.ts)在本地 SQLite 保存原值，不具备默认静态加密或 OS Keychain 保证。Secret 写入发生在普通配置版本检查/保存之前，409 不保证 Secret 未发生变化；含 Secret 的并发保存须串行，冲突后重新读取状态。没有“配置 + Secret + 审计”整体原子提交保证。

**作者规则**：不得在日志、Skill、页面 URL、普通配置或导出包放置 Secret；避免发送不必要的原始数据；重置/覆盖安装/卸载前说明数据影响并由用户发起。数据访问与删除责任继承 [DATA_PRIVACY](DATA_PRIVACY.md)，扩展不得自建数据库直写或绕开核心数据删除传播。

## 3. Page 与 Bridge

Page 元数据为 `id/title/description/entry/capabilities/checksum`。`id` 最长 64、匹配 `[A-Za-z0-9_-]+`；`entry` 必须以 `pages/<id>/` 开头。推荐 `pages/<id>/index.html`；页面资源必须打入包内。API 入口 `.../pages/:pageId/assets/index.html` 会按元数据解析实际入口。

| HTTP 接口 | 行为 |
|---|---|
| `GET /v1/plugins/:id/pages` | 列出 Page |
| `POST /v1/plugins/:id/pages` | 注册 Page，成功 201 |
| `POST /v1/plugins/:id/pages/:pageId/assets` | `{files:[{path,contentBase64}]}`，单文件服务层上限 5 MiB |
| `GET /v1/plugins/:id/pages/:pageId/assets/*` | 返回本地静态资源与 CSP |
| `GET /v1/plugin-pages/bridge.js` | 提供浏览器 Bridge 对象；页面须显式加载 |

### 3.1 Bridge 合同

| 方法 | 返回/行为 | 声明能力 |
|---|---|---|
| `ready()` | Promise，宿主 init 后解析上下文 | 无 |
| `getContext()` | 当前上下文或初始化前 `null` | 无 |
| `getConfig()` | Promise，配置快照 | `config.read`，宿主现有检查 |
| `saveConfig({values,secretValues})` | Promise，保存结果；revision 由宿主维护 | `config.write`，宿主现有检查 |
| `notify({type,message})` | 当前 SDK 不返回内部 Promise | `host.notify`，作者必须声明，宿主暂未检查 |
| `close()` | 当前 SDK 不返回内部 Promise | `host.close`，作者必须声明，宿主暂未检查 |
| `onContext(handler)` | 返回取消订阅函数 | 当前宿主未发送 `aervox:page:context` 事件，不可依赖实时主题更新 |

先 `await ready()`，再读取配置后编辑；不得自行发送猜测的 nonce 或绕过 Bridge。普通调用 15 秒超时；Page 应展示异常并允许用户重试。`saveConfig` 冲突时重新 `getConfig()`，再让用户决定合并，不能无限覆盖重试。

### 3.2 已有防护与未完成边界

[PluginPageDialog](../../packages/ui/src/components/plugin/PluginPageDialog.vue)使用 `sandbox="allow-scripts allow-forms allow-downloads"`，未授予 `allow-same-origin`；资源响应设置 CSP：默认拒绝、脚本和样式允许本地及内联、图片允许本地及 `data:`、`connect-src 'none'`、`form-action 'none'`，另有 `nosniff/no-store/no-referrer`。这些是浏览器页面约束，不是 OS 进程沙箱。

[BundleStore](../../apps/api/src/modules/ecosystem/plugins/bundle-store.ts)检查相对资源路径与词法目录包含关系；尚未检查真实路径/符号链接，也不会拒绝所有未知扩展名。作者禁止链接文件、路径逃逸、远程资源和动态下载代码；服务端不能把这条作者规则当作已实现的隔离证明。

截至本次核验仍有以下缺口，发布安全评估必须覆盖：

- 宿主接收消息只检查 nonce，未绑定 `event.source`/origin；SDK init 也未验证发送窗口，nonce 使用时间/随机串。不能称为已完成来源认证的 Bridge。
- `notify/close` 没有现行 capability 检查；它们的声明并不自动形成强制授权边界。
- 入口 HTML 走 `readPageEntry`，未执行与普通资源相同的启用检查；禁用后已有 iframe/入口访问不会被统一立即杀停。
- iframe 正在运行的代码没有统一 CPU/内存配额与撤权终止证明；不能把网络 CSP 解释为任意第三方执行安全已验收。
- API 启用 Bearer Token 认证时，当前 iframe `src` 和脚本资源没有注入 Authorization 头，资源请求会受到全局认证检查；尚无完整的受保护 Page 资源授权通道。不能将 Token 放入页面 URL 或为访问页面而关闭生产认证。

本次定档记录上述缺口，不通过文字变更批准放宽 ADR-009，也不宣称已修复。

## 4. 服务端会话回合插件体系（Server Turn Plugin Pipeline）

### 4.1 核心契约与执行生命周期

[ServerTurnPlugin](../../apps/api/src/modules/ecosystem/plugins/turn-plugins/types.ts)定义 `id`、可选 `name/aliases`、`beforeTurn(ctx, config)` 和 `afterTurn(ctx, config, beforeResult)`。上下文含 Turn/Session/Attempt ID、用户消息、本地上下文、受信仓储与可选 LLM；后置状态为 `Completed/Failed/Interrupted`。

Hook 必须由 API 组合根 import 并注册到 [ServerPluginRegistry](../../apps/api/src/modules/ecosystem/plugins/turn-plugins/registry.ts)；仅在 Bundle 放置 `.ts/.js` 或 Manifest 字段不会激活 Hook。当前没有对第三方暴露的 Hook npm SDK、进程隔离或运行时代码热加载。现有主 ID `focus-mode` 的服务端兼容别名为 `study-mode/quiz-mode`，新插件不得借用这些 ID；别名是显式注册关系，不是任意插件自动获得的迁移功能。

### 4.2 提示词动态插槽机制（Dynamic Extra Sections）

领域提示词通过 `beforeTurn` 返回 `extraSections: string[]`，由上下文构建器拼入回合；禁止向通用 Base Prompt 增加插件业务分支。返回值还可含 `allowQuizTrigger/quizMode/state`，属于当前第一方内部协议；新业务不得借用刷题标志伪造领域语义。

### 4.3 本地配置与运行时门控（Gating & Config Injection）

[Runner](../../apps/api/src/modules/ecosystem/plugins/turn-plugins/runner.ts)按注册顺序串行执行；装配了扩展仓储时，未安装或未启用的插件不运行。缺省仓储的测试/自定义调用路径默认允许，不能当作生产授权模式。配置来自已保存 `valuesJson`，未保存时可能为 `undefined`，Hook 必须自行提供默认值；它不是 Config Service 的完整快照，也不包含 Secret。

前置结果记录启用和配置快照，后置阶段可复用该快照。因此回合中途禁用插件不保证取消已开始的后置工作。异常按插件捕获，但没有 Hook 超时、硬取消、幂等执行或资源配额；异常捕获也无法阻止同步死循环。后置函数是异步函数不代表独立后台任务；耗时工作应通过既有受信任务边界设计，不在数据库事务内执行外部 I/O。

### 4.4 结构化请求元数据契约（Structured Request Metadata）

底层 [useAervoxTurn](../../packages/api-client/src/useAervoxTurn.ts)和 Turn 协议支持 `metadata`；模式信息应通过该结构传递，不向消息文本插入控制标签。但当前 [WorkbenchContext](../../packages/ui/src/composables/workbench-context.ts)的 `sendMessage` options 只有 `quizMode/resend`，不支持任意 `metadata`。宿主 [AervoxWorkbench](../../packages/ui/src/components/AervoxWorkbench.vue)负责产生现有模式元数据。新模式需要先扩展、评审并测试宿主适配接口，不能照抄不存在的 `sendMessage(text, {metadata})` 用法。

## 5. 前端 UI 插槽扩展规范（UI Extension Slots）

### 5.1 插槽架构与清单

插槽类型以 [registry/types.ts](../../packages/ui/src/registry/types.ts) 为准，当前名称为：

| 位置 | 插槽 |
|---|---|
| 标题与导航 | `header:before`、`header:actions`、`nav:menu-items` |
| 侧栏与消息流 | `sidecards:widgets`、`conversation:top`、`conversation:bottom`、`message:bubble-actions` |
| 输入区 | `composer:toolbar-actions`、`composer:bottom-bar` |
| 设置、抽屉、任务中心 | `settings:tabs`、`workbench:drawers`、`taskcenter:cards` |

### 5.2 注册接口与生命周期

`registerSlotComponent(slot, component, {id, priority, props})` 和别名 `registerSlotItem` 返回注销函数；也可传 `{component,id,priority,props}` 对象。同槽相同 ID 替换旧项，priority 降序排列。**作者规则**：ID 使用 `<pluginId>:<contribution>`、同插件内唯一，不依赖相同 priority 的跨插件顺序，不用他人 ID 覆盖贡献。

使用宿主注入的 `registry`；不要假定全局 `uiRegistry` 就是当前工作台实例。[BuiltinUIPlugin](../../packages/ui/src/plugins/plugin-runtime.ts)的 `setup(registry, context)` 必须返回清理函数，即使是空函数，避免未被登记 cleanup 的实例再次 setup。停用时释放槽位、事件监听、定时器、订阅与请求；清理应幂等。

当前 runtime 只消费显式编译的 `defaultBuiltinPlugins/customPlugins`；默认先 setup，API 列表无对应记录时也视为可用。这是第一方离线体验策略，不是“所有插件默认拒绝激活”的实现，不得借此接入不受信代码。

### 5.3 功能卡片注册与操作区扩展（Functional Cards & Side Cards）

`registerCard({id,label,description,icon,summary,action,extraComponent?,priority?})` 返回注销函数。卡片消费宿主状态和受控方法，不持有独立业务真源；`summary` 不做网络/数据库 I/O。卡片与插槽注销分别登记并在 setup cleanup 内逆序调用。

## 6. 核心组件替换契约（Component Overrides）

### 6.1 替换机制

`overrideComponent(name, component): void` 仅在宿主调用 `getComponent(name, fallback)` 的位置生效；不能任意替换所有 Vue 组件。当前明确消费的扩展点包括 `ComposerDock`。注册表没有单项撤销、替换栈或优先级仲裁；`clear()` 会清除整个实例，插件不能用它卸载自身。需要替换的第一方扩展应由宿主拥有恢复默认值的生命周期，并提供停用/多实例回归用例。

### 6.2 ComposerContractProps 契约规范

以 [ComposerContractProps](../../packages/ui/src/registry/types.ts) 为准：`input/streaming/isComposing/enterToSend/onSend` 为必需项，另有 `placeholder/onVoiceTrigger/onAttachmentPicker/onUpdateInput/'onUpdate:input'`。`onSend` 支持 `quizMode/resend`；没有任意 metadata 或附件对象参数。

提交只走一个通道：宿主提供 `onSend` 时调用一次，不同时 emit `send`。遵守输入法组合、流式、发送中与附件上传的宿主互斥；保留键盘、焦点、无障碍、语音与附件入口或明确限定替换范围。不能把示例简易 textarea 当作完整默认输入坞的功能等价实现。

### 6.3 消息变换管道（Message Transformers）

`registerMessageTransformer(id, transformer, priority)` 返回注销函数，按 priority 降序处理并逐项捕获异常。转换器应是快速纯函数，只改变用户可见内容的明确语义；模式/权限/路由信息用结构化接口，不写入技术前缀。它不是权限校验器，也不能替代宿主发送流程。

## 7. 宿主上下文注入与容灾隔离（Workbench Context & Error Boundaries）

### 7.1 工作台上下文依赖注入

`useWorkbenchContext()` 只能在 `AervoxWorkbench` 提供树内使用；当前包含 `layout/timer/composer/conversation/cards/proactive/registry/sessions/sendMessage`，另有可选 `pluginRuntime/projects` 和若干打开面板方法。它提供真实宿主对象，并不是只读安全代理。作者优先使用公开方法，避免改写其他插件私有状态；不要直接导入应用内部 store 或 SQLite 实现。

### 7.2 双轨安全模型

第一方 UI/Server 扩展必须接受与宿主相同的代码评审、依赖边界和门禁。第三方 Page 只能使用 §3 的受限浏览器接口。新第三方可执行 Host 需要按 ADR-009 单独立项和验证；安装声明式 Bundle 不代表该目标已落地。

### 7.3 错误隔离沙盒（Error Boundaries）

此处“错误隔离”只指 Vue 错误边界。[ExtensionSlotItem](../../packages/ui/src/components/extension/ExtensionSlotItem.vue)捕获 Vue 能传播的错误，[ExtensionSlot](../../packages/ui/src/components/extension/ExtensionSlot.vue)将失败贡献替换为占位。它不隔离权限、无限循环、所有异步异常或全局样式污染。覆盖组件及卡片的实际包裹范围需单独验证，不可由槽位测试推断。

## 8. 插件打包、分发与出厂集市规范（Packaging, Distribution & Market）

### 8.1 单文件分发包规范（`.aervox-plugin`）

格式为标准 ZIP，文件直接位于归档根，不包额外顶层目录：

```text
plugin.manifest.json
config.schema.json                    # 可选；当前固定根路径
SKILL.md                              # 可选；安装后技能名使用 pluginId
skills/acme-focus-card-review/SKILL.md # 可选；名称为全局唯一 ID
pages/dashboard/index.html            # 可选；必须在 Manifest 声明 Page
pages/dashboard/app.js
pages/dashboard/style.css
```

包内安装识别根 `SKILL.md`/`skill.md`、`skills/<name>/SKILL.md`、`spec.skills[].content`。当前不是全目录技能资产复制：不要假定 Skill 的 `scripts/` 或任意资源自动安装、自动执行。根技能预检可能显示 front matter name，而实际安装使用 pluginId；保持二者一致。Skill name 必须匹配 `/^(?!\.{1,2}$)[\w.-]+$/`：使用 ASCII 字母、数字、下划线、点和短横线，排除单独 `.`/`..`，并使用插件前缀保证全局唯一。Manifest 只检查非空字符串等基础长度；Service 会静默跳过不合格名称，因此中文或空格名称可能在返回 201 后仍未登记。`spec.skills` 使用同名条目时会优先于扫描文件，避免重复声明覆盖正文。

工具 ID 自动加 `<pluginId>.` 前缀，但工具 `name` 与技能名没有同等自动命名空间保证；作者使用唯一名称。`spec.tools` 只登记描述和 schema，受信组合根还需 `ToolRuntime.registerHandler`；无 handler 的工具调用会失败。`read_only/guarded/full_access` 是 Manifest 当前接受的枚举；它们没有完整映射到 Loop 使用的 `read_only/write_with_approval/privileged`。通用 [ToolRuntime](../../apps/api/src/modules/ecosystem/tools/runtime.ts) 的直接调用对非只读工具要求 approval，但[会话工具提供器](../../apps/api/src/modules/companion/conversation/tool-providers.ts)对 `guarded/full_access` 返回不支持级别的 `requires_approval`，不会仅凭包声明获得完整执行链。包内写工具还须由受信宿主显式映射/登记安全等级并验证审批链，单独注册 handler 不足以完成接入。`requiredPermissions` 当前存储为元数据，通用 ToolRuntime 没有逐项检查插件 grants，不能把声明当作已授权或已执行的访问控制。

### 8.2 安全门禁与安装前预检（Pre-install Inspection）

`POST /v1/plugins/inspect-package` 输入 `{packageBase64}`，返回摘要、包 SHA-256、权限/数据范围提示、贡献列表、已安装版本与 `isValid/issues`。安装端再次预检；HTTP JSON body 上限为 20 MiB，包含 Base64 开销，不等于展开后的包大小限制。

**机器强制**：可解析 ZIP、归档根 Manifest、Manifest 的已知字段类型、条目路径的绝对路径/`.`/`..` 等检查。**未实现**：ZIP 展开总量/文件数/压缩比配额、全部资源和 Config 内容校验、签名认证、发布者认证、依赖兼容校验、完整数据范围分析。预检 `permissions` 是推断展示，未包含工具 `requiredPermissions` 的完整授权评估；`signature` 当前为 `null`。`isValid: true` 只表示当前静态检查通过。

### 8.3 安装、覆盖与导出边界

[分发引擎](../../apps/api/src/modules/ecosystem/plugins/package-bundle.ts)的实际流程是预检 →（覆盖时先卸载旧插件）→登记插件/工具/技能→尝试配置和 Page 资源。新安装成功返回 201；同 ID 且 `overwrite: false` 返回 `409 PLUGIN_ALREADY_EXISTS`。

配置、Page 和部分资源错误只记录 warning，可能返回 201 但贡献不完整；没有跨文件和数据库的事务回滚。`overwrite: true` 是破坏性的卸载重装，会删除旧配置、Secret、授权和插件资源，并非保留状态的升级。新版本失败时不会自动恢复旧版本。

**作者规则**：发布保留完整源码包、版本、完整 SHA-256 和变更说明；升级前记录配置、确认 Secret 可重新配置并备份本地数据，按[换库与回滚指南](../how-to/run-database-migration-drill.md)处理涉及核心库的恢复。验证新包全部贡献后再宣布安装成功。禁止在无数据副本时测试覆盖真实插件。

`GET /v1/plugins/:id/export` 返回 ZIP Base64：出厂插件优先从源码目录打包；动态插件从仓储重建，但当前未完整重建工具声明、原始元信息及 Page 静态资产。因此导出不是无损备份，也不是用户配置/Secret 备份；发布与回滚使用原始分发包，不能仅依赖 UI“导出”。

停用通过 `PATCH /v1/plugins/:id` 联动工具/技能及已装配的主动规则；卸载通过 DELETE 清理这些登记及 Config/Secret/Page。部分文件或主动状态清理采用容错处理，且内存 Hook/handler 已随宿主编译，不等于卸载任意代码。作者须验证无残留监听器、待执行动作或访问路径。

### 8.4 官方出厂与内置插件集市（Built-in Market）

[出厂同步](../../apps/api/src/modules/ecosystem/plugins/index.ts)扫描 `plugins/*`，同步主记录、根 Skill、Config 与主动声明；没有执行任意包内代码，也不等同完整包导入（工具/Page 贡献需走分发安装验证）。API 启动发现消失的 `installSource=builtin` 插件会清理其记录。

集市 `GET /v1/plugins/market` 当前来自本地出厂目录，不是远程公共插件商店；`POST /v1/plugins/market/:id/install` 走该目录打包安装，内部固定 `overwrite: true`；对已安装插件执行集市安装/更新也会先卸载重装，没有默认拒绝覆盖保护，数据影响同 §8.3。更新提示采用版本字符串是否不同，不是 SemVer 新旧判断。根 `mise tasks run package-plugins` 批量生成 `dist-plugins/<id>-<version>.aervox-plugin`（等价 `pnpm package:plugins`）；脚本只打包，不完成契约校验或安全认证。产物字节可重现（ZIP 条目时间戳固化、目录与条目排序），同源码重复打包的 SHA-256 稳定；`dist-plugins/` 是 gitignore 产物，测试不得依赖它，需分发包时经导出端点现场生成。

### 8.5 主动规则、MCP 与授权

主动声明支持最多 20 个 sensors / 20 个 triggers；触发类型为 `system_state/fatigue_high/drift_high/health_sleep_low/commitment_due`，可附受限 DSL。感知授权使用 `permission=proactive.sensor`、`scope=sourceId`，安装本身不授予此权限；材料化、冷却、免打扰、撤权等遵循主动智能既有契约。`sourceId` 字符串不创建新设备驱动，`quietHoursPolicy=bypass` 声明也不代表无条件越过内核策略。

原始登记接口 `POST /v1/plugins` 会执行额外 DSL 静态验证；分发安装路径当前没有复用完全相同的验证流程。作者必须在主动 DSL 测试与 Worker 执行路径验证规则，不能只依据 Manifest 可解析判定可运行。证据见 [API 生命周期测试](../../apps/api/test/proactive-plugin-lifecycle.test.ts)与 [Worker 派发测试](../../apps/worker/test/proactive-plugin-dispatch.test.ts)。

MCP 使用独立[服务适配器](../../apps/api/src/modules/ecosystem/mcp/service.ts)，工具 ID 为 `mcp__<serverId>__<toolName>`，注册归属为 `mcp:<serverId>`。连接、Token、网络与工具授权在 MCP 流程管理，不随任意引用它的 Bundle 自动授予或撤销；发布说明必须列明这些外部依赖及数据去向。Skill 文本不能提升工具、MCP 或 OS 权限。

## 9. 验证与发布清单

| 验证范围 | 当前回归证据 | 不应据此推断 |
|---|---|---|
| Bundle 预检、安装、冲突、基本导出、集市 | [plugin-distribution.test.ts](../../apps/api/test/plugin-distribution.test.ts) | 原子安装、签名、完整导出回滚、ZIP 资源配额 |
| Config 校验、串行旧版本拒绝、重置、资源路径、清理 | [plugin-config.test.ts](../../apps/api/test/plugin-config.test.ts) | Secret 静态加密、并发 CAS、配置与 Secret 原子性、全 Page 撤权 |
| 工具与权限登记 | [tools-plugins.test.ts](../../apps/api/test/tools-plugins.test.ts) | 任意工具声明自动提供 handler 或 grant 强制检查 |
| Hook 与领域切面 | [study-term-plugins.test.ts](../../apps/api/test/study-term-plugins.test.ts) | 第三方 Hook 隔离、硬超时或即时取消 |
| UI 注册/清理/配置竞态 | [ui-registry.test.ts](../../packages/ui/test/ui-registry.test.ts)、[study-mode-plugin.test.ts](../../packages/ui/test/study-mode-plugin.test.ts) | 任意第三方 Vue 热加载或安全沙箱 |

发布审查逐项确认：

- 标明目标宿主 Git commit/版本、适用 Web/桌面范围、作者与许可证；明确第一方或 Page 路径。
- Manifest/Config/文件布局符合本规范；安装器未覆盖的 ID、命名空间、资源、默认值由作者校验。
- 声明每项权限、真实数据去向、外部服务、Secret 保管和卸载影响；高权限能力不借声明绕过授权。
- 在临时数据环境完成安装→逐项功能→禁用→启用→卸载→重装；覆盖升级另做备份/恢复验证。
- UI 贡献验证无重复挂载/发送、无残留副作用；Page 验证缺权限、Bridge 超时、旧版本冲突/并发保存和浏览器 CSP。
- 受信 Hook/工具验证未启用、无授权、错误和重复执行边界；不能用静态元数据测试替代真实调用。
- 运行[指南中的验证命令](../how-to/develop-plugin-ui-extension.md#5-运行验证并交付)，关联 CAP-020 或实际业务 CAP，登记实现位置、日期和证据；源码变更遵循功能分支与 PR 门禁。

本规范定档后，机器强制项变化须同步契约、实现、测试与本文；作者约束升级为执行机制须补负向验证。扩大不受信执行范围、引入第三方 Host、改变核心数据权利或治理架构必须先建立 CR，文档编辑本身不构成该批准。
