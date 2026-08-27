# CR-012 WebUI 大语言模型与供应商配置（设置 + 连通性测试 + 租户持久化）

- 提出人：Antigravity · 2026-08-28
- 修改人：Antigravity · 2026-08-28

> 文档编号：CR-012
> 类型：Reference
> 版本：v0.1
> 更新日期：2026-08-28
> 状态：Review Candidate
> 关联：[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md)、[ADR-005 内部 Provider Port](../adr/ADR-005-provider-port.md)、[CR-011 WebUI 语音配置](../changes/CR-011-voice-config-webui.md)

- 状态：Implemented（待发布评审）
- 提出人 / 日期：Antigravity / 2026-08-28
- 目标版本：当前开发阶段（系统 LLM 运行时模型路由与供应商管理）
- 变更原因与证据：此前系统大语言模型（LLM）调用参数主要由环境变量与后端硬编码默认值管理，WebUI 设置面板中缺乏对大语言模型供应商（Ollama、DeepSeek、OpenAI、Anthropic、自定义 OpenAI 兼容接口）的可视化配置、连通性探测以及租户级持久化支持。参考已落地的 Voice / Persona 仓储与契约规范，将 LLM 供应商参数接入设置「模型与服务」分类。
- 关联能力与需求：`CAP-020`、`ADR-005`
- 当前行为 / 目标行为：
  - 当前：WebUI 设置面板无模型与供应商配置分类，无法在前端动态切换供应商、修改 API Key / Base URL / 模型名称与高级采样参数；
  - 目标：
    1. 设置新增「模型与服务」分类，面向 Ollama（本地免 Key）、DeepSeek、OpenAI、Anthropic 以及自定义 OpenAI 兼容端点配置 `providerType`、`baseUrl`、`apiKey`、`modelId`、`temperature`、`maxTokens`；
    2. 持久化到新增表 `llm_configs`，经 `GET/PUT /v1/llm/config` 读写，按 `(workspace_id, subject_user_id)` 租户隔离（Upsert）；
    3. 新增 `POST /v1/llm/test-connection` 连通性测试接口，在前端直观展示连接可用性与响应延时。
- 范围外：复杂多模型 Fallback 路由策略规则引擎（后续演进）。
- UX/API/数据/AI/安全/隐私影响：
  - API：新增 `GET /v1/llm/config`、`PUT /v1/llm/config`、`POST /v1/llm/test-connection`；
  - 数据：新增 `llm_configs` 表（唯一索引 `llm_configs_tenant_unique_idx`，每租户一行）；
  - 安全：API Key 按租户加密/隔离存储；密码框支持显隐切换；
  - 隐私：配置按租户严格隔离，不跨租户可见。
- 迁移与向后兼容：新表采用 `CREATE TABLE IF NOT EXISTS`，默认使用 Ollama 预设，缺省平滑兼容。
- 测试、埋点和验收影响：`packages/database/test/llm-config.test.ts`、`apps/api/test/llm-config.test.ts`、`packages/api-client/test/llm.test.ts`。
- 风险与成本：第三方供应商服务不可达或网络波动可能导致连通性测试失败（UI 呈现明确错误信息）。
- 决策：Implemented
- 更新的文档和测试：`docs/DOC_REGISTRY.md`、`docs/README.md`、`docs/reference/REQUIREMENTS_TRACEABILITY.md`（§4.2 落地登记）
