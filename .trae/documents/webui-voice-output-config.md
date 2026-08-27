# WebUI 语音输出配置 · 阶段 1：设置中配置本地语音模型

> 提出人：3yearszhuang · 2026-08-28
> 修改人：3yearszhuang · 2026-08-28
> 类型：Plan

## 摘要

为系统**语音输出**能力（系统核心能力：`apps/api/src/modules/voice/`）在 WebUI 设置中补齐**本地语音模型配置**能力：

在 WebUI 设置新增"语音"分类，面向 **gpt-sovits-local 本地语音模型**配置：本地模型路径（受 `allowedRoots` 白名单约束）、模型 ID、音色/语音文件（speaker），并支持**试听**。持久化到数据库新增表 `voice_configs`，经新增 API 读写；保存后同步更新本地 provider 的生效配置。

按用户反馈，**此阶段先只做设置里的本地语音模型配置**；"人格编辑块选择语音文件"顺延为阶段 2（见`后续阶段`）。

## 现状分析

- **系统语音模块** `apps/api/src/modules/voice/`：本地 provider `GptSovitsLocalProvider` 的 `modelPath/modelId/speakerIds` 由 env（`GPT_SOVITS_MODEL_PATH` 等）在[启动时写死](file:///Users/linge/Documents/Workspace/Aervox-harness/apps/api/src/modules/voice/index.ts#L18-L32)；[voice-port.ts](file:///Users/linge/Documents/Workspace/Aervox-harness/modules/persona-plugin/src/voice-port.ts#L56-L67) 的 `validateLocalPath` 用 `allowedRoots` 白名单校验路径（须在根内且存在）。**无运行时/持久化的本地语音配置**。
- 现有路由 `GET /v1/voice/models`、`POST /v1/voice/synthesize`（[routes.ts](file:///Users/linge/Documents/Workspace/Aervox-harness/apps/api/src/modules/voice/routes.ts#L13-L47)）；`registerVoiceModule(app, options)` **[未接收 db](file:///Users/linge/Documents/Workspace/Aervox-harness/apps/api/src/modules/voice/index.ts#L34-L41)**。
- **DB 约定**：DDL 集中在 `src/schema/init.ts`；仓储接口在 `repositories/types.ts`、实现在 `repositories/sqlite/`，由[模块注入 `AervoxDatabase`](file:///Users/linge/Documents/Workspace/Aervox-harness/apps/api/src/modules/persona/index.ts#L28) 实例化。
- **WebUI 设置**位于 [AervoxWorkbench.vue](file:///Users/linge/Documents/Workspace/Aervox-harness/packages/ui/src/components/AervoxWorkbench.vue#L128-L135)（categories 侧栏 + 详情区）。契约 schema 注册于 [openapi.ts](file:///Users/linge/Documents/Workspace/Aervox-harness/packages/contracts/src/openapi.ts#L361-L362)，由 `scripts/generate-openapi.ts` 生成 `openapi.json`。

## 变更方案

### 1. `packages/database` — 本地语音配置持久化

- 新增 `src/schema/voice.ts`（在 `src/schema/index.ts` 导出）：表 `voice_configs`
  - `id TEXT PK`、`workspace_id`、`subject_user_id`、`enabled INTEGER`、`provider_id TEXT`、`model_path TEXT`(可空)、`model_id TEXT`、`speaker_id TEXT`(可空)、`settings_json TEXT`、`created_at`、`updated_at`
  - 唯一索引 `voice_configs_tenant_unique_idx` on `(workspace_id, subject_user_id)`（每租户一行）。
- 在 `src/schema/init.ts` 末尾追加 `CREATE TABLE IF NOT EXISTS` + 唯一索引（新库直接建，老库兼容）。
- `repositories/types.ts` 新增接口 `IVoiceConfigRepository`：`getConfig(tenant)` / `saveConfig(tenant, data)`（upsert，复用 `assertTenantContext`）。
- 新增实现 `repositories/sqlite/voice-config-repository.ts`；在 `repositories/sqlite/index.ts` 导出。
- 单测 `test/voice-config.test.ts`（空→save→get 回显、更新覆盖）。

### 2. `packages/contracts` — 契约

- 新增 `localVoiceConfigSchema`：`{ enabled:boolean, providerId: string, modelPath?: string, modelId: string, speakerId?: string, settings?: record }`（本地 provider= `gpt-sovits-local`），及其 response schema。
- 在 `src/openapi.ts` register 并 `registerPath`：
  - `GET /v1/voice/config`（返回当前本地语音配置，缺省按 env 给默认）
  - `PUT /v1/voice/config`（body = localVoiceConfigSchema）
- 运行 `generate-openapi.ts` 重新生成 `openapi.json`。

### 3. `apps/api` — 系统级 Voice 模块扩展（本地模型可配置）

- [voice-port.ts / gpt-sovits](file:///Users/linge/Documents/Workspace/Aervox-harness/apps/api/src/modules/voice/gpt-sovits.ts)：暴露本地 provider 的 `allowedRoots`（供路由校验 modelPath），并提供 `reconfigure({modelPath, modelId})` 以在保存后更新生效配置；`validateLocalPath` 保持白名单 + 存在校验。
- [index.ts](file:///Users/linge/Documents/Workspace/Aervox-harness/apps/api/src/modules/voice/index.ts)：`registerVoiceModule(app, db, options)` 新增 `db`，实例化 `SqliteVoiceConfigRepository` 注入 `VoiceService`。
- [service.ts](file:///Users/linge/Documents/Workspace/Aervox-harness/apps/api/src/modules/voice/service.ts)：注入仓库，新增 `getLocalConfig(tenant)` / `setLocalConfig(tenant, cfg)`（保存后对本地 provider `reconfigure`，并以其 `allowedRoots` 校验 `modelPath`）。
- [routes.ts](file:///Users/linge/Documents/Workspace/Aervox-harness/apps/api/src/modules/voice/routes.ts)：新增 `GET/PUT /v1/voice/config`。
- [app.ts](file:///Users/linge/Documents/Workspace/Aervox-harness/apps/api/src/app.ts#L77)：改为 `registerVoiceModule(app, db, options.voiceOptions)`。
- 集成测试 `test/voice-config.test.ts`（或并入 `voice.test.ts`）：get/set、白名单外路径 400、保存后本地 provider 生效。

### 4. `packages/api-client` — 组合式 API

- 新增 `src/useAervoxVoice.ts`：`getConfig()`、`saveConfig(body)`、`loadLocalVoices()`（`GET /v1/voice/models` 过滤本地/available）、`synthesize({providerId,modelId,speakerId,text})`；导出 `LocalVoiceConfigDto`。在 `src/index.ts` 导出。

### 5. `packages/ui` — WebUI 设置「语音」

- 新增 `src/components/voice/LocalVoiceConfigPanel.vue`：本地模型路径输入（保存时后端按 `allowedRoots` 校验）、模型 ID 输入、音色下拉（本地模型 `speakerIds` 或手动）、启用开关、**试听**按钮（`synthesize` → base64→Blob→`<audio controls>`）。
- `AervoxWorkbench.vue`：`settingCategories` 新增 `{id:'voice', label:'语音', description:'本地语音模型'}` + 图标；详情区新增 `settingsCategory==='voice'` 分支挂载该面板，打开加载当前配置、保存调用 `saveConfig`。
- `src/index.ts` 导出 `LocalVoiceConfigPanel`。

### 6. 文档登记（AGENTS.md 硬约束）

- 新增 `docs/reference/changes/CR-011-voice-config-webui.md`（文档头字段 + 签名；结构性变更同步 `docs/DOC_REGISTRY.md` 与 `docs/README.md`）。
- 更新 `docs/reference/REQUIREMENTS_TRACEABILITY.md` §4.2 落地登记（本地语音模型配置，实现位置、日期 2026-08-28、验证方式）。

## 后续阶段

- 远程 provider 运行时配置：将 `gpt-sovits-remote` 及其他远程 TTS provider 接入设置「语音」分类（按 provider 抽象配置表单），当前仍由 env 管理（本阶段范围外）。

## 假设与决策

- 本阶段设置只配置**本地语音模型**（`gpt-sovits-local`）；远程 provider 仍由 env 管理，后续再扩展。
- `modelPath` 必须落在 `allowedRoots` 白名单（服务端校验）且路径存在，否则 400。
- 保存后同步本地 provider 生效配置（`reconfigure`）。
- speakerId 为空表示用模型默认音色。

## 验证

1. `mise x -- pnpm --filter @aervox/database test`（voice-config 单测）。
2. `mise x -- pnpm --filter @aervox/contracts build`（重新生成 `openapi.json`）。
3. `mise x -- pnpm --filter @aervox/api test`（voice-config 集成 + openapi-contract）。
4. `mise tasks run ci-code`。
5. 手工冒烟：`./aervox dev web` → 设置→语音→填本地路径/模型→试听→保存→刷新回显；白名单外路径被拒。
6. `mise tasks run ci-docs`。