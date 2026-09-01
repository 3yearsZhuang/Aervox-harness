# CR-029 模型 / 语音多预设与「你的思隅」设置页

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

> 文档编号：CR-029
> 类型：Reference
> 版本：v0.1
> 更新日期：2026-08-28
> 状态：Review Candidate
> 关联：[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md)、[CR-015 WebUI 模型配置](../changes/CR-015-llm-provider-config-webui.md)、[CR-014 WebUI 语音配置](../changes/CR-014-voice-config-webui.md)、[CR-028 在线语音模型配置](../changes/CR-028-voice-remote-model-config.md)

- 状态：Implemented（待发布评审）
- 提出人 / 日期：3yearszhuang / 2026-08-28
- 目标版本：当前开发阶段（设置体验整合与多预设管理）
- 变更原因与证据：「模型与服务」与「语音」此前各维持**单份配置**（每租户一行、PUT 覆盖），用户切换供应商/音色需反复改写同一配置且无法保留多套常用组合；「人格设定」已具备成熟的多预设机制（personas 表 + 激活标记 + 卡片式管理）。本 CR 将同款多预设机制引入模型与语音，并将「对话 / 人格设定 / 模型与服务 / 语音」四个设置项收敛为侧边第五项「你的思隅」。
- 关联能力与需求：`CAP-020`、`ADR-005`、`CR-011`、`CR-014`、`CR-015`、`CR-016`、`CR-028`
- 当前行为 / 目标行为：
  - 当前：LLM / 语音配置为单行 upsert；四个设置分类散落在「详细设置」弹窗内；
  - 目标：
    1. `llm_configs`、`voice_configs`、`voice_input_configs`、`voice_remote_configs` 均升级为每租户多行（多预设）：新增 `name`（预设名）与 `is_active`（激活标记），部分唯一索引保证每租户至多一行激活；
    2. 新增多预设 API：`GET/POST /v1/llm/presets`、`POST/DELETE /v1/llm/presets/:id(/activate)` 与同款 `/v1/voice/presets` 端点，语音预设聚合本地输出 / 在线输出 / 输入三表按名对齐；
    3. 保留既有 `GET/PUT /v1/llm/config`、`/v1/voice/config`、`/v1/voice/remote/config`、`/v1/voice/input/config` 语义（读写当前激活预设），运行时消费方（agent-executor / plan-generation / diary / transcribe）零侵入；
    4. 前端「模型与服务」「语音」面板改为预设卡片管理（新建 / 设为当前 / 删除），复用 PersonaManagerPanel 同款交互；
    5. 侧边菜单新增第五项「你的思隅」，打开设置弹窗并限定显示「对话 / 人格设定 / 模型与服务 / 语音」4 个分类；「详细设置」保留其余分类。
- 范围外：预设导出/导入、跨设备预设同步、预设排序拖拽（后续演进）。
- UX/API/数据/AI/安全/隐私影响：
  - API：新增 `/v1/llm/presets`、`/v1/voice/presets` 系列端点；
  - 数据：四表新增 `name` / `is_active` 列；唯一索引由 `tenant_unique_idx` 迁移为普通租户索引 + 部分唯一激活索引（`init.ts` DDL 幂等迁移，旧库自动补齐列并 DROP 旧唯一索引）；
  - 安全：API Key 仍按租户隔离存储；预设删除需前端二次确认；
  - 隐私：预设严格按租户隔离，不跨租户可见。
- 迁移与向后兼容：`initDatabaseSchema` 内幂等完成（ADD COLUMN + DROP INDEX + 重建索引），已存在单行配置自动成为「默认配置」预设；旧版读写端点语义（激活配置）保持不变，存量调用方零改动。
- 测试、埋点和验收影响：`packages/database/test/llm-config.test.ts`（新增 5 项预设用例）、`apps/api/test/llm-config.test.ts`（新增 4 项预设 API 用例）等。
- 风险与成本：三张语音表预设按 `name` 聚合，新建预设会在三表各建占位行以保证身份一致；SQLite 部分唯一索引要求每次激活走事务内先清后设，避免冲突。
- 决策：Implemented
- 更新的文档和测试：`docs/DOC_REGISTRY.md`、`docs/README.md`、`docs/reference/REQUIREMENTS_TRACEABILITY.md`（§4.2 落地登记）
