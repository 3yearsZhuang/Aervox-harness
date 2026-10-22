---
id: AVX-PLUG-001
---

# Aervox 插件开发规范

关联：[开发指南](../how-to/develop-plugin-ui-extension.md)、[能力组合规范](capability-composition.md)、[ADR-009](adr/ADR-009-electron-plugin-sandbox.md)、[ADR-015](adr/ADR-015-vue-full-stack.md)、[原子激活决定](adr/ADR-028-plugin-atomic-activation.md)、[API 规范](API_CONVENTIONS.md)、[数据隐私](DATA_PRIVACY.md)、[落地追踪](REQUIREMENTS_TRACEABILITY.md)。

本文维护插件开发接口、作者规则与交付边界，具体字段以代码为准；规范存在不代表插件 API 或产品已发布。Config/Page 分别借鉴 AstrBot [配置指南](https://docs.astrbot.app/dev/star/guides/plugin-config.html)与[页面指南](https://docs.astrbot.app/dev/star/guides/plugin-pages.html)的公开设计（`AST-08` / `AST-09`；仅设计借鉴，不复制其 AGPL 代码）；参考来源登记遵循 [PRD](PRD.md)。

## 0. 适用范围、事实源与插件分类

运行时字段以 [Zod 契约](../../packages/contracts/src/plugin-config-schemas.ts) 为准；本文补充接入与发布规则；操作步骤只在[开发指南](../how-to/develop-plugin-ui-extension.md)维护。全文使用三个状态标签：**机器强制**表示现有调用路径执行检查；**作者规则**表示开发者和评审必须遵守、机器未全面保证；**未实现**表示不得向用户承诺的能力。

| 接入形态 | 当前可交付内容 | 执行位置与边界 |
|---|---|---|
| 声明式 Bundle | Manifest、Config、Page、Skill、工具元数据、主动规则 | `.aervox-plugin` 安装登记；不会自动加载包内任意服务端 JavaScript |
| Page | 包内 HTML/CSS/JavaScript 与 Bridge | 浏览器受限 iframe；只暴露本插件配置、通知、关闭接口 |
| 第一方根界面 | 完整工作台或独立桌宠根组件 | 组合根选择、随宿主构建；通过 `@aervox/ui-host` 加载，详见 §0.4 |
| 第一方 UI 扩展 | Vue 插槽、卡片、消息转换与组件替换 | 随宿主编译的受信代码；具有宿主渲染进程权限，不是第三方沙箱 |
| 第一方 Server Turn 扩展 | `beforeTurn` / `afterTurn` | 随 API 编译并显式注册；运行于 API 进程，拥有受信代码能力 |
| 第一方 Bot 传输扩展 | 登录、文字收发、连接状态与取消 | API 组合根显式注册；宿主控制凭据、持久受理、执行策略与实例代际，见 §0.5 |
| MCP | 外部工具服务的发现、同步与调用 | 独立 MCP 接入流程；插件 Manifest 的 `mcpServers` 不自动连接服务 |
| Skill | 面向模型的说明与渐进披露内容 | 提示词资料，不等于可执行工具、OS 权限或脚本自动执行入口 |

**作者规则**：第三方 Bundle 不得注入宿主 DOM、导入宿主内部路径或把第一方 Hook 当作动态插件执行入口。未来执行第三方服务端代码仍须满足 ADR-009 的进程外隔离要求；iframe、Vue 错误边界、Node `vm` 都不能替代该要求。

能力组合规范中的 `CapabilityManifest`、Provider/Profile、依赖 Resolver、签名与锁文件是另一层契约，不能直接作为当前 `PluginManifest` 安装。其独立可执行可选模块通过 `modules/*` 子仓库交付的要求仍有效；当前 `plugins/*` 可以内聚声明与第一方源码，UI/Turn 是随主仓交付的受信实现，不能与独立可执行模块混同。单纯制作声明式 Bundle 不要求新建子仓库；真正新增独立可选业务模块、改变目录责任或放宽 ADR 边界，在 PR 中说明范围；重大边界按 [ADR](adr/README.md)评审。

### 0.3 插件与宿主分工

决定见 [ADR-016](adr/ADR-016-base-boundaries.md#cr-060)（原 CR-060）。第一方声明与源码可同置 `plugins/<id>/`，分发包只含显式允许的声明和资源，不含源码、依赖及构建产物。API/Web/Desktop 各自的组合根显式注入插件，宿主包不内建插件实现或领域分支。

插件拥有自身提示词、状态机、组件、样式、工具与事件语义；宿主提供通用注册表、`pluginState`、`pluginEvents`、`metadata` 和窄端口。学习事实、仓储与复习排期保持主仓所有权，插件不能另建数据真源；这不把核心学习闭环改为可选能力。

模型工具/guidance、Hook 与插件 HTTP 入口按启用记录和可用性统一准入；缺记录、停用、不可用或缺失仓储均拒绝。缺包不等于卸载，保留配置、Secret、授权历史及数据管理入口。具体执行时机、前置快照及协作取消的边界见 §4，数据责任见末节。

### 0.4 根界面插件（CR-065）

根界面使用 [`UISurfacePlugin`](../../packages/ui-host/src/surface-context.ts)：`id`、`apiVersion: 1`、`surface`（`main` 或 `companion`）、`platforms` 与异步 `load(signal)`。这是受信源码装配接口，不是可安装的 `PluginManifest`；`surfaces/workbench-ui` 与 `surfaces/companion-ui` 不生成声明式分发包，也不使用市场开关关闭标准产品能力。

- 组合根：Web/桌面 `App.vue` 从默认工作台、紧凑工作台与主动陪伴界面选择，桌面 `pet-main.ts` 选择独立桌宠；移动端沿用 Web。只有组合根允许引用具体插件包。
- [`UISurfaceHost`](../../packages/ui-host/src/UISurfaceHost.vue) 校验平台、根类型和版本；默认加载上限 15 秒。加载或 Vue 渲染失败显示宿主恢复界面，可重试；浏览器缓存失败导入时，使用组合根注入的 `requestReload` 重新加载当前窗口。刷新仅由用户点击触发。插件加载结果迟到时丢弃。
- 每次根实例获得独立的 `UISurfaceContext`，含平台、根类型、取消信号及可选 `requestClose`。取消信号和 Vue 卸载负责结束本实例订阅、事件监听与计时器；工作台注册表也按实例创建。关闭界面不会请求取消已受理的 API 回合。
- `viewProps` 与事件用于受信界面装配，平台由宿主固定；这些参数不是第三方权限代理。根界面不能通过该接口取得任意 Electron 或数据库访问权。
- 工作台根组件位于 `surfaces/workbench-ui/src/AervoxWorkbench.vue`，经 `@aervox/ui/workbench` 使用共享构件；旧 `@aervox/ui` 的 `AervoxWorkbench` 根导出已移除。`@aervox/ui/env` 提供共享资源与 Live2D 浏览器类型。
- 受信内置界面可由组合根与设置切换；独立安装、第三方隔离和跨版本升级回滚未在本切片交付。Vue 错误边界不能中断同步死循环或隔离全局样式；可信权限和数据管理责任仍由平台宿主与 API 持有。

### 0.5 Bot 传输贡献（ADR-029）

`ServerPluginRegistration.botAdapters` 贡献受信传输实现，完整类型见 [`bot-adapter.ts`](../../packages/host-plugin-api/src/bot-adapter.ts)。每个贡献声明平台、支持的直接/群消息、登录能力和文本分段上限，通过连接工厂产生实例；实例实现 `start`、`send`、异步 `stop`，可选 `beginLogin` / `pollLogin`。模块导入不得自动连接平台。

- **宿主责任**：按连接注入不可变配置、取消信号、加密 Secret、非秘密 checkpoint、状态回调和持久受理回调；启停、重配、撤权、卸载及关闭后拒绝旧实例写入。会话创建、执行策略、去重、顺序队列、取消与回执仍由宿主拥有。
- **适配器责任**：只翻译平台协议及控制网络资源；等待持久受理成功后推进协议游标。不得访问仓储、调用模型、根据消息 metadata 修改权限，或把群消息送入本人人格/记忆上下文。
- **凭据责任**：Bot Secret 使用独立加密存储，不能沿用 §2 的普通插件配置 Secret 持久化假设；微信上下文令牌与账号恢复信息属于适配器私有状态。对外只显示凭据是否已配置，扫码内容由 UI 本地生成二维码，不交给外部二维码服务。
- **回执责任**：区分平台接受、明确失败及结果未知；未知结果不得自动重试。`stop()` 结束在途网络和重连任务；晚到帧、登录或发送响应不能恢复停用连接。

首批实现为 `plugins/bot-weixin` 与 `plugins/bot-onebot`；它们仍随宿主构建，`.aervox-plugin` 不分发可执行实现。微信与 QQ 的权限差异、持久策略和恢复不变量以 [ADR-029](adr/ADR-029-bot-platform-adapters.md) 与 [SRS](SRS.md#fr-plg-005-bot-平台文字接入) 为准，接入步骤见[连接机器人](../how-to/connect-bots.md)。新的第三方平台代码不能借此获得动态安装执行权限。

## 1. Config Schema v1

Config 是 Aervox 自有 DSL，不是任意 JSON Schema，也不兼容 AstrBot 配置文件直接导入。[契约](../../packages/contracts/src/plugin-config-schemas.ts)与[共享作者校验器](../../packages/contracts/src/plugin-validation.ts)定义行为；配置注册、分发预检和作者 CLI 复用同一校验器。

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

**机器强制**：拒绝同层重复 key、保留对象键、无效正则、倒置的范围、重复选项和不符合类型/选项/自身约束的默认值；`secret` 禁止默认值。递归深度在进入递归 Schema 解析前检查。

**作者规则**：`secret` 仅放顶层；当前保存与状态回显只遍历顶层 Secret。嵌套 Secret、复杂对象数组应先提交契约用例再使用；共享校验不构成任意复杂默认值与迁移的完整证明。不要使用文件上传、模板列表或代码编辑器等未支持类型。

**升级兼容**：分发包激活在短事务内为新增字段补默认值，将移除的顶层字段保留到 `orphanedValues`，并保留已有 Secret。类型变化或已有值不再满足约束时拒绝自动激活；配置更名、复杂嵌套转换和业务数据迁移仍需明确方案，当前没有通用版本化迁移器。独立 Schema 注册接口不等于完整包升级流程，见 §8.3。

## 2. 配置存储与 API

当前为纯本地单用户。`LocalContext` 是本地调用上下文，部分内部参数名保留历史拼写不代表存在多租户边界；不得新增多租户契约。配置表以 `pluginId` 唯一，Page 以插件和 Page ID 关联，见 [SQLite Schema](../../packages/schema/src/plugin-config.ts) 与 [Repository](../../packages/repositories/src/repositories/sqlite/plugin-config-repository.ts)。

| HTTP 接口 | 行为 |
|---|---|
| `GET /v1/plugins/:id/config/schema` | 返回 `{schemaVersion, fields}`；没有 Schema 返回 404 |
| `PUT /v1/plugins/:id/config/schema` | 注册经过共享校验的完整 DSL，返回 `{schemaVersion, fields}`；`409 PLUGIN_PACKAGE_IMMUTABLE`，generation 包须重新打包升级 |
| `GET /v1/plugins/:id/config` | 返回 `revision/schemaVersion/values/secretFields/orphanedValues/issues` |
| `PUT /v1/plugins/:id/config` | 输入 `revision`、`values`、`secretValues`；校验失败 400，版本冲突 409 |
| `POST /v1/plugins/:id/config/reset` | 恢复默认值并清除该插件 Secret |

**机器强制**：普通值保存按已有顶层对象合并；省略字段保留旧值。Secret 输入位于 `secretValues`，省略保留、字符串写入、`null` 清除；API 只返回 `{configured: boolean}`。禁用插件的配置读写返回 `409 PLUGIN_DISABLED`。普通配置保存使用 SQL revision CAS，首次写入也检查 revision；保存与重置在同一写事务中复验用于校验的 Schema，升级期间的过期请求返回 `409 PLUGIN_CONFIG_REVISION_CONFLICT`，不会写入旧值或删除 Secret。成功保存递增 revision，保存/重置写审计。

五个 JSON 接口由[共享端点声明](../../packages/contracts/src/plugin-config-api.ts)生成宿主路由、OpenAPI 和客户端调用，并校验成功响应。Schema 注册与配置保存要求请求体，缺少或格式错误分别返回 `400 INVALID_CONFIG_SCHEMA`、`400 INVALID_CONFIG`；revision 为非负整数，`values` 为对象，`secretValues` 仅接受字符串或 `null`。Schema 读取仍可管理停用插件的声明；停用插件的配置读取、保存和重置保持 409。未分类服务端异常只返回通用 500，不回显内部路径或 SQL。

**边界**：当前 SQLite 组合根把配置与同库 Secret 的保存、重置放入同一短事务；旧 revision 返回 409 前不修改 Secret，事务失败保留完整旧版。[当前 Secret Repository](../../packages/repositories/src/repositories/sqlite/plugin-config-repository.ts)在本地 SQLite 保存原值，不具备默认静态加密或 OS Keychain 保证。此保证不覆盖外部 SecretStore；审计仍在事务后写入，不宣称“配置 + Secret + 审计”整体原子提交。回归见[配置 API 测试](../../apps/api/test/plugin-config.test.ts)。

**作者规则**：不得在日志、Skill、页面 URL、普通配置或导出包放置 Secret；避免发送不必要的原始数据；重置、升级与卸载前说明各自的数据影响并由用户发起。数据访问与删除责任继承 [DATA_PRIVACY](DATA_PRIVACY.md)，扩展不得自建数据库直写或绕开核心数据删除传播。

## 3. Page 与 Bridge

Page 元数据为 `id/title/description/entry/capabilities/checksum`。`id` 最长 64、匹配 `[A-Za-z0-9_-]+`；`entry` 必须以 `pages/<id>/` 开头。推荐 `pages/<id>/index.html`；页面资源必须打入包内。宿主使用 Manifest 声明的实际入口路径，嵌套入口中的相对脚本、样式和图片据此解析。`.../pages/:pageId/assets/index.html` 仍保留为解析实际入口的兼容别名，新代码不要依赖该别名改变相对资源基址。

| HTTP 接口 | 行为 |
|---|---|
| `GET /v1/plugins/:id/pages` | 列出 Page |
| `POST /v1/plugins/:id/pages` | 注册 Page，成功 201；generation 包返回 `409 PLUGIN_PACKAGE_IMMUTABLE` |
| `POST /v1/plugins/:id/pages/:pageId/assets` | `{files:[{path,contentBase64}]}`，单文件上限 5 MiB；generation 包返回 `409 PLUGIN_PACKAGE_IMMUTABLE` |
| `GET /v1/plugins/:id/pages/:pageId/assets/*` | 返回本地静态资源与 CSP |
| `GET /v1/plugin-pages/bridge.js` | 提供浏览器 Bridge 对象；页面须显式加载 |

### 3.1 Bridge 合同

| 方法 | 返回/行为 | 声明能力 |
|---|---|---|
| `ready()` | Promise，宿主 init 后解析上下文 | 无 |
| `getContext()` | 当前上下文或初始化前 `null` | 无 |
| `getConfig()` | Promise，配置快照 | `config.read`，宿主现有检查 |
| `saveConfig({values,secretValues})` | Promise，保存结果；revision 由宿主维护 | `config.write`，宿主现有检查 |
| `notify({type,message})` | Promise，可等待通知结果或失败 | `host.notify`，宿主强制检查 |
| `close()` | Promise，可等待关闭结果或失败 | `host.close`，宿主强制检查 |
| `onContext(handler)` | 返回取消订阅函数，接收当前会话的主题等上下文更新 | 无新增能力；不授予数据访问权 |

先 `await ready()`，再读取配置后编辑；不得自行发送猜测的 nonce 或绕过 Bridge。普通调用 15 秒超时；Page 应展示异常并允许用户重试。`saveConfig` 冲突时重新 `getConfig()`，再让用户决定合并，不能无限覆盖重试。

### 3.2 已有防护与未完成边界

[PluginPageDialog](../../surfaces/panels-ui/src/plugin/PluginPageDialog.vue)使用 `sandbox="allow-scripts allow-forms allow-downloads"`，未授予 `allow-same-origin`；资源响应设置 CSP：默认拒绝、脚本和样式允许本地及内联、图片允许本地及 `data:`、`connect-src 'none'`、`form-action 'none'`，另有 `nosniff/no-store/no-referrer`。这些是浏览器页面约束，不是 OS 进程沙箱。

[BundleStore](../../packages/host-runtime/src/modules/ecosystem/plugins/bundle-store.ts)同时检查相对资源路径、Page 与 Bundle 根的真实路径以及文件类型，拒绝符号链接文件与包外 Page 目录；不会拒绝所有未知扩展名。作者禁止链接文件、路径逃逸、远程资源和动态下载代码；路径检查不等于任意第三方执行隔离证明。

当前防护与剩余边界如下，发布安全评估必须分别覆盖：

- 宿主按 `event.source`、128 位随机 Nonce、插件/Page 身份与文档会话验证调用和迟到响应，SDK 只接受绑定父窗口及 Origin。逐项 capability 对配置、通知和关闭生效；文档刷新重新挂载并初始化配置 revision。
- 入口 HTML 与普通资源共用启用检查；当前窗口观察到禁用或缺包后立即销毁 iframe 并拒绝旧响应。其它窗口仍需收到更新后的插件状态，尚无跨窗口撤权实时推送。
- iframe 正在运行的代码没有统一 CPU/内存配额与撤权终止证明；不能把网络 CSP 解释为任意第三方执行安全已验收。
- API 启用 Bearer Token 认证时，当前 iframe `src` 和脚本资源没有注入 Authorization 头，资源请求会受到全局认证检查；尚无完整的受保护 Page 资源授权通道。不能将 Token 放入页面 URL 或为访问页面而关闭生产认证。

已实现防护与剩余缺口分别验收，不通过文字变更批准放宽 ADR-009，也不能宣称沙箱与资源配额已完全闭合。

## 4. 服务端会话回合插件体系（Server Turn Plugin Pipeline）

### 4.1 核心契约与执行生命周期

[ServerTurnPlugin](../../packages/host-plugin-api/src/turn-plugin.ts)定义 `id`、可选 `name`、`beforeTurn(ctx, config)` 和 `afterTurn(ctx, config, beforeResult)`。契约位于 `@aervox/host-plugin-api`（仅类型，零运行时依赖）；[本地出口](../../packages/host-runtime/src/modules/ecosystem/plugins/turn-plugins/types.ts)只做聚合，不再定义任何插件领域字段。上下文含 Turn/Session/Attempt ID、用户消息、`signal/deadlineEpochMs` 与窄端口（回合流读写 `stream`、可选 `llm`）；`LocalContext` 与仓储属宿主侧依赖，经 Runner 的宿主依赖注入，**不进入插件上下文**。后置状态为 `Completed/Failed/Interrupted`。

Hook 必须由 API 组合根 import 并注册到 [ServerPluginRegistry](../../packages/host-runtime/src/modules/ecosystem/plugins/turn-plugins/registry.ts)；仅在 Bundle 放置 `.ts/.js` 或 Manifest 字段不会激活 Hook。当前没有对第三方暴露的 Hook npm SDK、进程隔离或运行时代码热加载。第一方实现位于 `plugins/<id>/src/server`，由唯一装配点 [packages/host-runtime/src/plugin-assembly.ts](../../packages/host-runtime/src/plugin-assembly.ts) 以容错方式加载并注入其贡献（缺包或加载失败不中断宿主启动）。注册只按插件唯一 ID，不提供历史别名互查；需要旧配置迁移时由插件自己处理，不让宿主解释领域键。

装配器持有每次 Hook、HTTP 准入和 API 契约登记的注销函数；装配失败逆序释放已取得的贡献，正常装配由 API `onClose` 释放。重复注册身份或已有 Hook 冲突会拒绝本次装配，不替换原插件。HTTP 在挂载前检查整组路由冲突；框架挂载中途失败时关闭整组准入。Fastify 的物理路由不能运行时移除，残留入口返回 404；这不是动态代码卸载或第三方沙箱。

### 4.2 提示词动态插槽机制（Dynamic Extra Sections）

领域提示词通过 `beforeTurn` 返回 `extraSections: string[]`，由上下文构建器拼入回合；禁止向通用 Base Prompt 增加插件业务分支。插件私有语义一律经 `BeforeTurnResult.state`（回合内传递）与 Turn `metadata`（出站）自行承载，宿主通用契约不再为任何插件预留协议字段。

插件工具的使用指南经 `PluginToolContribution.guidance` 声明，由宿主合入内核既有的 `customGuidance` 通用注入位（见 `packages/core/src/base-prompt.ts`）；内核基础提示词不得为插件工具预留条目。工具贡献按插件启用状态与可用性门控后才进入模型工具面。

### 4.3 本地配置与运行时门控（Gating & Config Injection）

[Runner](../../packages/host-runtime/src/modules/ecosystem/plugins/turn-plugins/runner.ts)按注册顺序串行执行；仓储缺失、查询失败、无记录、停用或不可用均不运行。测试与自定义调用同样需要明确提供有效记录，不能把缺省依赖当作授权。配置来自已保存 `valuesJson`，未保存时可能为 `undefined`，Hook 必须自行提供默认值；它不是 Config Service 的完整快照，也不包含 Secret。

前置阶段保存配置快照供后置复用，后置执行前仍重新检查当前启用、可用性与持久执行代次。停用、可用性变化或替换插件会更换代次，重新启用也不能恢复旧 Hook 的迟到调用。每个 Hook 默认期限 15 秒；受信宿主可设置 `hookTimeoutMs`，范围为大于 0 且不超过 60 秒，父回合截止时间只能收紧该期限。记录查询、配置读取与 Hook 等待均有界，取消或超时后的迟到结果不再合入宿主。

`stream/llm` 窄端口在每次调用前后检查当前执行范围；流式写入完成异步准备后，在提交前再次检查。Hook 完成、异常或超时后，已捕获端口失效。作者须传播 `ctx.signal` 并遵守 `ctx.deadlineEpochMs`，不得保存端口供无主后台任务使用。异常按插件留痕；已接受的数据库写入不会因后续取消回滚。

这些机制提供协作取消与有界等待，不能强制终止同进程同步死循环，也不提供任意第三方代码隔离或业务幂等性。后置函数仍不自动成为可靠后台任务；耗时工作通过既有受信任务边界设计，不在数据库事务内执行外部 I/O。

### 4.4 结构化请求元数据契约（Structured Request Metadata）

底层 [useAervoxTurn](../../packages/api-client/src/useAervoxTurn.ts)与 Turn 协议支持 `metadata`；模式信息一律通过该结构传递，**禁止**向消息文本插入控制标签。

通用接缝为：[WorkbenchContext](../../packages/ui/src/composables/workbench-context.ts)的 `sendMessage(text, { metadata, resend })` 直接透传任意结构化元数据，宿主不解释其取值，也不为任何插件预留字段（原 `quizMode` 选项已删除）。携带元数据时消息变换器不再改写文本，避免语义双写。

### 4.5 HTTP、工具投影与事件贡献

`ServerPluginRegistration` 经 `@aervox/host-plugin-api` 声明 `turnPlugins`、`toolContributions(services)`、`httpEndpoints`、`replayScripts` 和可选 `registerApiContract()`。后者返回本次契约贡献的注销函数，由装配器持有；模块导入本身不得登记全局契约。宿主服务由 [plugin-host-services.ts](../../packages/host-runtime/src/plugin-host-services.ts) 将仓储封装为 `sessions`/`learningFacts` 意图级端口；插件不导入 Schema、Repositories、LibSQL 或宿主实时总线，报告载荷按不透明数据转发。

HTTP 适配负责鉴权、限流、本地上下文、出参包装、每请求生效检查及异常日志；门控和诊断出口都是必填。未生效返回 404 且不进入 handler，缺包不挂载端点。插件回放只在 `scripted-plugin` 等受信装配中提供，不能覆盖宿主内建模式。

OpenAPI 片段使用独立贡献注册表，惰性生成公共文档；非法路径和内核端点冲突忽略并告警，同一方法与路径的插件片段使用最后仍存活的登记，注销/重建须清理旧贡献。工具结果投影随 `PluginToolContribution.resultProjection` 声明，宿主只为该插件自有工具登记，跨插件同名抢注及对内核工具登记投影均拒绝。

`registerPluginApiContribution()` 返回幂等注销函数。每次登记有独立身份；注销不会删除其它宿主实例的同名贡献，后登记的覆盖贡献注销后恢复仍在场的前一贡献。登记与注销自动使 OpenAPI 缓存失效。契约登记持续到装配释放，用户停用只阻断执行入口；历史事件的识别和投影不因开关消失。工具结果投影仍使用宿主按工具归属登记的既有路径，不纳入本次契约注销。

插件流事件须显式登记；宿主写入前验证内核事件全集与插件已登记类型的并集，未知类型拒绝。当前受信写流端口仍能写内核事件，这是既有边界而非已实现的插件专属隔离；API Client 的通用插件出口会过滤内核事件。事件名和负载白名单不允许通过领域硬编码扩入内核。

专注模式 `record_practice_attempt` 的 `readOnly: true` 是已有的免逐次审批裁定，实际会写学习事实；它没有频次限制，不能作为其他写工具的审批范例，理由和残余风险见[工具定义](../../plugins/focus-mode/src/server/focus-tools.ts)。

## 5. 前端 UI 插槽扩展规范（UI Extension Slots）

### 5.1 插槽架构与清单

插槽类型以 [registry/types.ts](../../packages/ui/src/registry/types.ts) 为准，当前名称为：

| 位置 | 插槽 |
|---|---|
| 标题与导航 | `header:before`、`header:actions`、`nav:menu-items` |
| 侧栏与消息流 | `sidecards:widgets`、`conversation:top`、`conversation:bottom`、`message:bubble-actions` |
| 输入区 | `composer:toolbar-actions`、`composer:bottom-bar`、`composer:indicator` |
| 设置、抽屉、任务中心 | `settings:tabs`、`settings:conversation-rows`、`workbench:drawers`、`taskcenter:cards` |

插件实现（`plugins/<id>/src/ui`）只能经下列**公共子路径**接入宿主展示基座，禁止深链 `packages/ui/src/**`：

| 子路径 | 内容 |
|---|---|
| `@aervox/ui` | 组件库入口（不含插件实现） |
| `@aervox/ui/primitives` | 基础控件（按钮、对话框、抽屉、反馈） |
| `@aervox/ui/plugin-api` | 工作台上下文、插件状态与事件总线、UI 注册表与插件运行时契约 |
| `@aervox/ui/markdown` | Markdown 渲染 |
| `@aervox/ui/theme` | 主题 Token（全局样式） |

插件 UI 的**专属样式随实现内聚**（插件包内 `styles.css` 由插件 UI 入口引入）；宿主主题 `workbench.css` 只承载全局 Token 与通用布局，不得出现插件类名，插件也不得依赖宿主内部类名选择器。

`composer:indicator` 供插件渲染自有模式标记（宿主不再内建任何插件文案与样式）；`settings:conversation-rows` 供插件在「对话」分类注入自有设置行（宿主设置面板不内建插件行）。

### 5.2 注册接口与生命周期

`registerSlotComponent(slot, component, {id, priority, props})` 和别名 `registerSlotItem` 返回注销函数；也可传 `{component,id,priority,props}` 对象。同槽相同 ID 替换旧项，priority 降序排列。**作者规则**：ID 使用 `<pluginId>:<contribution>`、同插件内唯一，不依赖相同 priority 的跨插件顺序，不用他人 ID 覆盖贡献。

使用 setup 参数中的作用域 `registry`；不要通过全局 `uiRegistry` 或宿主 `context.registry` 登记插件贡献。[BuiltinUIPlugin](../../packages/ui/src/plugins/plugin-runtime.ts)的 `setup(registry, context, lifecycle)` 同步执行，可以返回清理函数或 `void`；成功的实例只 setup 一次。每次激活获得独立注册表和 Vue effect 作用域，自动回收通过该注册表登记的插槽、卡片、消息转换器、组件替换及同步创建的 Vue watcher。setup 中途失败也会回收已登记贡献，不影响其他插件。工作台上下文保持原对象身份，确保 Hook 与 Vue 控件共享插件自有状态。

外部计时器、连接和订阅通过 `lifecycle.effect(() => disposer)` 或 `lifecycle.onDispose(disposer)` 登记，例如 `lifecycle.onDispose(context.pluginEvents.on(handler))`；清理函数同步执行、幂等，单项抛错不阻断其它资源释放。`lifecycle.signal` 在停用或工作台销毁时中止；`onConfig(values, context, lifecycle)` 的异步工作必须观察该信号并在提交副作用前重验。普通异步回调和原始宿主对象不是自动撤权代理，作用域不能硬杀同进程代码。注销后的作用域注册表拒绝迟到注册；其 `clear()` 只清理自身贡献。

当前 runtime 只装配**组合根显式注入**的插件定义（`createWorkbenchPluginRuntime(registry, getContext, pluginDefinitions)`；宿主包内不内建任何具体插件）。插件是否生效统一由 `sync()` 依据仓储启停记录判定：**无记录、记录停用或不可用一律不启用（fail-closed）**，与服务端 Runner 同一判据；不再保留"离线默认可用"或历史别名互查。不得借此接入不受信代码。

运行时要求 `enabled === 1` 且可用；`getPluginState(id)` 区分 `disabled/activating/active/failed/disposed`，`isPluginAvailable()` 仅在成功激活时为真。setup 失败不拉取配置，下次同步可重试；迟到的配置快照不能回写新实例。`onDisable` 只在停用状态转换时调用；工作台销毁释放实例并中止信号，不调用 `onDisable`，避免把关闭窗口误当用户停用并清除已保存偏好。

插件状态通过 `pluginState` 的 `aervox-plugin-state:<pluginId>` 命名空间持有，旧配置仅在插件命名空间无记录时由插件迁入。宿主先等待插件同步，再读取 `quietStartup` 等通用启动诉求。状态绑定须随工作台换绑/解绑失效，缺少必要端口不能提前记为已初始化。

`applySlotPreset` 的项数不匹配时拒绝，首次应用记录恢复基线，预设本身不落盘；`restoreSlotPreset` 恢复并同步持久化基线，避免用户在预设期间换卡后重启得到另一布局。开关动作与恢复由插件调用，宿主不持有插件卡片 ID。

### 5.3 功能卡片注册与操作区扩展（Functional Cards & Side Cards）

`registerCard({id,label,description,icon,summary,action,extraComponent?,priority?})` 返回注销函数，也由插件作用域自动收集。卡片消费宿主状态和受控方法，不持有独立业务真源；`summary` 不做网络/数据库 I/O。旧注册的注销函数不能删除同 ID 的后来注册。

## 6. 核心组件替换契约（Component Overrides）

### 6.1 替换机制

`overrideComponent(name, component)` 返回注销函数，仅在宿主调用 `getComponent(name, fallback)` 的位置生效；不能任意替换所有 Vue 组件。当前明确消费的扩展点包括 `ComposerDock`。替换按登记顺序入栈，最近仍存活的替换生效；乱序停用不会复活已注销的旧替换，全部注销后使用 fallback。插件作用域自动收集替换；根注册表 `clear()` 清除整个工作台，作用域 `clear()` 仅清理自身贡献。替换输入组件仍须验证输入法、附件、语音与单次发送。

### 6.2 ComposerContractProps 契约规范

以 [ComposerContractProps](../../packages/ui/src/registry/types.ts) 为准：`input/streaming/isComposing/enterToSend/onSend` 为必需项，另有 `placeholder/onVoiceTrigger/onAttachmentPicker/onUpdateInput/'onUpdate:input'`。`onSend` 的选项是 `metadata/resend`，没有插件专属模式字段或附件对象参数。

提交只走一个通道：宿主提供 `onSend` 时调用一次，不同时 emit `send`。遵守输入法组合、流式、发送中与附件上传的宿主互斥；保留键盘、焦点、无障碍、语音与附件入口或明确限定替换范围。不能把示例简易 textarea 当作完整默认输入坞的功能等价实现。

### 6.3 消息变换管道（Message Transformers）

`registerMessageTransformer(id, transformer, priority)` 返回注销函数，按 priority 降序处理并逐项捕获异常。转换器可返回文本或 `{ text, metadata }`；metadata 同键由高优先级转换器胜出，宿主显式 metadata 优先。转换器应是快速纯函数，模式语义通过返回值表达，不修改输入上下文或插入技术前缀。它不是权限校验器，也不能替代宿主发送流程。

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
config.schema.json                    # 可选；默认根路径
SKILL.md                              # 可选；安装后技能名使用 pluginId
skills/acme-focus-card-review/SKILL.md # 可选；名称为全局唯一 ID
pages/dashboard/index.html            # 可选；必须在 Manifest 声明 Page
pages/dashboard/app.js
pages/dashboard/style.css
```

Manifest 根可声明宿主兼容区间：

```json
{
  "requires": {
    "hostApiVersion": { "min": "1.0.0", "maxExclusive": "2.0.0" }
  }
}
```

这是 `>= min` 且 `< maxExclusive` 的半开区间，边界使用完整稳定 SemVer；省略上界表示没有声明上界。旧包省略 `requires` 时默认宿主 API v1 区间，不改变已有 `metadata.version` 发布标签。发布标签的 SemVer 比较支持预发布版本；历史非 SemVer 标签无法排序，不能据此判定升降级。Bundle 宿主版本与 HTTP API、Config `schemaVersion`、根界面 `apiVersion` 分别管理，见[版本函数](../../packages/contracts/src/plugin-compatibility.ts)。

预检与安装共用同一技能集合。`spec.skills[]` 支持自定义 `entry` 文件入口与 inline `content`，同时声明时以 `entry` 为准；`spec.skill` 优先于根 `SKILL.md`/`skill.md` 回退，并以 pluginId 登记。显式引用的文件不会再被扫描登记为第二个技能，传统 `skills/<name>/SKILL.md` 路径按确定顺序发现。引用文件必须位于允许的声明资源路径且实际存在，不能把预检展示与安装登记分别解释。

当前不是全目录技能资产复制：不要假定 Skill 的 `scripts/` 或任意资源自动安装、自动执行。根技能名使用 pluginId；Skill name 必须匹配 `/^(?!\.{1,2}$)[\w.-]+$/`，使用 ASCII 字母、数字、下划线、点和短横线，排除单独 `.`/`..`，并使用插件前缀保证全局唯一。Service 在写入前拒绝不合格或重复名称，返回 409，不以 201 掩盖未登记的技能。

工具 ID 自动加 `<pluginId>.` 前缀，但工具 `name` 与技能名没有同等自动命名空间保证；作者使用唯一名称。`spec.tools` 只登记描述和 schema，受信组合根还需 `ToolRuntime.registerHandler`；无 handler 的工具调用会失败。`read_only/guarded/full_access` 是 Manifest 当前接受的枚举；它们没有完整映射到 Loop 使用的 `read_only/write_with_approval/privileged`。通用 [ToolRuntime](../../packages/host-runtime/src/modules/ecosystem/tools/runtime.ts) 的直接调用对非只读工具要求 approval，但[会话工具提供器](../../packages/host-runtime/src/modules/companion/conversation/tool-providers.ts)对 `guarded/full_access` 返回不支持级别的 `requires_approval`，不会仅凭包声明获得完整执行链。包内写工具还须由受信宿主显式映射/登记安全等级并验证审批链，单独注册 handler 不足以完成接入。API 会话组合根在工具发现及派发时重新读取插件生效状态，并逐项检查 `requiredPermissions` 的 permission/scope；参数不是有效数组、缺 Grant 或失效插件均拒绝。通用 Core Runtime 通过宿主传入的 `authorize` 回调复验，单独注册 handler 或绕过该组合根不自动获得等价权限检查。

### 8.2 安全门禁与安装前预检（Pre-install Inspection）

`POST /v1/plugins/inspect-package` 输入 `{packageBase64}`，返回摘要、包 SHA-256、权限/数据范围提示、贡献列表、已安装版本与 `isValid/issues`。安装端再次预检；HTTP JSON body 上限为 20 MiB，包含 Base64 开销，不等于展开后的包大小限制。

**机器强制**：归档结构和路径、声明资源允许清单、Manifest 已知字段、宿主兼容区间、Config 作者规则、声明的 Page/Skill 入口及重复名称均执行预检。工具 `requiredPermissions` 与 Page capability 纳入报告；报告不等于已授予权限，执行仍按实际 grant 门控。归档采用展开大小和条目数量上限（见 §8.3）。

**未实现**：全部静态资源依赖的可运行性校验、发布者签名认证、外部依赖版本解析和完整数据范围分析；`signature` 当前为 `null`。`isValid: true` 只表示已执行的静态检查通过，不代表功能可用或安全发布。

### 8.3 安装、覆盖与导出边界

[分发引擎](../../packages/host-runtime/src/modules/ecosystem/plugins/package-bundle.ts)先预检和有界解压，再将原始归档、Page 与 Skill 内容准备到独立 generation 目录，最后用 SQLite 短事务激活元数据及 `bundle_generation` 指针。事务内不解压或覆盖资源文件，完整责任与回退要求见 [ADR-028](adr/ADR-028-plugin-atomic-activation.md)。新安装成功返回 201；同 ID 且 `overwrite: false` 返回 `409 PLUGIN_ALREADY_EXISTS`。

`overwrite: true` 现在执行保留状态的升级：保留用户启停选择、已有配置、Secret 与授权记录，不恢复已撤销权限。新增字段补默认值，移除的顶层字段进入 `orphanedValues`；不兼容类型/约束变化拒绝自动迁移。激活前复验准备时的插件版本/代际、配置 Schema 和 revision，并发冲突返回 `409 PLUGIN_INSTALL_CONFLICT`，保留并发用户修改。新版 Skill 使用代际路径，不覆写 legacy skills 目录。低层 `POST /v1/plugins` 也不能覆盖 generation 包，返回 `409 PLUGIN_PACKAGE_IMMUTABLE`，避免元数据与原始归档失配。

资源准备失败或数据库事务失败时旧指针继续生效；提交后的进程退出留下已准备的新资源和完整登记。失败清理只作用于确认未被激活的代际；提交结果不确定时保留文件。旧代际保留至显式卸载，当前没有自动垃圾回收、运行失败后的自动降级或复杂配置迁移。进程退出验证不能代替硬件断电与实机文件系统验收。

**包资源不可变**：已激活 generation 包的 Config Schema、Page 注册及资源上传接口返回 `409 PLUGIN_PACKAGE_IMMUTABLE`；作者修改源码后重新打包升级。用户配置读写仍按 §2 执行。`GET /v1/plugins/:id/export` 对该类安装返回保存的原始归档字节，完整保留 Manifest、兼容要求和声明；它不是当前目录任意后续改动的快照，也不包含用户配置或 Secret。无原始归档的旧布局仍走兼容导出，不能宣称所有历史安装都能恢复原始包。

停用通过 `PATCH /v1/plugins/:id` 联动工具/技能及已装配主动规则。显式卸载清理登记、Config/Secret/Page，并只删除带宿主所有权标记的 generation 与已登记 legacy Page 资源；未知 legacy 文件和目录保留，不推断其归属。内存 Hook/handler 随宿主编译，卸载包不等于动态卸载任意代码。作者仍须验证监听器、待执行动作与访问路径的收敛。

**作者规则**：保留原始包、完整源码、SHA-256、权限与变更说明，在临时数据环境验证升级、冲突和失败恢复。安装失败恢复不等于旧程序兼容新版资源路径，回退宿主先遵循 ADR-028；涉及核心库的恢复另按[迁移与回滚指南](../how-to/run-database-migration-drill.md)执行。

**归档边界**：解压分配前检查压缩包 20 MiB、展开总量 50 MiB、单条目 5 MiB、最多 2048 条目，拒绝不安全或重复路径。所有声明入口在激活前验证；回归见[分发测试](../../apps/api/test/plugin-distribution.test.ts)、[升级测试](../../apps/api/test/plugin-upgrade.test.ts)与[提交进程退出测试](../../packages/repositories/test/plugin-installation.test.ts)。

### 8.4 官方出厂与内置插件集市（Built-in Market）

[出厂同步](../../packages/host-runtime/src/modules/ecosystem/plugins/index.ts)扫描 `plugins/*`，同步主记录、根 Skill、Config 与主动声明；没有执行任意包内代码，也不等同完整包导入（工具/Page 贡献需走分发安装验证）。API 启动发现缺失、无效或不可读的 `installSource=builtin` 插件时，仅更新可用性状态，保留用户开关、配置、Secret 与授权记录；恢复包不会恢复已撤销授权（见[缺包回归](../../apps/api/test/builtin-plugin-absence.test.ts)）。

集市 `GET /v1/plugins/market` 当前来自本地出厂目录，不是远程公共插件商店；`POST /v1/plugins/market/:id/install` 走该目录打包安装，内部固定 `overwrite: true`；对已安装插件执行集市安装/更新时使用 §8.3 的代际准备与原子激活，保留状态并检查并发冲突。就地打包与构建期导出共用同一份**允许清单**（只收 Manifest、Config、Skill 与 `skills/`、`pages/` 资源；排除 `src/`、`dist/`、`node_modules/`、`test/`、构建配置），两份清单的一致性由 `apps/api/test/plugin-bundle-allowlist.test.ts` 机器断言。更新提示采用版本字符串是否不同，不是 SemVer 新旧判断。根 `mise tasks run package-plugins` 批量生成 `dist-plugins/<id>-<version>.aervox-plugin`（等价 `pnpm package:plugins`）；脚本先运行共享作者校验，再打包；不执行功能或签名安全认证。产物字节可重现（ZIP 条目时间戳固化、目录与条目排序），同源码重复打包的 SHA-256 稳定；`dist-plugins/` 是 gitignore 产物，测试不得依赖它，需分发包时经导出端点现场生成。

### 8.5 主动规则、MCP 与授权

主动声明支持最多 20 个 sensors / 20 个 triggers；触发类型为 `system_state/fatigue_high/drift_high/health_sleep_low/commitment_due`，可附受限 DSL。感知授权使用 `permission=proactive.sensor`、`scope=sourceId`，安装本身不授予此权限；材料化、冷却、免打扰、撤权等遵循主动智能既有契约。`sourceId` 字符串不创建新设备驱动，`quietHoursPolicy=bypass` 声明也不代表无条件越过内核策略。

原始登记接口 `POST /v1/plugins` 会执行额外 DSL 静态验证；分发安装路径当前没有复用完全相同的验证流程。作者必须在主动 DSL 测试与 Worker 执行路径验证规则，不能只依据 Manifest 可解析判定可运行。证据见 [API 生命周期测试](../../apps/api/test/proactive-plugin-lifecycle.test.ts)与 [Worker 派发测试](../../apps/worker/test/proactive-plugin-dispatch.test.ts)。

MCP 使用独立[服务适配器](../../packages/host-runtime/src/modules/ecosystem/mcp/service.ts)，工具 ID 为 `mcp__<serverId>__<toolName>`，注册归属为 `mcp:<serverId>`。连接、Token、网络与工具授权在 MCP 流程管理，不随任意引用它的 Bundle 自动授予或撤销；发布说明必须列明这些外部依赖及数据去向。Skill 文本不能提升工具、MCP 或 OS 权限。

## 9. 验证与发布清单

| 验证范围 | 当前回归证据 | 不应据此推断 |
|---|---|---|
| Bundle 预检、原子激活、冲突、状态保留与原包导出 | [plugin-distribution.test.ts](../../apps/api/test/plugin-distribution.test.ts)、[plugin-upgrade.test.ts](../../apps/api/test/plugin-upgrade.test.ts)、[plugin-installation.test.ts](../../packages/repositories/test/plugin-installation.test.ts) | 签名、自动降级、复杂迁移或硬件断电验收 |
| Config 校验、并发 CAS、同库 Config/Secret 原子保存与重置 | [plugin-config.test.ts](../../apps/api/test/plugin-config.test.ts)、[配置激活竞态测试](../../apps/api/test/plugin-config-activation-race.test.ts)、[atomic-edits.test.ts](../../packages/repositories/test/atomic-edits.test.ts) | Secret 静态加密、外部 SecretStore 补偿、全 Page 撤权 |
| 工具与权限登记 | [tools-plugins.test.ts](../../apps/api/test/tools-plugins.test.ts) | 任意工具声明自动提供 handler 或 grant 强制检查 |
| Hook 有界等待、取消与后置门控 | [turn-plugin-lifecycle.test.ts](../../apps/api/test/turn-plugin-lifecycle.test.ts)、[turn-plugin-cancel-integration.test.ts](../../apps/api/test/turn-plugin-cancel-integration.test.ts) | 第三方隔离、同步死循环强制终止或业务幂等 |
| Page 来源/会话/capability 与销毁 | [plugin-page-bridge.test.ts](../../apps/api/test/plugin-page-bridge.test.ts)、[plugin-page-dialog.test.ts](../../surfaces/panels-ui/test/plugin-page-dialog.test.ts) | 完整 Token 资源通道或全局撤权实时推送 |
| 作者 CLI 与 API 结构兼容 | [plugin-cli.test.mjs](../../scripts/plugin-cli.test.mjs)、[OpenAPI compatibility tests](../../scripts/openapi-compat.test.mjs) | 任意协议语义兼容或真实平台验收 |
| UI 注册/清理/配置竞态 | [ui-registry.test.ts](../../packages/ui/test/ui-registry.test.ts)、[plugin-registration.test.ts](../../plugins/focus-mode/test/plugin-registration.test.ts) | 任意第三方 Vue 热加载或安全沙箱 |

发布审查逐项确认：

- 标明目标宿主 Git commit/版本、适用 Web/桌面范围、作者与许可证；明确第一方或 Page 路径。
- Manifest/Config/文件布局通过共享校验；作者补充资源依赖、命名空间、功能与迁移验证。
- 声明每项权限、真实数据去向、外部服务、Secret 保管和卸载影响；高权限能力不借声明绕过授权。
- 在临时数据环境完成安装→逐项功能→禁用→启用→卸载→重装；覆盖升级另做备份/恢复验证。
- UI 贡献验证无重复挂载/发送、无残留副作用；Page 验证缺权限、Bridge 超时、旧版本冲突/并发保存和浏览器 CSP。
- 受信 Hook/工具验证未启用、无授权、错误和重复执行边界；不能用静态元数据测试替代真实调用。
- 运行[指南中的验证命令](../how-to/develop-plugin-ui-extension.md#5-运行验证并交付)，关联 CAP-020 或实际业务 CAP，在 PR 链接实现和验证证据；源码变更遵循功能分支与 PR 门禁。

本规范定档后，机器强制项变化须同步契约、实现、测试与本文；作者约束升级为执行机制须补负向验证。扩大不受信执行范围、引入第三方 Host、改变核心数据权利或治理架构必须记录重大边界 ADR，文档编辑本身不构成该批准。

## 代码缺席与数据责任（CR-056）

停用、撤权、代码缺席、显式卸载和显式数据清理是不同操作。启动扫描遇到缺包、不可读根目录或非法清单时，必须阻断相应执行并保留安装记录、配置、Secret、授权历史和恢复诊断，不能调用卸载清理推断用户意图。恢复有效包只恢复实现的可用性，不能恢复已撤销权限或改变用户开关。数据导出/删除入口必须在实现退出后继续可用。

内存注册与持久数据分开管理，注册释放绑定实例代际且幂等；双 App 不共享隐式全局注册表。显式卸载继续遵循本文既有流程；Config/Secret 的同库原子保存与重置已由 PR #258 落实，外部 SecretStore 补偿仍须独立定义。本节为已接受契约，来源为 CR-056（已归档至 Aervox-docs-archive）；后续实施证据直接关联 PR，能力状态变化时更新追踪基线。

## 归档资源与 Skill 所有权

插件、Skill 和 Persona 的 API 压缩/解压统一使用共享 Worker 池：最多 2 个操作并行，单次期限 10 秒；压缩输入最多 20 MiB、累计展开最多 50 MiB、单条目最多 5 MiB、最多 2048 个条目。超时或取消终止 Worker 并释放容量，池满立即失败。解包同时校验目录声明、实际输出大小和 CRC；ZIP64、重复规范化路径、绝对路径和路径穿越均拒绝。归一化后的重复与父目录冲突按大小写无关比较，文件路径不能充当其他条目的父目录；冲突在解压和替换旧文件前拒绝，不受条目顺序影响，返回路径保留原拼写。正常的显式目录及其后代仍可共存。Persona 内嵌的 Skill ZIP 消耗外层剩余展开/条目预算。HTTP 请求中断或响应连接提前关闭会取消准备中的归档操作，嵌套归档沿用同一信号；正常接收完请求体不构成取消。插件安装在准备阶段及激活前检查取消；越过数据库提交边界后完成已接受的修改，不因断连中途停止提交。代际准备与激活保证见 §8.3；Skill/Persona 的其他归档写入不自动获得该插件升级保证。

Skill 安装保留 `./` 前缀与反斜杠路径的规范化兼容，忽略 `__MACOSX`；绝对路径在规范化之前拒绝。`overwrite` 只允许覆盖本地可写 Skill，不能覆盖注册表中插件所有或只读的同名项。目录所有权检查覆盖整个目标目录及其祖先、后代注册：本地名称与插件 ID 相撞、旧注册相互重叠、未登记的非空目录或符号链接均拒绝写入和递归删除。插件安装及本地多技能安装在变更前检查全部声明，API 内同一技能根目录的安装、同步与删除串行执行；插件卸载只清理由该插件登记的技能目录，不因同名插件不存在而删除本地技能。仓储更新必须维持原 `pluginId` 所有权；同一所有者可以更新元数据，不能借注册转移所有权。冲突返回 409，原目录与注册保留；不自动迁移或合并既有冲突数据。
