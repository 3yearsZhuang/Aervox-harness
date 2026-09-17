---
id: CR-053
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 1.0.0
updated_at: 2026-09-17
reviewed_at: 2026-09-17
review_interval_days: 90
sources:
  - docs/reference/PRD.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/reference/ARCHITECTURE.md
---

# CR-053 llama.cpp 本地模型作为底层能力接入与模型能力探测预算适配

- 提出人：3yearszhuang · 2026-09-17
- 修改人：3yearszhuang · 2026-09-17

关联：[PRD](../PRD.md) · [需求追踪基线](../REQUIREMENTS_TRACEABILITY.md) · [架构设计](../ARCHITECTURE.md)

- 状态：Accepted（已评审）/ Implemented（已实现）
- 提出人 / 日期：3yearszhuang / 2026-09-17
- 目标版本：R 迭代（本地模型能力补充）
- 关联能力：`CAP-002` / `CAP-020` / `CAP-033` / 基础设施（LLM 接入）

## 1. 变更原因与证据

现有 LLM 接入体系（CR-012 + CR-034/CR-042）已统一抽象 `ModelProviderPort`（`@aervox/agent-loop`）
与 OpenAI 兼容流式 Provider，配置层支持 `ollama / deepseek / openai / anthropic / custom_openai`
五种 `providerType`。但存在以下缺口：

- **llama.cpp（llama-server）未被作为一等本地 Provider 预设**：只能通过泛化
  `custom_openai` 手工填写 `http://127.0.0.1:8080/v1`，本地降级阶梯（L1 候选判定）
  与快捷配置均不感知 llama.cpp；
- **缺乏模型能力感知**：本地端点上下文窗口未知时，`maxTokens` 可能超出上下文总长
  导致请求直接被拒；本地小模型工具调用能力差异无标注；
- 桌面端/工作台「本地优先」路径（CAP-033 私密计算域）需要明确：本地模型是**底层能力**
  而非可卸载插件，保障降级阶梯（L0→L1→L2）、SSRF 防护与主动画像隐私边界自动覆盖。

## 2. 当前行为 vs 目标行为

| 维度 | 当前行为 | 目标行为（本 CR） |
| :--- | :--- | :--- |
| 本地 llama.cpp 接入 | 仅 `custom_openai` 手工填写 | 一等 `llamacpp` providerType 预设（默认 `http://127.0.0.1:8080/v1`） |
| L1 本地候选判定 | loopback URL 或 `providerType === "ollama"` | 增加 `providerType === "llamacpp"` |
| 连通性测试 | 仅探测 `/models` 与回退生成 probe | 顺带探测能力：`/props`（n_ctx）、`/models/{modelId}`（meta.context_length），标注上下文窗口与工具支持 |
| 预算适配 | `maxTokens` 固定取配置或 L1×2048 | 探测得的上下文窗口作为上界 clamp，预留 1024 tokens 给 system prompt 与工具 schema |
| 配置 UI | 供应商下拉无 llama.cpp；无模型自动感知 | 新增 llama.cpp 预设；测试连接后自动列出可用模型一键填充；能力标注展示 |

未变更：推理协议仍为 OpenAI 兼容 Chat Completions（无新增 Provider 实现）；`ModelProviderPort`
端口契约不变；远程端点不做工具能力假设；SSRF/`redirect` 防护沿用既有实现。

## 3. 受影响范围与契约

- `packages/contracts`：`llmProviderTypeSchema` 增加 `"llamacpp"`；
  `llmTestConnectionResponseSchema` 增加 `capabilities`（`contextWindow` / `supportsToolCalls`）；
  `openapi.json` 由 `generate:openapi` 同步；
- `apps/api`：
  - `modules/ecosystem/llm/service.ts`：默认预设 + `probeModelCapabilities`（`/props`、`/models/{id}` meta）；
  - `modules/ecosystem/llm/degradation-service.ts`：L1 本地候选纳入 llamacpp；
  - `modules/companion/conversation/llm-adapter.ts`：`maxTokens` 按 `settings.contextWindow` clamp；
- `packages/api-client`：LLM DTO 类型扩展 + `PRESET_PROVIDERS` 新增 llama.cpp 预设；
- `packages/ui`：`LLMConfigPanel.vue` 能力标注与可用模型自动感知；
- 无数据库表变更（`settings` 为既有 JSON 自由字段，能力写入 `settings.contextWindow`）。

OpenAPI：`POST /v1/llm/test-connection` 响应新增 `capabilities`。

## 4. 验证与测试标准

- `apps/api/test/llm-config.test.ts`：llamacpp 预设保存、能力探测（mock `/models` + `/props`）、
  best-effort 不阻断；
- `apps/api/test/llm-degradation-service.test.ts`：llamacpp 纳入 L1 本地候选降级；
- `packages/api-client/test/llm.test.ts`：`PRESET_PROVIDERS` 含 llama.cpp 预设；
- `packages/ui`：全量 71 项测试通过；
- 门禁：`./aervox ci all` 全量终审通过（code + docs）。

## 5. 回滚条件与应急方案

- 配置维：不启用 llamacpp 预设即回退到既有行为（`providerType` 枚举新增不破坏旧值）；
- 能力探测为 best-effort：任何探测失败仅返回 `undefined`，不阻断主连通性测试；
- 预算适配仅在 `settings.contextWindow` 有效性时生效，无效时沿用原 `maxTokens` 逻辑；
- 无迁移脚本与 schema 变更，删除本 CR 相关改动即可整体回滚。
