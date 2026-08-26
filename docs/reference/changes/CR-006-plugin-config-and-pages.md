# CR-006 插件配置解析与可视化（Config + Page）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-26

> 文档编号：CR-006
> 类型：Reference
> 版本：v0.1
> 更新日期：2026-08-26
> 状态：Review Candidate
> 关联：[插件 Config 与 Page 规范](../plugin-config-and-pages.md)、[能力组合与可选化目录规范](../capability-composition.md)、[ADR-009](../adr/ADR-009-electron-plugin-sandbox.md)、[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md)

- 状态：Implemented（待发布评审）
- 提出人 / 日期：Codex / 2026-08-26
- 目标版本：当前开发阶段（CAP-020 插件能力扩展）
- 变更原因与证据：插件安装后缺少配置解析、可视化编辑与页面承载能力。参考 AstrBot 插件配置与插件页面指南（AGPLv3，仅借鉴公开设计、不复制代码、不引入运行时），结合 `ADR-009` 与 `AVX-CAP-001` 的沙箱与最小权限要求，为 Aervox 定义自有 Config Schema v1 与受限 Page Bridge。
- 关联能力与需求：`CAP-020`、`FR-PLG-001`～`FR-PLG-004`、`RISK-006`
- 当前行为 / 目标行为：
  - 当前：插件仅有生命周期、权限、工具与 Skill 联动，无配置解析与 UI；
  - 目标：插件 Bundle 可声明 Config Schema 与 Page；设置页新增「插件」分类，支持配置表单、secret 状态管理、重置与 Page iframe 打开；配置值按 `(workspaceId, subjectUserId, pluginId)` 持久化并做 revision CAS。
- 范围外：插件自有后端路由、文件上传、SSE、远程资源、完整进程外 Plugin Host、AstrBot Schema 兼容导入。
- UX/API/数据/AI/安全/隐私影响：
  - API：新增 `/v1/plugins/:pluginId/config*` 与 `/v1/plugins/:pluginId/pages*`、`/v1/plugin-pages/bridge.js`；
  - 数据：新增 `plugin_configs`、`plugin_config_secrets`、`plugin_pages` 三张表，`plugins` 表增加 `config_schema_json/config_schema_version` 列；
  - 安全：Page iframe 使用 `sandbox="allow-scripts allow-forms allow-downloads"`，禁止 same-origin/顶层导航/popups；静态资源仅限已安装 Bundle，路径穿越与符号链接逃逸被拒绝；secret 永不回显；
  - 隐私：配置读写、重置、启停与 Page 打开写入 `AuditRecord`；卸载时按删除规则清理配置、secret 与 Page。
- 迁移与向后兼容：新表全部 `CREATE TABLE IF NOT EXISTS`；旧库自动补列；无 Config/Page 声明的既有插件行为不变；既有 `/v1/plugins` 路由不改动。
- 测试、埋点和验收影响：`packages/database/test/plugin-config.test.ts`、`apps/api/test/plugin-config.test.ts`；契约与 Config 解析单测；UI 通过 `@aervox/ui` typecheck/build 与 Web/Desktop build 验证。
- 风险与成本：secret 本地默认实现为明文落库（不对外回显），生产必须注入加密 SecretStore Port；iframe 页面默认无网络，能力受限属预期。
- 灰度、回滚和用户通知：功能随 API/UI 一起发布；可关闭「插件」分类展示回退，不影响既有插件生命周期 API。
- 决策：Implemented
- 修改人 / 日期：
- 更新的文档和测试：`docs/reference/plugin-config-and-pages.md`、`docs/reference/SRS.md`、`docs/reference/PRD.md`、`docs/reference/ARCHITECTURE.md`、`docs/reference/DATA_PRIVACY.md`、`docs/reference/THREAT_MODEL.md`、`docs/DOC_REGISTRY.md`、`docs/README.md`
- 发布后结果：待发布
