<script setup lang="ts">
import {computed, onMounted, ref} from 'vue'
import {Check, FolderOpen, Mic, Play, RotateCcw, Volume2} from 'lucide-vue-next'
import {
  useAervoxVoice,
  type LocalVoiceConfigDto,
  type VoiceModelDto,
} from '@aervox/api-client'

const api = useAervoxVoice()
const config = ref<LocalVoiceConfigDto | null>(null)
const voices = ref<VoiceModelDto[]>([])
const loading = ref(true)
const saving = ref(false)
const savedFlash = ref(false)
const previewBusy = ref(false)
const previewAudio = ref<string | null>(null)
const error = ref<string | null>(null)

const desktopOnly = computed(() => !api.canPickDirectory())

onMounted(async () => {
  await Promise.all([loadConfig(), loadVoices()])
  loading.value = false
})

async function loadConfig(): Promise<void> {
  try {
    config.value = await api.getConfig()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取语音配置失败'
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
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
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
    <div class="settings-section-heading">
      <span class="heading-icon-wrap"><Volume2 :size="18" /></span>
      <span><strong>本地语音模型</strong><small>配置 gpt-sovits-local 本地语音合成模型</small></span>
    </div>

    <div v-if="loading" class="pcfg-loading">加载语音配置…</div>

    <template v-else>
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
        <input v-model="draft.modelId" type="text" placeholder="gpt-sovits-v2" list="voice-model-options" />
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
          {{ saving ? '保存中…' : savedFlash ? '已保存' : '保存' }}
        </button>
        <audio v-if="previewAudio" :src="previewAudio" class="voice-audio" controls />
      </div>

      <p v-if="error" class="voice-error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
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
</style>