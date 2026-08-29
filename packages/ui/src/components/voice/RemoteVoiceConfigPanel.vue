<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Check, Eye, EyeOff, Play, RotateCcw, Volume2, Globe } from 'lucide-vue-next'
import {
  useAervoxVoice,
  type RemoteVoiceConfigDto,
  type VoiceModelDto,
  type VoiceRemoteTestConnectionResultDto,
} from '@aervox/api-client'

const api = useAervoxVoice()

const config = ref<RemoteVoiceConfigDto | null>(null)
const voices = ref<VoiceModelDto[]>([])
const loading = ref(true)
const saving = ref(false)
const savedFlash = ref(false)
const showApiKey = ref(false)
const testBusy = ref(false)
const testResult = ref<VoiceRemoteTestConnectionResultDto | null>(null)
const previewBusy = ref(false)
const previewAudio = ref<string | null>(null)
const error = ref<string | null>(null)

/** 辅助参考音频的 textarea 视图（每行一条路径） */
const auxRefText = computed({
  get() {
    return (config.value?.auxRefAudioPaths ?? []).join('\n')
  },
  set(value: string) {
    if (config.value) {
      config.value.auxRefAudioPaths = value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    }
  },
})

const draft = computed<RemoteVoiceConfigDto>({
  get() {
    return (
      config.value ?? {
        enabled: true,
        providerId: 'gpt-sovits-remote',
        endpoint: 'http://127.0.0.1:9880',
        modelId: 'default-remote',
        textLang: 'zh',
        speedFactor: 1,
        settings: {},
      }
    )
  },
  set(value) {
    config.value = value
  },
})

onMounted(async () => {
  await Promise.all([loadConfig(), loadVoices()])
  loading.value = false
})

async function loadConfig(): Promise<void> {
  try {
    config.value = await api.getRemoteConfig()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取在线语音配置失败'
  }
}

async function loadVoices(): Promise<void> {
  try {
    voices.value = await api.loadVoices('remote')
  } catch {
    voices.value = []
  }
}

/** 试听：使用当前草稿参数请求合成（未保存的参数经 settings 透传即时生效） */
async function preview(): Promise<void> {
  if (!draft.value.endpoint?.trim()) {
    error.value = '请先填写服务地址'
    return
  }
  if (!draft.value.modelId.trim()) {
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
      text: '你好，我是思隅，很高兴与你相遇。',
      settings: {
        textLang: draft.value.textLang ?? 'zh',
        ...(draft.value.refAudioPath ? { refAudioPath: draft.value.refAudioPath } : {}),
        ...(draft.value.speedFactor ? { speedFactor: draft.value.speedFactor } : {}),
      },
    })
    previewAudio.value = `data:${result.contentType};base64,${result.audioBase64}`
  } catch (e) {
    error.value = e instanceof Error ? e.message : '试听合成失败'
  } finally {
    previewBusy.value = false
  }
}

async function handleTestConnection(): Promise<void> {
  if (!draft.value.endpoint?.trim()) {
    error.value = '请先填写服务地址'
    return
  }
  testBusy.value = true
  testResult.value = null
  error.value = null
  try {
    testResult.value = await api.testRemoteConnection({
      endpoint: draft.value.endpoint.trim(),
      apiKey: draft.value.apiKey?.trim() || undefined,
      modelId: draft.value.modelId.trim() || 'default-remote',
    })
  } catch (e) {
    testResult.value = {
      ok: false,
      latencyMs: 0,
      message: e instanceof Error ? e.message : '连通性测试请求失败',
    }
  } finally {
    testBusy.value = false
  }
}

