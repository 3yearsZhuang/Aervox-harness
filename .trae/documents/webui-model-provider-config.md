# WebUI 模型与供应商配置 · 实现方案

- 提出人：Antigravity · 2026-08-28
- 修改人：Antigravity · 2026-08-28
- 类型：Plan
- 关联：[需求追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)、[ADR-005 内部 Provider Port](docs/reference/adr/ADR-005-provider-port.md)、[CR-011 语音输出配置](docs/reference/changes/CR-011-voice-config-webui.md)

## 1. 摘要与背景

当前 Aervox 的 WebUI 设置面板中已支持「外观」、「对话」、「人格设定」、「专注」、「提醒」、「语音」、「插件」等分类，但在大语言模型（LLM）与供应商配置方面仍缺乏用户端可视化运行时配置与持久化管理。

本方案旨在为 WebUI 设置中新增**「模型与服务」**（`model`）配置分类，支持：
1. **大语言模型与供应商配置**：提供常用预设（Ollama / 本地模型、DeepSeek、OpenAI、Anthropic、自定义 OpenAI 兼容接口），支持配置 `providerType`、`baseUrl`、`apiKey`、`modelId`、`temperature`、`maxTokens` 等运行时参数。
2. **服务端 DB 持久化**：在 SQLite 数据库中新增 `llm_configs` 表，按 `(workspace_id, subject_user_id)` 租户作用域隔离持久化（Upsert），提供 `GET/PUT /v1/llm/config` API，支持多端与后续对话模块按需路由。
3. **连通性测试（Test Connection）**：提供 `POST /v1/llm/test-connection` 接口，向目标端点发起轻量级探测或 ping 检查，并在前端直观展示响应时延与连接状态。
4. **前端配置面板与组合式 API**：新增 `@aervox/ui` 组件 `LLMConfigPanel.vue`，配合 `@aervox/api-client` 的 `useAervoxLLM` 组合式函数，集成到 `AervoxWorkbench.vue`。

---

## 2. 现状分析与架构对齐

- **数据层约定**（`packages/database`）：
  - 表结构集中在 `src/schema/`（新增 `src/schema/llm.ts`，导出至 `src/schema/index.ts`）；
  - DDL 集中在 `src/schema/init.ts` 中通过 `CREATE TABLE IF NOT EXISTS` 实现幂等迁移；
  - 仓储接口定义在 `src/repositories/types.ts`，SQLite 实现在 `src/repositories/sqlite/` 中，统一支持 `TenantContext` 租户断言与隔离。
- **契约层约定**（`packages/contracts`）：
  - 使用 Zod 定义请求/响应 Schema，并在任何 Schema 创建前确保已调用 `extendZodWithOpenApi(z)`；
  - 在 `src/openapi.ts` 中注册路由元数据，通过 `scripts/generate-openapi.ts` 生成 `openapi.json`。
- **API 模块单体约定**（`apps/api`）：
  - 遵循 ADR-014 演进式模块单体组织，新增 `src/modules/llm/`（包含 `service.ts`、`routes.ts`、`index.ts`），并在 `app.ts` 中通过 `registerLLMModule(app, db)` 统一注册。
- **客户端与 UI 约定**（`packages/api-client` & `packages/ui`）：
  - API 封装在 `useAervoxLLM.ts` 中，使用统一 `Transport` 解耦通信；
  - UI 使用 Vue 3 `<script setup lang="ts">`，样式符合工作台主题变量规范，图标基于 `lucide-vue-next`。

---

## 3. 详细实现计划与文件变更

### 3.1 `packages/database` — 数据模型与仓储实现

1. **新建表定义**：`packages/database/src/schema/llm.ts`
   - 定义 `llmConfigs` 表：
     - `id`: `text("id").primaryKey()`
     - `workspaceId`, `subjectUserId`: 租户隔离列（来自 `tenantColumns`）
     - `enabled`: `integer("enabled").notNull().default(1)`
     - `providerType`: `text("provider_type").notNull()`（例如 `"ollama" | "deepseek" | "openai" | "anthropic" | "custom_openai"`）
     - `baseUrl`: `text("base_url").notNull()`
     - `apiKey`: `text("api_key")`（可空，Ollama/本地模型不需要）
     - `modelId`: `text("model_id").notNull()`
     - `temperature`: `real("temperature").notNull().default(0.7)`
     - `maxTokens`: `integer("max_tokens").default(4096)`
     - `settingsJson`: `text("settings_json", { mode: "json" }).notNull().default({})`
     - `createdAt`, `updatedAt`: 时间戳列（来自 `timestampColumns`）
   - 唯一索引：`llm_configs_tenant_unique_idx` on `(workspaceId, subjectUserId)`
