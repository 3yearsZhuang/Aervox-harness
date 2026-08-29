# 规划文档：在设置插件面板中集成 Skill（技能）与 MCP（模型上下文协议）/ 工具配置能力

- 提出人：Antigravity · 2026-08-29
- 状态：Draft / Planning
- 关联需求：`CAP-020`、`T-04`、`AST-04`、`PET-05`、`CR-006`

## 1. 背景与目标

当前 Aervox 的设置界面中包含「插件」面板（`PluginManagerPanel.vue`），主要用于管理已安装插件的启停、JSON Schema 配置及插件页面（Pages）。
后端服务已经完整落地了：
1. **Skill 模块（CAP-020）**：支持基于 Anthropic 规范的技能目录结构（`SKILL.md` + 元数据）、ZIP 压缩包安装、启停（`active` 状态）、`SKILL.md` 正文内容读取、只读保护与删除等（`GET/POST/PATCH/DELETE /v1/skills*`）。
2. **工具注册表与 MCP 运行时（T-04 / AST-04 / PET-05）**：支持工具的动态注册、分类、安全级别（`read_only` / `write_with_approval` / `privileged`）、参数 Schema（`input_schema`）、启停开关（`enabled`）、删除以及 MCP 形态调用（`POST /v1/tools/:id/call`、`GET /v1/tools/mcp/list`）。

本方案的目标是在设置界面的「插件」面板中，扩展增加 **Skill（技能库）** 和 **MCP / 工具（Tools）** 的统一管理与配置能力，形成「插件生态三位一体」的管理中枢。

---

## 2. 用户交互与 UI 架构设计

### 2.1 二级 Tab 导航布局
在 `PluginManagerPanel.vue` 顶部增加二级 Tab 切换：
1. **🧩 插件 (Plugins)**：现有的插件列表、启停开关、配置 (Config) 与页面 (Page) 入口；
2. **⚡ 技能 (Skills)**：查看所有技能（系统内置、插件内置、自定义上传）、查看技能 Markdown 详情、启停控制、上传 ZIP 安装新技能、删除自定义技能；
3. **🛠️ MCP / 工具 (MCP & Tools)**：查看所有已注册的内部工具与 MCP Tools、启停控制、注册自定义 MCP Server / 工具、在线调试与测试调用工具。

### 2.2 视觉与交互规范
- **设计风格**：沿用 Aervox 现有的玻璃拟态与柔和毛玻璃设计（`var(--bg-soft)`, `var(--border)`, `var(--accent)`, `var(--accent-soft)`），支持明暗主题；
- **操作反馈**：使用 `Element-Plus`（`ElMessage`、`ElMessageBox`）进行状态提示和二次确认操作。

---

## 3. 详细设计与改动范围

### 3.1 `packages/api-client` 客户端 API 扩展

在 `packages/api-client` 中新增/导出技能与工具的组合式 API Hook 与 TypeScript 类型定义：

1. **`useAervoxSkills`** (`packages/api-client/src/useAervoxSkills.ts`)：
   - `skills`：响应式技能列表；
   - `loadSkills(activeOnly?: boolean, source?: string)`：获取技能列表（`GET /v1/skills`）；
   - `getSkillContent(name: string)`：获取 SKILL.md Markdown 全文（`GET /v1/skills/:name/content`）；
   - `setSkillActive(name: string, active: boolean)`：启停技能（`PATCH /v1/skills/:name`）；
   - `installSkillZip(zipBase64: string, name?: string, overwrite?: boolean)`：上传 ZIP 安装（`POST /v1/skills`）；
   - `deleteSkill(name: string)`：删除技能（`DELETE /v1/skills/:name`）；
   - `getSkillPrompt()`：获取渐进式披露提示词（`GET /v1/skills/prompt`）。

2. **`useAervoxTools`** (`packages/api-client/src/useAervoxTools.ts`)：
   - `tools`：响应式工具列表；
   - `loadTools()`：获取工具注册表全量（`GET /v1/tools`）；
   - `setToolEnabled(id: string, enabled: boolean)`：启停工具（`PATCH /v1/tools/:id`）；
   - `registerTool(tool: RegisterToolInput)`：注册新工具 / MCP 工具（`POST /v1/tools`）；
   - `unregisterTool(id: string)`：注销工具（`DELETE /v1/tools/:id`）；
   - `callTool(id: string, args: unknown, approval?: boolean)`：在线测试调用工具（`POST /v1/tools/:id/call`）；
   - `loadMcpList()`：获取 MCP 格式工具列表（`GET /v1/tools/mcp/list`）。

3. 导出索引更新 (`packages/api-client/src/index.ts`)。

