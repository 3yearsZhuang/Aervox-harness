---
id: CR-028
type: reference
scope: change
owner: architecture
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 0.1.0
updated_at: 2026-08-29
reviewed_at: 2026-08-29
review_interval_days: 90
sources:
  - docs/reference/changes/CR-014-voice-config-webui.md
  - docs/reference/adr/ADR-005-provider-port.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-028 在线语音模型配置（GPT-SoVITS 远程 API + api_v2 协议适配）

- 提出人：MoeJiyun233 · 2026-08-29
- 修改人：MoeJiyun233 · 2026-08-29

- 状态：Implemented（待发布评审）
- 提出人 / 日期：MoeJiyun233 / 2026-08-29
- 目标版本：当前开发阶段（系统语音输出能力补全）
- 变更原因与证据：[CR-014](CR-014-voice-config-webui.md) 将「远程 provider 运行时配置」明确列为范围外，`gpt-sovits-remote` 的 endpoint/modelId/secretRef 此前仅由 `GPT_SOVITS_*` 环境变量管理，设置 UI 无任何在线语音模型能力；且远程 provider 原请求体为自定义 JSON（`text/modelId/speakerId/settings`），与真实 GPT-SoVITS api_v2 服务要求的 `text_lang`、`ref_audio_path` 等参数不兼容，配置后合成必然失败。
- 关联能力与需求：`CAP-019/020`、[ADR-005 内部 Provider Port](../adr/ADR-005-provider-port.md)
- 当前行为 / 目标行为：
  - 当前（变更前）：远程 provider 仅由 env 管理，无持久化、无 reconfigure、无读写端点；请求体为自定义 JSON，无法对接真实 api_v2 服务；
  - 目标：
    1. 设置「语音」分类新增「本地 / 在线」子页签，在线页提供启用开关、服务地址（api_v2 base URL，默认 `http://127.0.0.1:9880`）、API Key（密码框）、模型 ID、文本语言（text_lang）、参考音频路径（ref_audio_path，GPT-SoVITS 机器上的路径）、辅助参考音频（aux_ref_audio_paths）与语速（speed_factor）配置；
    2. 远程配置持久化至 SQLite `voice_remote_configs` 表（租户隔离，每租户一行），保存后 `reconfigure` 热生效；未持久化时回退 env 缺省值；
    3. 远程 provider `synthesize` 重写为 api_v2 协议：`POST {base}/tts`，body 含 `text/text_lang/ref_audio_path`（必填）与 `aux_ref_audio_paths/speed_factor`（按需）；`healthCheck` 以「是否拿到 HTTP 响应」判定服务可达；
    4. 新增 `POST /v1/voice/remote/test-connection` 连通性测试（对齐 `/v1/llm/test-connection` 先例），支持未保存草稿的可达性验证；
    5. 人格语音选择（VoiceAbilityCard）纳入在线可用模型，选择时同步 providerId。
- 范围外：多家云端 TTS 供应商（OpenAI/火山引擎等）；对话回复自动 TTS（回复→SSE 音频下发通道）；websocket 协议。
- UX/API/数据/AI/安全/隐私影响：
  - API：新增 `GET/PUT /v1/voice/remote/config`（错误码 `INVALID_VOICE_REMOTE_CONFIG`）与 `POST /v1/voice/remote/test-connection`；
  - 数据：新增 `voice_remote_configs` 表（租户唯一索引 `voice_remote_configs_tenant_unique_idx`）；
  - 安全：endpoint 保存时校验为合法 http(s) URL（对齐 CR-016 whisper endpoint 校验先例）；API Key 沿用现有响应契约明文回显（与 `voice_input_configs` 一致），未做额外脱敏；
  - 隐私：合成文本仅发送至用户自行配置的 api_v2 服务端点，无第三方转存。
- 迁移与向后兼容：新表使用 `CREATE TABLE IF NOT EXISTS`，平滑向后兼容；env 配置（`GPT_SOVITS_*`）保留为未持久化时的缺省回退，已有部署行为不变。
- 测试、埋点和验收影响：`apps/api/test/voice.test.ts`（api_v2 请求体形状、reconfigure 生效）、`apps/api/test/voice-config.test.ts`（远程配置读写、租户隔离、非法 endpoint 400、连通性测试）、`packages/database/test/voice-config.test.ts`（远程仓储 upsert/回显/隔离）、`packages/api-client/test/voice.test.ts`（远程配置方法、loadVoices 混合来源）。
- 决策：Implemented
- 更新的文档和测试：`docs/DOC_REGISTRY.md`、`docs/README.md`、`docs/reference/REQUIREMENTS_TRACEABILITY.md`（§4.2 落地登记）