2. **导出与建表**：
   - 在 `packages/database/src/schema/index.ts` 导出 `llmConfigs`；
   - 在 `packages/database/src/schema/init.ts` 中追加 `CREATE TABLE IF NOT EXISTS llm_configs (...)` 与唯一索引。
3. **仓储接口与实现**：
   - 在 `packages/database/src/repositories/types.ts` 新增 `LLMConfigModel`、`LLMConfigSaveInput` 和 `ILLMConfigRepository` 接口；
   - 新增 `packages/database/src/repositories/sqlite/llm-config-repository.ts`：实现 `getConfig(tenant)` 与 `saveConfig(tenant, input)`（支持基于租户的 Upsert）；
   - 在 `packages/database/src/repositories/sqlite/index.ts` 导出 `SqliteLLMConfigRepository`；
   - 在 `packages/database/src/index.ts` 导出相关类型与仓储。
4. **单测验证**：
   - 新增 `packages/database/test/llm-config.test.ts`：覆盖首次获取（null）、保存配置、获取回显、更新覆盖与租户隔离断言。

---

### 3.2 `packages/contracts` — API 契约与 OpenAPI 规范

1. **Schema 定义**：`packages/contracts/src/llm-schemas.ts`（并在 `src/index.ts` 导出）
   - `providerTypeEnumSchema`: `z.enum(["ollama", "deepseek", "openai", "anthropic", "custom_openai"])`
   - `llmConfigSchema`: 包含 `enabled`、`providerType`、`baseUrl`、`apiKey`、`modelId`、`temperature`、`maxTokens`、`settings`
   - `llmConfigResponseSchema`: 与 `llmConfigSchema` 一致，缺省时支持提供默认配置响应
   - `llmTestConnectionRequestSchema`: 包含 `providerType`、`baseUrl`、`apiKey`、`modelId`
   - `llmTestConnectionResponseSchema`: `{ ok: boolean; latencyMs: number; message: string; availableModels?: string[] }`
2. **注册 OpenAPI 路由**：`packages/contracts/src/openapi.ts`
   - `GET /v1/llm/config`：读取当前租户大模型与供应商配置
   - `PUT /v1/llm/config`：保存/更新当前租户大模型与供应商配置
   - `POST /v1/llm/test-connection`：测试模型供应商连接通畅性
3. **构建产物生成**：
   - 运行 `scripts/generate-openapi.ts` 重新生成 `packages/contracts/openapi.json`。

---

### 3.3 `apps/api` — 服务端 LLM 模块与路由

1. **模块结构**：创建 `apps/api/src/modules/llm/`
   - `types.ts`：定义内部选项与测试连接入参/返回值类型；
   - `service.ts`：`LLMConfigService`
     - `getConfig(tenant)`: 读取当前租户配置（若无则返回默认预设配置）；
     - `saveConfig(tenant, input)`: 校验 URL 格式并 Upsert 到 `SqliteLLMConfigRepository`；
     - `testConnection(tenant, params)`: 根据 `providerType` 与 `baseUrl` 发送轻量 probe 请求（例如针对 OpenAI/Ollama/DeepSeek 兼容端点请求 `/models` 或发送 max_tokens=1 的轻量 ping 请求），统计 `latencyMs` 并捕获错误返回友好诊断提示。
   - `routes.ts`：注册 Fastify 路由：
     - `GET /v1/llm/config`
     - `PUT /v1/llm/config`
     - `POST /v1/llm/test-connection`
   - `index.ts`：导出 `registerLLMModule(app: FastifyInstance, db: AervoxDatabase): LLMConfigService`。
2. **应用集成**：
   - 在 `apps/api/src/app.ts` 导入并调用 `registerLLMModule(app, db)`。
3. **集成测试**：
   - 新增 `apps/api/test/llm-config.test.ts`：测试获取默认配置、保存配置并回显、测试连通性 mock 路由以及 OpenAPI 合规性校验。

---

### 3.4 `packages/api-client` — 客户端组合式 API

