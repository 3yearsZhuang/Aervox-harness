# 插件 Config 与 Page 规范

> 文档编号：AVX-PLUG-001
> 类型：Reference
> 版本：v0.1
> 更新日期：2026-08-26
> 状态：Review Candidate
> 责任角色：技术负责人
> 关联：[CR-006](changes/CR-006-plugin-config-and-pages.md)、[能力组合与可选化目录规范](capability-composition.md)、[ADR-009](adr/ADR-009-electron-plugin-sandbox.md)、[AI 质量与安全规范](AI_QUALITY_SAFETY.md)

本文是插件配置与页面的运行时契约与实现规范。设计参考 [AstrBot 插件配置指南](https://docs.astrbot.app/dev/star/guides/plugin-config.html) 与 [插件页面指南](https://docs.astrbot.app/dev/star/guides/plugin-pages.html)（AGPLv3，仅借鉴公开设计），Aervox 以自有版本化 DSL 作为唯一事实源，不做 AstrBot 格式兼容导入。

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

## 4. 验证

- `packages/database/test/plugin-config.test.ts`：租户隔离、CAS、reset、secret 状态、Page 元数据；
- `apps/api/test/plugin-config.test.ts`：Schema 注册/校验、保存/回显保护、409 冲突、重置、Page 资源与路径穿越、Bridge SDK、卸载清理；
- `mise tasks run ci-code` 与 `mise tasks run ci-docs`。
