<script setup lang="ts">
import {computed, onMounted, ref} from 'vue'
import {Check, Download, FolderOpen, Loader2, Mic, Play, RotateCcw, Volume2} from 'lucide-vue-next'
import {
  useAervoxVoice,
  useAervoxVoiceInput,
  type LocalVoiceConfigDto,
  type VoiceInputConfigDto,
  type VoiceInputModelStatusDto,
  type VoiceModelDto,
} from '@aervox/api-client'

const api = useAervoxVoice()
const inputApi = useAervoxVoiceInput()

const config = ref<LocalVoiceConfigDto | null>(null)
const inputConfig = ref<VoiceInputConfigDto | null>(null)
const modelStatus = ref<VoiceInputModelStatusDto | null>(null)
const voices = ref<VoiceModelDto[]>([])
const loading = ref(true)
const saving = ref(false)
const savedFlash = ref(false)
const savingInput = ref(false)
const savedInputFlash = ref(false)
const downloadingModel = ref(false)
const downloadMessage = ref<string | null>(null)
const previewBusy = ref(false)
const previewAudio = ref<string | null>(null)
const error = ref<string | null>(null)
const inputError = ref<string | null>(null)

const desktopOnly = computed(() => !api.canPickDirectory())

onMounted(async () => {
  await Promise.all([loadConfig(), loadInputConfig(), loadModelStatus(), loadVoices()])
  loading.value = false
})

async function loadModelStatus(): Promise<void> {
  try {
    modelStatus.value = await inputApi.getModelStatus()
  } catch {
    modelStatus.value = null
  }
}

async function triggerDownloadModel(): Promise<void> {
  downloadingModel.value = true
  downloadMessage.value = null
  inputError.value = null
  try {
    const res = await inputApi.downloadModel()
    downloadMessage.value = res.message
    modelStatus.value = res.status
    if (res.status.modelPath) {
      inputDraft.value = { ...inputDraft.value, modelPath: res.status.modelPath }
    }
    // 轮询更新下载完成状态
    const timer = setInterval(async () => {
      await loadModelStatus()
      if (modelStatus.value?.downloaded) {
        downloadingModel.value = false
        clearInterval(timer)
      }
    }, 1000)
    setTimeout(() => {
      clearInterval(timer)
      downloadingModel.value = false
    }, 6000)
  } catch (e) {
    inputError.value = e instanceof Error ? e.message : '启动下载失败'
    downloadingModel.value = false
  }
}

async function loadConfig(): Promise<void> {
  try {
    config.value = await api.getConfig()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取语音输出配置失败'
  }
}

async function loadInputConfig(): Promise<void> {
  try {
    inputConfig.value = await inputApi.getInputConfig()
  } catch (e) {
    inputError.value = e instanceof Error ? e.message : '读取语音输入配置失败'
  }
}

async function loadVoices(): Promise<void> {
  try {
    voices.value = await api.loadLocalVoices()
  } catch {
    voices.value = []
  }
}

const draft = computed<LocalVoiceConfigDto>({
  get() {
    return (
      config.value ?? {
        enabled: true,
        providerId: 'gpt-sovits-local',
        modelId: '',
        settings: {},
      }
    )
  },
  set(value) {
    config.value = value
  },
})

const inputDraft = computed<VoiceInputConfigDto>({
  get() {
    return (
      inputConfig.value ?? {
        enabled: true,
        engineType: 'sensevoice-local',
        modelId: 'sensevoice-small',
        autoStopOnKeyboard: true,
        vadSilenceThresholdMs: 700,
        settings: {},
      }
    )
  },
  set(value) {
    inputConfig.value = value
  },
})

/** 选择本地模型文件夹（GPT-SoVITS 模型目录） */
async function pickModelFolder(): Promise<void> {
  const path = await api.pickDirectory()
  if (!path) return
  const next = {...draft.value, modelPath: path}
  if (!next.modelId) next.modelId = api.basenameOf(path)
  draft.value = next
}

/** 选择音色文件夹（取其目录名作为 speakerId） */
async function pickSpeakerFolder(): Promise<void> {
  const path = await api.pickDirectory()
  if (!path) return
  const next = {...draft.value, speakerId: api.basenameOf(path)}
  draft.value = next
}

/** 选择 SenseVoice 离线模型文件夹 */
async function pickSenseVoiceFolder(): Promise<void> {
  const path = await api.pickDirectory()
  if (!path) return
  inputDraft.value = { ...inputDraft.value, modelPath: path }
}