1. **新建 Composable**：`packages/api-client/src/useAervoxLLM.ts`
   - 定义 DTO 接口：`LLMConfigDto`、`LLMTestConnectionInput`、`LLMTestConnectionResultDto`；
   - 提供预置供应商选项列表常量 `PRESET_PROVIDERS`（包含预置 Base URL 与推荐模型名称）：
     - Ollama / 本地模型 (`http://127.0.0.1:11434/v1`, 推荐 `llama3.2`, `qwen2.5`)
     - DeepSeek (`https://api.deepseek.com/v1`, 推荐 `deepseek-chat`, `deepseek-reasoner`)
     - OpenAI (`https://api.openai.com/v1`, 推荐 `gpt-4o`, `gpt-4o-mini`)
     - Anthropic (`https://api.anthropic.com/v1`, 推荐 `claude-3-5-sonnet-20241022`)
     - 自定义兼容接口 (`http://...`)
   - 暴露函数：
     - `getConfig()`: Promise<LLMConfigDto>
     - `saveConfig(body)`: Promise<LLMConfigDto>
     - `testConnection(params)`: Promise<LLMTestConnectionResultDto>
2. **导出**：在 `packages/api-client/src/index.ts` 导出 `useAervoxLLM` 及相关类型与常量。

---

### 3.5 `packages/ui` — WebUI 设置面板与工作台集成

1. **新建配置组件**：`packages/ui/src/components/llm/LLMConfigPanel.vue`
   - 包含视觉规范的表单布局：
     - **供应商选择**：下拉或 Segmented 选择器（Ollama / DeepSeek / OpenAI / Anthropic / 自定义）；选择后可自动填充默认 Base URL 与推荐模型列表；
     - **Base URL 字段**：带有 placeholder 与验证提示；
     - **API Key 字段**：带显示/隐藏（Eye / EyeOff）按钮与安全提示（本地 Ollama 提示无需填 Key）；
     - **模型标识 (Model ID)**：支持快捷选择常用模型（`<datalist>`）或自定义输入；
     - **高级参数折叠项**：Temperature（0.0 ~ 2.0 滑块/数字输入）、Max Tokens；
     - **操作栏**：
       - 「测试连接」按钮（带加载状态、成功/失败提示及延时 `latencyMs` 徽章）；
       - 「保存配置」按钮（带加载状态与 `已保存` 闪烁反馈）。
2. **更新工作台**：`packages/ui/src/components/AervoxWorkbench.vue`
   - 引入 Lucide 图标 `Bot` 或 `Cpu`；
   - 在 `settingCategories` 列表中添加：
     `{ id: 'model', label: '模型与服务', description: '大语言模型与供应商配置', icon: Bot }`（推荐放置在「对话」或「人格设定」附近）；
   - 在设置右侧详情区域中增加 `LLMConfigPanel` 的条件渲染分支：
     `<LLMConfigPanel v-else-if="settingsCategory === 'model'" class="settings-section" />`；
3. **导出组件**：在 `packages/ui/src/index.ts` 导出 `LLMConfigPanel`。

---

### 3.6 文档与需求追踪（AGENTS.md 硬约束）

1. **新建 CR 记录**：`docs/reference/changes/CR-012-llm-provider-config-webui.md`
   - 完整填写提出人、修改人、文档头元数据（类型：Reference，版本：v0.1）；
   - 记录变更背景、范围、架构与安全性（API Key 隔离与脱敏）、迁移与测试要求。
2. **同步索引**：
   - 在 `docs/DOC_REGISTRY.md` 与 `docs/README.md` 注册 `CR-012`；
3. **追踪登记**：
   - 在 `docs/reference/REQUIREMENTS_TRACEABILITY.md` §4.2 落地登记表追加一行：关联 `CAP-020` / `ADR-005`，记录实现位置、日期 `2026-08-28` 及验证指令。

---

## 4. 验证计划与测试步骤

1. **数据层测试**：
   - 运行 `mise x -- pnpm --filter @aervox/database test`，验证 `llm-config.test.ts` 全部通过。
2. **契约与 OpenAPI 校验**：
   - 运行 `mise x -- pnpm --filter @aervox/contracts build` 确认 OpenAPI 文档生成无歧义。
3. **API 服务层测试**：
   - 运行 `mise x -- pnpm --filter @aervox/api test`，验证 `llm-config.test.ts` 及 `openapi-contract.test.ts` 均通过。
4. **全库代码与文档门禁**：
   - 运行 `./aervox ci`（包含 `ci-code` 与 `ci-docs`），确保无 TypeScript 类型错误、Lint 错误或文档规范警告。
5. **Web 端手动交互验收**：
   - 启动 `./aervox dev`，在 Web 浏览器打开工作台；
   - 点击右上角设置 -> 选择「模型与服务」；
   - 切换不同供应商预设（如 Ollama / DeepSeek），修改 Base URL / API Key / Model ID；
   - 点击「测试连接」，观察连通性结果与延迟反馈；
   - 点击「保存」，刷新页面验证配置数据持久化与回显准确。
