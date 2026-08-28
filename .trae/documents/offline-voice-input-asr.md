# 离线语音输入（ASR）· 实现方案

- 提出人：Antigravity · 2026-08-28
- 修改人：Antigravity · 2026-08-28
- 类型：Plan
- 关联：[需求追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)、[CR-011 WebUI 语音配置](docs/reference/changes/CR-011-voice-config-webui.md)、[ADR-005 内部 Provider Port](docs/reference/adr/ADR-005-provider-port.md)、参考项目 `dsh-voice-local`

---

## 1. 摘要与背景

在伴学与日常对话场景中，语音输入是桌面桌宠与工作台极其重要的高效交互形态。参考开源项目 [Real-WangLe/dsh-voice-local](https://github.com/Real-WangLe/dsh-voice-local) 的离线语音输入实现，其具备**全程离线不依赖云端、SenseVoice-Small 轻量 CPU 推理、浏览器端双门限自适应断句实时回填、键盘打字自动停止录音**等优点。

本方案旨在为 Aervox 全栈架构（Fastify API + Vue 3 Workbench + Electron 桌面/Web 共享）引入**离线语音输入（ASR）**系统级能力：
1. **双模式 ASR 引擎支持**：
   - **SenseVoice 本地轻量推理**（`sensevoice-local`）：基于 ONNX Runtime / sherpa-onnx 运行 SenseVoice-Small（约 200MB），纯 CPU 推理，高准确率并自带标点；
   - **OpenAI Whisper 兼容模式**（`whisper-compatible`）：支持调用本地 Faster-Whisper、Whisper.cpp 或本地兼容端点（`POST /v1/audio/transcriptions`）。
2. **交互体验（参考 dsh-voice-local）**：
   - **句子级实时断句回填**：浏览器端自适应环境噪声底跟踪与静音断句，说一句自动转写并插入输入框当前光标处；
   - **句首缓冲保护**：维持 250ms 前置环形缓冲，避免句首字被吞；
   - **键盘自停**：录音过程中一旦检测到键盘输入、输入法合成或粘贴，立即安全终止录音，防止后续转写污染手打内容；
   - **转写不自动发送**：保留草稿，用户可核对修改后敲击 Enter 发送。
3. **配置与持久化统一集成**：
   - 在 WebUI 设置的「语音」分类中扩展「语音输入 (ASR)」配置卡片；
   - 服务端 SQLite 数据表持久化（租户作用域隔离），支持模型路径白名单与 Electron 目录选择对话框。

---

## 2. 现状分析与架构对齐

- **既有语音模块**（`apps/api/src/modules/voice/`）：
  - 当前包含 `GptSovitsLocalProvider` 与 `GptSovitsRemoteProvider`，负责语音合成输出（TTS）；
  - 可平滑扩展 `VoiceInputService` 与 `ASRProviderPort`（`SenseVoiceLocalProvider` 与 `WhisperCompatibleProvider`），统管在语音系统模块下。
- **数据持久层**（`packages/database`）：
  - 既有 `voice_configs` 负责 TTS 配置；
  - 新增 `voice_input_configs` 租户级表或在 `voice.ts` 中维护 ASR 配置快照，仓储提供 `getVoiceInputConfig(tenant)` 与 `saveVoiceInputConfig(tenant, input)`。
- **契约与 OpenAPI**（`packages/contracts`）：
  - 定义 `voiceInputConfigSchema`、`voiceTranscribeRequestSchema`、`voiceTranscribeResponseSchema`；
  - 注册 `GET/PUT /v1/voice/input/config` 与 `POST /v1/voice/transcribe` 并在 `openapi.json` 中留痕。
- **WebUI 与客户端**（`packages/api-client` & `packages/ui`）：
  - `useAervoxVoice` 扩展 `useVoiceInput` 或提供录音控制器 `VoiceInputRecorder`（封装 AudioContext、VAD 静音检测、PCM 转 WAV 编码器）；
  - `LocalVoiceConfigPanel.vue` 中集成「语音输入」配置；
  - `AervoxWorkbench.vue` 的输入框工具栏添加麦克风录音控制按钮与录音动效。

---

## 3. 详细实现计划与文件变更

### 3.1 `packages/database` — 数据模型与 ASR 配置持久化

1. **Schema 扩展**：`packages/database/src/schema/voice.ts`
   - 定义 `voiceInputConfigs` 表：
     - `id`: `text("id").primaryKey()`
     - `workspaceId`, `subjectUserId`: 租户隔离列（来自 `tenantColumns`）
     - `enabled`: `integer("enabled").notNull().default(1)`
     - `engineType`: `text("engine_type").notNull().default("sensevoice-local")`（`sensevoice-local` / `whisper-compatible`）
     - `modelPath`: `text("model_path")`（本地 ONNX 模型目录路径，受白名单约束）
     - `modelId`: `text("model_id").notNull().default("sensevoice-small")`
     - `endpoint`: `text("endpoint")`（Whisper 兼容模式时的 HTTP 地址）
     - `apiKey`: `text("api_key")`
     - `autoStopOnKeyboard`: `integer("auto_stop_on_keyboard").notNull().default(1)`（键盘自停开关）
     - `vadSilenceThresholdMs`: `integer("vad_silence_threshold_ms").notNull().default(700)`（静音断句门限）
     - `settingsJson`: `text("settings_json", { mode: "json" }).notNull().default({})`
     - `createdAt`, `updatedAt`: 时间戳
   - 唯一索引：`voice_input_configs_tenant_unique_idx` on `(workspaceId, subjectUserId)`
2. **初始化 DDL**：在 `packages/database/src/schema/init.ts` 追加 `CREATE TABLE IF NOT EXISTS voice_input_configs` 与索引。
3. **仓储接口与 SQLite 实现**：
   - 在 `packages/database/src/repositories/types.ts` 新增 `VoiceInputConfigModel`、`VoiceInputConfigSaveInput` 和 `IVoiceInputConfigRepository`；
   - 在 `packages/database/src/repositories/sqlite/voice-config-repository.ts`（或新增 `voice-input-config-repository.ts`）实现配置读写；
   - 在 `packages/database/test/voice-config.test.ts` 中增加 ASR 配置的单元测试用例。

---

### 3.2 `packages/contracts` — ASR API 契约与 OpenAPI 规范

1. **契约定义**：在 `packages/contracts/src/persona-schemas.ts`（或 `voice-schemas.ts`）定义：
   - `voiceInputEngineTypeSchema`: `z.enum(["sensevoice-local", "whisper-compatible"])`
   - `voiceInputConfigSchema`: `{ enabled, engineType, modelPath?, modelId, endpoint?, apiKey?, autoStopOnKeyboard, vadSilenceThresholdMs, settings? }`
   - `voiceInputConfigResponseSchema`: 对应响应结构
   - `voiceTranscribeRequestSchema`: `{ audioBase64: z.string().min(1), mimeType?: z.string().default("audio/wav"), language?: z.string().optional() }`
   - `voiceTranscribeResponseSchema`: `{ text: z.string(), durationMs: z.number().optional(), isFinal: z.boolean().default(true) }`
2. **OpenAPI 注册**：`packages/contracts/src/openapi.ts`
   - `GET /v1/voice/input/config`：读取 ASR 配置
   - `PUT /v1/voice/input/config`：更新 ASR 配置
   - `POST /v1/voice/transcribe`：上传音频切片并返回识别文本
3. **生成产物**：运行 `scripts/generate-openapi.ts` 同步更新 `openapi.json`。

---

### 3.3 `apps/api` — ASR 转写服务与路由

1. **引擎提供者接口**：`apps/api/src/modules/voice/asr/types.ts`
   - `ASRProviderPort`: `{ id: string; transcribe(audioBuffer: Buffer, mimeType?: string): Promise<{ text: string }> }`
2. **SenseVoice 本地提供者**：`apps/api/src/modules/voice/asr/sensevoice-provider.ts`
   - 支持加载本地 SenseVoice-Small ONNX 模型（若未安装或未就绪，优雅回退并提示友好指引）；
   - 执行音频预处理、富文本清洗与标点归一化（去除无关特殊标记，保留自然标点）。
3. **Whisper 兼容提供者**：`apps/api/src/modules/voice/asr/whisper-provider.ts`
   - 向配置的端点（如 `http://127.0.0.1:8000/v1/audio/transcriptions`）发送标准 Multipart 语音数据并解析转写响应。
4. **服务与路由**：
   - 在 `VoiceService` 中增加 `VoiceInputManager`；
   - 在 `apps/api/src/modules/voice/routes.ts` 挂载 `GET/PUT /v1/voice/input/config` 与 `POST /v1/voice/transcribe`；
   - 校验 `modelPath` 处于安全白名单内。
5. **单元/集成测试**：在 `apps/api/test/voice-input.test.ts` 验证配置读写与转写路由 mock。

---

### 3.4 `packages/api-client` — 客户端录音与自适应断句模块

1. **录音与 VAD 控制器**：`packages/api-client/src/voice/voice-input-recorder.ts`
   - 利用 Web Audio API 捕获麦克风输入（16kHz 单声道采样）；
   - **动态噪声底检测**：持续计算环境能量 RMS，自适应调整静音阈值；
   - **前置缓冲（Pre-roll Buffer）**：保留触发说话前 250ms 的 PCM 音频数据，确保首字完整；
   - **静音断句触发**：当说话后持续静音超过门限（默认 700ms）时，将缓冲数据编码为轻量级 WAV 发送转写；
   - 暴露事件回调：`onSpeechStart`、`onSpeechSegment(blob)`、`onStateChange`。
2. **Composable 封装**：`packages/api-client/src/useAervoxVoiceInput.ts`
   - 暴露 `startListening()`、`stopListening()`、`isListening`、`getInputConfig()`、`saveInputConfig()`；
   - 整合转写分发与文本追加逻辑。
3. **单元测试**：在 `packages/api-client/test/voice-input.test.ts` 覆盖参数校验与状态流转。

---

### 3.5 `packages/ui` — WebUI 设置面板与输入框交互

1. **设置面板扩展**：`packages/ui/src/components/voice/LocalVoiceConfigPanel.vue`
   - 在语音面板中增加「语音输入 (ASR)」分块：
     - ASR 启用开关；
     - 引擎类型选择（`SenseVoice 本地离线` / `OpenAI Whisper 兼容接口`）；
     - 模型路径输入（支持桌面端「选择文件夹」按钮）；
     - 「键盘输入自动关闭麦克风」切换开关与静音检测灵敏度配置；
     - 连通性 / 模型状态检查按钮。
2. **输入框麦克风控件**：`packages/ui/src/components/AervoxWorkbench.vue`
   - 在自由输入框（`story-composer`）操作栏增加麦克风图标按钮；
   - **录音态视觉反馈**：录音时麦克风高亮且伴随声波脉冲微动效；
   - **光标处文本插入**：转写返回时，将文本插入当前光标位置（`selectionStart` / `selectionEnd`），并自动向后推移光标；
   - **键盘事件监听**：在 `textarea` 绑定 `@keydown` / `@input` / `@compositionstart`，若处于录音状态则立即调用 `stopListening()`。

---

### 3.6 文档与需求追踪（AGENTS.md 硬约束）

1. **新建 CR 记录**：`docs/reference/changes/CR-016-offline-voice-input-asr.md`（遵循 Diátaxis 与元数据规范）。
2. **同步生命周期表**：在 `docs/DOC_REGISTRY.md` 注册 `CR-016`。
3. **落地登记追踪**：在 `docs/reference/REQUIREMENTS_TRACEABILITY.md` §4.2 落地登记表追加一行（关联 `CAP-019/020` / `ADR-005`，记录实现位置与验证方式）。

---

## 4. 验证计划与测试步骤

1. **数据层测试**：
   - 运行 `pnpm --filter @aervox/database test`，验证 `voice-input-config` 单测全部通过。
2. **契约构建**：
   - 运行 `pnpm --filter @aervox/contracts build` 确认 OpenAPI 文档与类型生成无误。
3. **API 集成测试**：
   - 运行 `pnpm --filter @aervox/api test`，验证配置持久化与转写路由。
4. **全库门禁**：
   - 运行 `pnpm build && pnpm typecheck && pnpm test`；
   - 运行 `npx markdownlint-cli2 --config .markdownlint-cli2.jsonc 'docs/**/*.md' 'README.md' 'AGENTS.md'` 验证文档规范。
5. **交互与功能验收**：
   - 启动 `./aervox dev web`；
   - 进入设置 -> 语音 -> 配置语音输入模型参数并保存；
   - 回到对话输入框，点击麦克风，说话体验句子级断句实时回填；
   - 录音中敲击键盘，验证键盘自停机制生效，草稿保留且光标位置正确。