async function save(): Promise<void> {
  saving.value = true
  error.value = null
  try {
    config.value = await api.saveConfig({
      enabled: draft.value.enabled,
      providerId: draft.value.providerId,
      modelPath: draft.value.modelPath || undefined,
      modelId: draft.value.modelId,
      speakerId: draft.value.speakerId || undefined,
      settings: draft.value.settings ?? {},
    })
    savedFlash.value = true
    setTimeout(() => {
      savedFlash.value = false
    }, 1600)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存输出配置失败'
  } finally {
    saving.value = false
  }
}

async function saveInput(): Promise<void> {
  savingInput.value = true
  inputError.value = null
  try {
    inputConfig.value = await inputApi.saveInputConfig({
      enabled: inputDraft.value.enabled,
      engineType: inputDraft.value.engineType,
      modelPath: inputDraft.value.modelPath || undefined,
      modelId: inputDraft.value.modelId,
      endpoint: inputDraft.value.endpoint || undefined,
      apiKey: inputDraft.value.apiKey || undefined,
      autoStopOnKeyboard: inputDraft.value.autoStopOnKeyboard,
      vadSilenceThresholdMs: Number(inputDraft.value.vadSilenceThresholdMs) || 700,
      settings: inputDraft.value.settings ?? {},
    })
    savedInputFlash.value = true
    setTimeout(() => {
      savedInputFlash.value = false
    }, 1600)
  } catch (e) {
    inputError.value = e instanceof Error ? e.message : '保存输入配置失败'
  } finally {
    savingInput.value = false
  }
}

async function preview(): Promise<void> {
  if (!draft.value.modelId) {
    error.value = '请先填写模型 ID'
    return
  }
  previewBusy.value = true
  error.value = null
  previewAudio.value = null
  try {
    const result = await api.synthesize({
      providerId: draft.value.providerId,
      modelId: draft.value.modelId,
      speakerId: draft.value.speakerId || undefined,
      text: '你好，我是思隅，很高兴与你相遇。',
    })
    previewAudio.value = `data:${result.contentType};base64,${result.audioBase64}`
  } catch (e) {
    error.value = e instanceof Error ? e.message : '试听合成失败'
  } finally {
    previewBusy.value = false
  }
}
</script>