async function save(): Promise<void> {
  if (!draft.value.endpoint?.trim()) {
    error.value = '服务地址不能为空'
    return
  }
  if (!draft.value.modelId.trim()) {
    error.value = '模型 ID 不能为空'
    return
  }
  saving.value = true
  error.value = null
  try {
    config.value = await api.saveRemoteConfig({
      enabled: draft.value.enabled,
      providerId: draft.value.providerId,
      endpoint: draft.value.endpoint.trim(),
      apiKey: draft.value.apiKey?.trim() || undefined,
      modelId: draft.value.modelId.trim(),
      speakerId: draft.value.speakerId?.trim() || undefined,
      textLang: draft.value.textLang,
      refAudioPath: draft.value.refAudioPath?.trim() || undefined,
      auxRefAudioPaths: (draft.value.auxRefAudioPaths ?? []).length
        ? draft.value.auxRefAudioPaths
        : undefined,
      speedFactor: draft.value.speedFactor || undefined,
      settings: draft.value.settings ?? {},
    })
    savedFlash.value = true
    setTimeout(() => {
      savedFlash.value = false
    }, 1600)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存在线语音配置失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="remote-voice-panel">
    <div class="settings-section-heading">
      <span class="heading-icon-wrap"><Volume2 :size="18" /></span>
      <span><strong>在线语音模型 (GPT-SoVITS 远程 API)</strong><small>连接独立部署的 GPT-SoVITS api_v2 服务进行语音合成</small></span>
    </div>

    <div v-if="loading" class="pcfg-loading">加载在线语音配置…</div>

    <template v-else>
      <label class="settings-row settings-choice-row">
        <span><strong>启用在线语音输出</strong><small>关闭后不调用远程服务进行语音合成</small></span>
        <input v-model="draft.enabled" type="checkbox" class="settings-switch" />
      </label>

      <div class="settings-field">
        <span><strong>服务地址 (Base URL)</strong><small>GPT-SoVITS api_v2 服务地址，如 http://127.0.0.1:9880</small></span>
        <div class="voice-picker">
          <input
            v-model="draft.endpoint"
            type="text"
            class="voice-picker-input-field"
            placeholder="http://127.0.0.1:9880"
          />
          <span class="voice-endpoint-badge"><Globe :size="13" />api_v2</span>
        </div>
      </div>

      <div class="settings-field">
        <span><strong>API Key</strong><small>访问远程服务所需的密钥，本地服务留空即可</small></span>
        <div class="voice-key-wrapper">
          <input
            v-model="draft.apiKey"
            :type="showApiKey ? 'text' : 'password'"
            class="voice-input-field-full key-input"
            placeholder="留空表示无鉴权"
            autocomplete="off"
          />
          <button
            type="button"
            class="voice-key-toggle"
            :title="showApiKey ? '隐藏密钥' : '查看密钥'"
            @click="showApiKey = !showApiKey"
          >
            <EyeOff v-if="showApiKey" :size="15" />
            <Eye v-else :size="15" />
          </button>
        </div>
      </div>

      <div class="settings-field">
        <span><strong>模型 ID</strong><small>在线语音模型标识（合成由服务端已加载权重完成）</small></span>
        <input
          v-model="draft.modelId"
          type="text"
          placeholder="default-remote"
          list="remote-voice-model-options"
          class="voice-input-field-full"
        />
        <datalist id="remote-voice-model-options">
          <option v-for="v in voices" :key="v.modelId" :value="v.modelId">{{ v.displayName }}</option>
        </datalist>
      </div>

      <div class="settings-field">
        <span><strong>文本语言</strong><small>api_v2 text_lang 参数，决定待合成文本的语言</small></span>
        <select v-model="draft.textLang" class="voice-select-field">
          <option value="auto">自动识别 (auto)</option>
          <option value="zh">中文 (zh)</option>
          <option value="en">英文 (en)</option>
          <option value="ja">日文 (ja)</option>
          <option value="ko">韩文 (ko)</option>
          <option value="yue">粤语 (yue)</option>
        </select>
      </div>

      <div class="settings-field">
        <span><strong>参考音频路径</strong><small>GPT-SoVITS 机器上的参考音频文件（api_v2 ref_audio_path），如 D:\GPT-SOVITS-V4\voice\firefly\xxx.wav</small></span>
        <input
          v-model="draft.refAudioPath"
          type="text"
          class="voice-input-field-full"
          placeholder="D:\GPT-SOVITS-V4\voice\firefly\ref.wav"
        />
      </div>

      <div class="settings-field">
        <span><strong>辅助参考音频</strong><small>可选，每行一条路径，用于增强音色稳定性（api_v2 aux_ref_audio_paths）</small></span>
        <textarea
          v-model="auxRefText"
          class="voice-textarea"
          rows="3"
          placeholder="D:\GPT-SOVITS-V4\voice\firefly\aux1.wav"
        />
      </div>

      <div class="settings-field">
        <span><strong>语速</strong><small>api_v2 speed_factor 参数 (0.6 ~ 1.65)</small></span>
        <div class="voice-slider-row">
          <input
            v-model.number="draft.speedFactor"
            type="range"
            min="0.6"
            max="1.65"
            step="0.05"
            class="voice-slider"
          />
          <span class="voice-slider-value">{{ draft.speedFactor ?? 1 }}</span>
        </div>
      </div>

      <div class="settings-note voice-actions">
        <button
          type="button"
          class="voice-action"
          :disabled="testBusy"
          @click="handleTestConnection"
        >
          <Globe :size="15" />
          {{ testBusy ? '测试中…' : '测试连接' }}
        </button>
        <button
          type="button"
          class="voice-action"
          :disabled="previewBusy"
          @click="preview"
        >
          <Play v-if="!previewBusy" :size="15" />
          <Volume2 v-else :size="15" />
          {{ previewBusy ? '合成中…' : '试听' }}
        </button>
        <button type="button" class="voice-action" :disabled="saving" @click="save">
          <Check v-if="savedFlash" :size="15" />
          <RotateCcw v-else :size="15" />
          {{ saving ? '保存中…' : savedFlash ? '已保存' : '保存语音输出配置' }}
        </button>
        <audio v-if="previewAudio" :src="previewAudio" class="voice-audio" controls />
      </div>

      <p v-if="testResult" class="voice-test-result" :class="testResult.ok ? 'ok' : 'fail'">
        {{ testResult.ok ? '✓' : '✗' }} {{ testResult.message }}（{{ testResult.latencyMs }}ms）
      </p>
      <p v-if="error" class="voice-error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
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

.voice-endpoint-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}

.voice-key-wrapper {
  width: min(380px, 58%);
  display: flex;
  align-items: center;
  gap: 6px;
}

.voice-key-wrapper .key-input {
  flex: 1;
  min-width: 0;
}

.voice-key-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 7px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.voice-key-toggle:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.voice-textarea {
  width: min(380px, 58%);
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: 0;
  background: var(--bg-input, var(--bg-soft));
  color: var(--text-primary);
  font-size: 12px;
  font-family: ui-monospace, monospace;
  line-height: 1.5;
  resize: vertical;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.voice-textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}

.voice-slider-row {
  width: min(380px, 58%);
  display: flex;
  align-items: center;
  gap: 12px;
}

.voice-slider {
  flex: 1;
}

.voice-slider-value {
  min-width: 34px;
  text-align: center;
  font-size: 11.5px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
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

.voice-test-result {
  margin-top: 8px;
  font-size: 12px;
}

.voice-test-result.ok {
  color: #16a34a;
}

.voice-test-result.fail {
  color: var(--danger, #e5484d);
}

.voice-error {
  margin-top: 10px;
  color: var(--danger, #e5484d);
  font-size: 12px;
}
</style>