---

### 3.2 `packages/ui` 前端组件开发与重构

1. **`PluginManagerPanel.vue`**
   - 增加二级 Tab 状态切换（`tab = 'plugins' | 'skills' | 'mcp'`）；
   - 插件 Tab 保持既有逻辑；
   - 引入并展示 `SkillManagerTab` 与 `McpToolsTab`。

2. **`SkillManagerTab.vue`**
   - 顶部操作栏：标题说明 + 隐式文件上传 input +「上传技能 (ZIP)」按钮；
   - 技能卡片列表：
     - 图标与标题、标识名；
     - 来源徽标 Badge：`本地安装 (local)` / `插件内置 (plugin)` / `AI 自主 (ai_authored)`；
     - 状态标签与启停 Switch 开关（调用 `setSkillActive`）；
     - 「查看说明」按钮（打开 `SkillContentDialog` 渲染 Markdown）；
     - 「删除」按钮（只对 `source !== 'plugin'` 且非 readonly 的技能展示，并弹出二次确认）。
   - 上传 ZIP 冲突处理：若返回 409 冲突，提示用户是否覆盖（`overwrite: true`）。

3. **`SkillContentDialog.vue`**
   - 弹窗展示技能元数据与 `SKILL.md` 正文；
   - 使用 `@aervox/ui` 现有的 `renderMarkdown` 渲染 Markdown 内容；
   - 支持一键复制正文内容。

4. **`McpToolsTab.vue`**
   - 顶部操作栏：说明文案 +「注册 MCP 工具」按钮；
   - 工具卡片列表：
     - 工具 ID 与名称、分类（`memory` / `search` / `learning` / `system` / `external` 等）；
     - 安全等级 Badge：`只读安全 (read_only)` / `需授权 (write_with_approval)` / `特权 (privileged)`；
     - 启停 Switch 开关（调用 `setToolEnabled`）；
     - 「参数结构 (Schema)」查看按钮；
     - 「测试调用」按钮（打开 `ToolCallDialog`）；
     - 「注销」按钮（内置工具禁用注销，插件/自定义工具允许注销）。

5. **`ToolCallDialog.vue`**
   - 弹窗输入 JSON 格式的调用参数（基于工具的 `inputSchemaJson` 提供预设或示例）；
   - 选择是否携带 `approval: true` 授权；
   - 点击「执行调用」，发送至 `/v1/tools/:id/call`；
   - 展示调用响应结果（格式化 JSON），区分成功与错误高亮。

6. **`McpRegisterDialog.vue`**
   - 支持快捷注册自定义工具 / MCP Server 工具：
     - 工具 ID / 名称 / 描述 / 分类 / 安全等级；
     - 参数 JSON Schema 输入。

7. 导出与注册：
   - 在 `packages/ui/src/index.ts` 导出新组件。

---

## 4. 依赖分析与验证计划

### 4.1 模块依赖关系
- `packages/contracts`：提供数据类型与 Schema 约束；
- `packages/api-client`：新增 `useAervoxSkills.ts` 与 `useAervoxTools.ts`；
- `packages/ui`：Vue 组件层，被 `apps/desktop` 与 `apps/web` 引用；
- `apps/api`：现有后端路由无需破坏性变更，现有 `/v1/skills*` 与 `/v1/tools*` 已完全覆盖所需功能。

### 4.2 验证步骤与测试用例
1. **类型与打包测试**：
   - 运行 `pnpm --filter @aervox/api-client build` 与 `pnpm --filter @aervox/ui build`；
   - 运行 `pnpm --filter apps/desktop typecheck` 与 `pnpm --filter apps/web typecheck`。
2. **功能与交互验证**：
   - 在设置 -> 插件中切换 Tab（插件、技能、MCP/工具）；
   - **技能 Tab 验证**：
     - 正确加载展示既有技能；
     - 切换技能启停开关，检查列表刷新与状态持久化；
     - 点击「查看说明」，验证 Markdown 正常解析与高亮显示；
     - 点击「上传技能」，上传包含 `SKILL.md` 的 `.zip` 压缩包，验证安装成功；
     - 测试删除自定义技能；验证插件只读技能受到删除保护；
   - **MCP / 工具 Tab 验证**：
     - 正确加载展示现有内部工具（如 `aervox_memory_store` 等）；
     - 切换工具启停开关，验证状态更新；
     - 点击「测试调用」，输入测试参数执行调用，验证成功返回执行结果；
     - 测试注册新的外部工具并验证出现在列表中。
3. **CI 门禁**：
   - 运行 `mise tasks run ci-code` 和 `mise tasks run ci-docs` 确保全面通过。
