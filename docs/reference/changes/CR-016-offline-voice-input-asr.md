# CR-016 离线语音输入（SenseVoice/Whisper 双模式 + 句子级断句 + 键盘自停）

- 提出人：Antigravity · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

> 文档编号：CR-016
> 类型：Reference
> 版本：v0.1
> 更新日期：2026-08-28
> 状态：Review Candidate
> 关联：[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md)、[ADR-005 内部 Provider Port](../adr/ADR-005-provider-port.md)、[CR-014 WebUI 语音配置](../changes/CR-014-voice-config-webui.md)、[dsh-voice-local 参考实现](https://github.com/Real-WangLe/dsh-voice-local)

- 状态：Implemented（待发布评审）
- 提出人 / 日期：Antigravity / 2026-08-28
- 目标版本：当前开发阶段（系统语音输入与交互增强）
- 变更原因与证据：参考开源项目 `dsh-voice-local` 的离线语音转写交互范式，系统需要全程离线、低延迟、高准确度的语音输入能力，并在输入框中支持句子级静音断句实时插入与键盘打字自动停止录音机制。
- 关联能力与需求：`CAP-019/020`、`ADR-005`
- 当前行为 / 目标行为：
  - 当前：仅支持语音合成输出（TTS），对话输入框只支持手动键盘输入；
  - 目标：
    1. 支持 SenseVoice 本地轻量离线模型与 OpenAI Whisper 兼容端点双模式 ASR；
    2. 浏览器端支持自适应噪声底跟踪、250ms 前置环形缓冲保护与静音断句实时转写插入；
    3. 支持键盘打字/粘贴/输入法自动关闭麦克风；
    4. 设置「语音」分类中提供 ASR 配置，展示离线模型存在状态（未下载/已就绪），支持一键下载离线模型权重，并持久化至 SQLite `voice_input_configs` 表（租户隔离）。
- 范围外：流式双向全双工语音对讲（后续版本迭代）。
- UX/API/数据/AI/安全/隐私影响：
  - API：新增 `GET/PUT /v1/voice/input/config`、`GET /v1/voice/input/model/status`、`POST /v1/voice/input/model/download` 与 `POST /v1/voice/transcribe`；
  - 数据：新增 `voice_input_configs` 表（租户唯一索引 `voice_input_configs_tenant_unique_idx`）；
  - 安全：本地模型路径经白名单校验；
  - 隐私：音频数据不出本机或仅发送至用户配置的自建兼容端点。
- 迁移与向后兼容：新表使用 `CREATE TABLE IF NOT EXISTS`，平滑向后兼容。
- 测试、埋点和验收影响：`packages/database/test/voice-config.test.ts`、`apps/api/test/voice-config.test.ts`、`packages/api-client/test/voice-input.test.ts`。
- 决策：Implemented
- 更新的文档和测试：`docs/DOC_REGISTRY.md`、`docs/README.md`、`docs/reference/REQUIREMENTS_TRACEABILITY.md`（§4.2 落地登记）

---

## 核查记录（2026-08-28）：全库「吞错误」专项排查

PR #53 合入后补充了一次全库代码审查，排查「把真实错误吞成成功响应（`catch → 200`）、或将错误文案当正常业务数据返回」的同类问题。

- **结论**：无其他同类问题。此前唯一实例为 `POST /v1/voice/transcribe`（catch 内返回 200 并将错误提示作为 `text` 插入输入框），已在 PR #57 整改为真实错误返回 `503 / VOICE_INPUT_PROVIDER_UNAVAILABLE`。
- **已核查并判为正确**：
  - API 路由（llm / persona / skills / voice / learning）：catch 均映射为 4xx/5xx 或 rethrow，不吞错误；
  - Worker（outbox / deletion / diary）：catch 走 Outbox/dead-letter 或状态置 `failed`，属标准异步错误处理；
  - `packages/agent-loop`：工具错误以 `ok:false + error` 结果模型返回（符合 ADR 契约），流解析失败仅跳过该块；
  - `packages/api-client` 列表加载失败返回 `[]` 属非关键数据静默降级，不改变 HTTP 语义。
- **验证**：`mise tasks run ci-code` + `ci-docs` 通过；PR #57 已合入 main。

## 安全整改记录（2026-08-28，PR #57）

- `POST /v1/voice/transcribe`：真实错误改返 `503 / VOICE_INPUT_PROVIDER_UNAVAILABLE`，不再吞成 200 文案插入输入框（OpenAPI 已声明 503 响应）；
- SenseVoice：模型未就绪/加载失败改为抛错由路由 503，降级提示不再污染输入框；
- `setVoiceInputConfig`：`whisper-compatible` 的 endpoint 保存时校验为合法 http(s) URL（对齐 LLM baseUrl `new URL` 校验先例）。