<template>
  <div class="local-voice-panel">
    <!-- 语音输入 (ASR) 分块 -->
    <div class="settings-section-heading">
      <span class="heading-icon-wrap"><Mic :size="18" /></span>
      <span><strong>离线语音输入 (ASR)</strong><small>配置 SenseVoice 离线语音识别或 Whisper 兼容端点</small></span>
    </div>

    <div v-if="loading" class="pcfg-loading">加载语音配置…</div>

    <template v-else>
      <label class="settings-row settings-choice-row">
        <span><strong>启用语音输入</strong><small>在输入框操作栏显示麦克风听写按钮</small></span>
        <input v-model="inputDraft.enabled" type="checkbox" class="settings-switch" />
      </label>

      <div class="settings-field">
        <span><strong>识别引擎</strong><small>选择 SenseVoice 本地轻量模型或 OpenAI Whisper 兼容接口</small></span>
        <select v-model="inputDraft.engineType" class="voice-select-field">
          <option value="sensevoice-local">SenseVoice-Small (本地轻量离线)</option>
          <option value="whisper-compatible">OpenAI Whisper 兼容端点</option>
        </select>
      </div>

      <template v-if="inputDraft.engineType === 'sensevoice-local'">
        <div class="settings-field">
          <span>
            <strong>本地模型路径</strong>
            <small>SenseVoice ONNX 模型目录路径</small>
          </span>
          <div class="voice-picker">
            <input
              v-model="inputDraft.modelPath"
              type="text"
              class="voice-picker-input-field"
              placeholder="/opt/sensevoice"
            />
            <button
              type="button"
              class="voice-picker-btn"
              :disabled="desktopOnly"
              :title="desktopOnly ? '选择文件夹仅桌面端可用' : '选择模型文件夹'"
              @click="pickSenseVoiceFolder"
            >
              <FolderOpen :size="14" />选择文件夹
            </button>
          </div>
        </div>

        <!-- 离线模型状态与一键下载卡片 -->
        <div class="model-status-box">
          <div class="model-status-info">
            <div class="model-status-tag-row">
              <span
                class="model-status-tag"
                :class="{
                  ready: modelStatus?.downloaded && modelStatus?.verified,
                  missing: !modelStatus?.downloaded && !downloadingModel,
                  downloading: downloadingModel || modelStatus?.downloading,
                }"
              >
                <span class="status-dot" />
                {{
                  modelStatus?.downloaded
                    ? modelStatus?.verified
                      ? '模型已就绪 (校验通过)'
                      : '模型已存在'
                    : downloadingModel || modelStatus?.downloading
                      ? `正在下载模型 (${modelStatus?.progressPercent ?? 0}%)`
                      : '未检测到离线模型'
                }}
              </span>
              <span v-if="modelStatus?.checksum" class="model-hash-badge">
                SHA256: {{ modelStatus.checksum.slice(0, 8) }}…
              </span>
            </div>

            <!-- 下载进度条 -->
            <div
              v-if="downloadingModel || modelStatus?.downloading"
              class="model-progress-bar-container"
            >
              <div
                class="model-progress-bar-fill"
                :style="{ width: `${modelStatus?.progressPercent ?? 15}%` }"
              />
            </div>

            <small class="model-status-desc">
              {{
                modelStatus?.downloaded
                  ? '已检测到本地 SenseVoice-Small 权重并完成完整性校验，无需联网即可直接进行语音输入。'
                  : downloadingModel || modelStatus?.downloading
                    ? `下载中，正在同步模型权重与标点配置（约 230MB）…`
                    : '未下载模型无法进行本地离线转写，点击右侧按钮可一键下载（约 230MB）。'
              }}
            </small>
          </div>
          <button
            v-if="!modelStatus?.downloaded"
            type="button"
            class="download-model-btn"
            :disabled="downloadingModel || modelStatus?.downloading"
            @click="triggerDownloadModel"
          >
            <Loader2 v-if="downloadingModel || modelStatus?.downloading" class="spin" :size="14" />
            <Download v-else :size="14" />
            {{ downloadingModel || modelStatus?.downloading ? '下载中…' : '下载离线模型' }}
          </button>
        </div>
        <div v-if="downloadMessage" class="download-tip-msg">{{ downloadMessage }}</div>
      </template>

      <template v-else>
        <div class="settings-field">
          <span><strong>端点 URL (Endpoint)</strong><small>如 http://127.0.0.1:8000/v1</small></span>
          <input
            v-model="inputDraft.endpoint"
            type="text"
            class="voice-input-field-full"
            placeholder="http://127.0.0.1:8000/v1"
          />
        </div>
        <div class="settings-field">
          <span><strong>API Key</strong><small>访问 Whisper 服务所需的密钥（可选）</small></span>
          <input
            v-model="inputDraft.apiKey"
            type="password"
            class="voice-input-field-full"
            placeholder="sk-..."
            autocomplete="off"
          />
        </div>
      </template>

      <div class="settings-field">
        <span><strong>模型名称 (Model ID)</strong><small>要调用的识别模型标识</small></span>
        <input
          v-model="inputDraft.modelId"
          type="text"
          class="voice-input-field-full"
          placeholder="sensevoice-small"
        />
      </div>

      <label class="settings-row settings-choice-row">
        <span><strong>键盘输入自动关闭麦克风</strong><small>录音期间打字/中文输入法/粘贴时立即停止，防止污染手打文本</small></span>
        <input v-model="inputDraft.autoStopOnKeyboard" type="checkbox" class="settings-switch" />
      </label>

      <div class="settings-field">
        <span><strong>静音断句门限 (毫秒)</strong><small>停顿超过该时长自动触发转写 (默认 700ms)</small></span>
        <input
          v-model.number="inputDraft.vadSilenceThresholdMs"
          type="number"
          min="300"
          max="3000"
          step="50"
          class="voice-input-field-full number-input"
        />
      </div>

      <div class="settings-note voice-actions">
        <button type="button" class="voice-action" :disabled="savingInput" @click="saveInput">
          <Check v-if="savedInputFlash" :size="15" />
          <RotateCcw v-else :size="15" />
          {{ savingInput ? '保存中…' : savedInputFlash ? '已保存' : '保存语音输入配置' }}
        </button>
      </div>
      <p v-if="inputError" class="voice-error">{{ inputError }}</p>

      <div class="voice-divider" />

      <!-- 语音输出 (TTS) 分块 -->
      <div class="settings-section-heading">
        <span class="heading-icon-wrap"><Volume2 :size="18" /></span>
        <span><strong>本地语音合成 (TTS)</strong><small>配置 gpt-sovits-local 本地语音合成模型</small></span>
      </div>

      <label class="settings-row settings-choice-row">
        <span><strong>启用语音输出</strong><small>关闭后系统不进行语音合成</small></span>
        <input v-model="draft.enabled" type="checkbox" class="settings-switch" />
      </label>

      <div class="settings-field">
        <span><strong>本地模型路径</strong><small>服务端模型目录路径，位于 allowedRoots 白名单内</small></span>
        <div class="voice-picker">
          <input
            v-model="draft.modelPath"
            type="text"
            class="voice-picker-input-field"
            placeholder="/opt/gpt-sovits/model"
          />
          <button
            type="button"
            class="voice-picker-btn"
            :disabled="desktopOnly"
            :title="desktopOnly ? '选择文件夹仅桌面端可用' : '选择模型文件夹'"
            @click="pickModelFolder"
          >
            <FolderOpen :size="14" />选择文件夹
          </button>
        </div>
      </div>

      <div class="settings-field">
        <span><strong>模型 ID</strong><small>本地 GPT-SoVITS 模型标识</small></span>
        <input v-model="draft.modelId" type="text" placeholder="gpt-sovits-v2" list="voice-model-options" class="voice-input-field-full" />
      </div>
      <datalist id="voice-model-options">
        <option v-for="v in voices" :key="v.modelId" :value="v.modelId">{{ v.displayName }}</option>
      </datalist>

      <div class="settings-field">
        <span><strong>音色</strong><small>默认说话人或音色目录标识</small></span>
        <div class="voice-picker">
          <input
            v-model="draft.speakerId"
            type="text"
            class="voice-picker-input-field"
            placeholder="留空使用默认音色"
          />
          <button
            type="button"
            class="voice-picker-btn"
            :disabled="desktopOnly"
            :title="desktopOnly ? '选择文件夹仅桌面端可用' : '选择音色文件夹'"
            @click="pickSpeakerFolder"
          >
            <FolderOpen :size="14" />选择音色文件夹
          </button>
        </div>
      </div>

      <div class="settings-note voice-actions">
        <button
          type="button"
          class="voice-action"
          :disabled="previewBusy"
          @click="preview"
        >
          <Play v-if="!previewBusy" :size="15" />
          <Mic v-else :size="15" />
          {{ previewBusy ? '合成中…' : '试听' }}
        </button>
        <button type="button" class="voice-action" :disabled="saving" @click="save">
          <Check v-if="savedFlash" :size="15" />
          <RotateCcw v-else :size="15" />
          {{ saving ? '保存中…' : savedFlash ? '已保存' : '保存语音输出配置' }}
        </button>
        <audio v-if="previewAudio" :src="previewAudio" class="voice-audio" controls />
      </div>

      <p v-if="error" class="voice-error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.voice-divider {
  margin: 22px 0 16px;
  border-top: 1px dashed var(--border);
}

.voice-select-field,
.voice-input-field-full {
  width: min(380px, 58%);
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: 0;
  background: var(--bg-input, var(--bg-soft));
  color: var(--text-primary);
  font-size: 12.5px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.voice-select-field:focus,
.voice-input-field-full:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}

.number-input {
  width: 140px;
}

.voice-picker {
  width: min(380px, 58%);
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.voice-picker-input-field {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: 0;
  background: var(--bg-input, var(--bg-soft));
  color: var(--text-primary);
  font-size: 12.5px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.voice-picker-input-field:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}

.voice-picker-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.voice-picker-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.voice-picker-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.voice-actions {
  flex-wrap: wrap;
}

.voice-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  transition: all 0.15s ease;
}

.voice-action:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.voice-action:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.voice-audio {
  max-width: 180px;
  height: 28px;
}

.voice-error {
  margin-top: 10px;
  color: var(--danger, #e5484d);
  font-size: 12px;
}

.model-status-box {
  width: min(480px, 90%);
  margin-top: 4px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-soft);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.model-status-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.model-status-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
}

.model-status-tag.ready {
  color: #16a34a;
}

.model-status-tag.missing {
  color: #d97706;
}

.model-status-tag.downloading {
  color: var(--accent);
}

.model-status-tag-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.model-hash-badge {
  font-size: 10px;
  font-family: ui-monospace, monospace;
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
}

.model-progress-bar-container {
  width: 100%;
  height: 5px;
  border-radius: 4px;
  background: var(--border);
  overflow: hidden;
  margin: 4px 0;
}

.model-progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), #22c55e);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.model-status-desc {
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.4;
}

.download-model-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.download-model-btn:hover:not(:disabled) {
  background: var(--accent);
  color: #fff;
}

.download-model-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.download-tip-msg {
  font-size: 11px;
  color: var(--accent);
  margin-top: -6px;
  margin-bottom: 10px;
}

.spin {
  animation: aervox-spin 1s linear infinite;
}
</style>
