<script setup lang="ts">
import {computed, onMounted, ref, watch} from 'vue'
import {FolderOpen, Play, Volume2} from 'lucide-vue-next'
import {
  useAervoxVoice,
  type LocalVoiceConfigDto,
  type VoiceModelDto,
} from '@aervox/api-client'

/** 人格语音选择（对应 PersonaRevisionConfig.voice，CR-011 阶段 2） */
export interface VoiceSelectionValue {
  enabled: boolean
  providerId: string
  modelId: string
  speakerId?: string
  settings?: Record<string, string | number | boolean>
}

const props = defineProps<{
  modelValue: VoiceSelectionValue | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: VoiceSelectionValue | null): void
}>()

const api = useAervoxVoice()
const voices = ref<VoiceModelDto[]>([])
const localConfig = ref<LocalVoiceConfigDto | null>(null)
const previewBusy = ref(false)
const previewAudio = ref<string | null>(null)
const previewError = ref<string | null>(null)

// 本地草稿：与 props.modelValue 双向解耦
const enabled = ref(false)
const providerId = ref('')
const modelId = ref('')
const speakerId = ref('')

onMounted(async () => {
  try {
    voices.value = await api.loadVoices()
  } catch {
    voices.value = []
  }
  try {
    localConfig.value = await api.getConfig()
  } catch {
    localConfig.value = null
  }
  syncFromProp()
})

/** 外部值变化时回填草稿（弹窗复用同一实例打开不同人格时保证同步） */
watch(
  () => props.modelValue,
  () => syncFromProp(),
)

function syncFromProp(): void {
  const v = props.modelValue
  enabled.value = v?.enabled ?? false
  providerId.value = v?.providerId ?? localConfig.value?.providerId ?? 'gpt-sovits-local'
  modelId.value = v?.modelId ?? localConfig.value?.modelId ?? ''
  speakerId.value = v?.speakerId ?? localConfig.value?.speakerId ?? ''
}

const desktopOnly = computed(() => !api.canPickDirectory())

/** 模型下拉变化时，把 providerId 同步为所选模型的来源（本地/在线） */
function onModelChange(): void {
  const selected = voices.value.find((v) => v.modelId === modelId.value)
  if (selected) {
    providerId.value = selected.providerId
  }
  push()
}

/** 选择音色文件夹（取其目录名作为 speakerId） */
async function pickSpeakerFolder(): Promise<void> {
  const path = await api.pickDirectory()
  if (!path) return
  speakerId.value = api.basenameOf(path)
  push()
}

/** 推送到父组件（未启用时交回 null，避免在各人格中留下冗余配置） */
function push(): void {
  if (!enabled.value) {
    emit('update:modelValue', null)
    return
  }
  if (!modelId.value) {
    emit('update:modelValue', null)
    return
  }
  emit('update:modelValue', {
    enabled: true,
    providerId: providerId.value || 'gpt-sovits-local',
    modelId: modelId.value,
    ...(speakerId.value ? { speakerId: speakerId.value } : {}),
  })
}

function onToggle(): void {
  enabled.value = !enabled.value
  if (enabled.value) {
    // 首次启用且未配置过时，用本地配置兜底
    if (!modelId.value && localConfig.value?.modelId) {
      modelId.value = localConfig.value.modelId
    }
    if (!providerId.value && localConfig.value?.providerId) {
      providerId.value = localConfig.value.providerId
    }
  }
  push()
}

async function preview(): Promise<void> {
  if (!modelId.value) {
    previewError.value = '请先选择语音模型'
    return
  }
  previewBusy.value = true
  previewError.value = null
  previewAudio.value = null
  try {
    const result = await api.synthesize({
      providerId: providerId.value || 'gpt-sovits-local',
      modelId: modelId.value,
      ...(speakerId.value ? { speakerId: speakerId.value } : {}),
      text: '你好，我是思隅，很高兴认识你。',
    })
    previewAudio.value = `data:${result.contentType};base64,${result.audioBase64}`
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : '试听合成失败'
  } finally {
    previewBusy.value = false
  }
}
</script>

<template>
  <div class="ability-card voice-card" :class="{'is-open': enabled}">
    <div class="ability-card-header" @click="onToggle">
      <label class="checkbox-label" @click.stop>
        <input
          type="checkbox"
          :checked="enabled"
          @change="onToggle"
        />
        <span class="header-title">
          <Volume2 :size="15" />
          <strong>语音</strong>
        </span>
      </label>
      <span class="voice-card-badge" :class="{active: enabled}">
        {{ enabled ? '已启用' : '未启用' }}
      </span>
    </div>

    <div v-if="enabled" class="voice-card-body">
      <div class="voice-field">
        <span class="voice-field-label">模型</span>
        <select
          v-model="modelId"
          class="voice-select"
          @change="onModelChange"
        >
          <option value="" disabled>选择语音模型</option>
          <option v-for="v in voices" :key="v.modelId" :value="v.modelId">
            {{ v.displayName }}{{ v.source === 'remote' ? '（在线）' : '' }}
          </option>
          <option v-if="modelId && !voices.some((v) => v.modelId === modelId)" :value="modelId">
            {{ modelId }}（自定义）
          </option>
        </select>
      </div>

      <div class="voice-field">
        <span class="voice-field-label">音色</span>
        <div class="voice-picker">
          <input
            v-model="speakerId"
            type="text"
            class="voice-picker-input-field"
            placeholder="默认音色"
            @input="push"
          />
          <button
            type="button"
            class="voice-picker-btn"
            :disabled="desktopOnly"
            :title="desktopOnly ? '选择文件夹仅桌面端可用' : '选择音色文件夹'"
            @click="pickSpeakerFolder"
          >
            <FolderOpen :size="13" />选择文件夹
          </button>
        </div>
      </div>

      <div class="voice-field voice-preview-row">
        <span class="voice-field-label">试听</span>
        <div class="voice-preview-actions">
          <button
            type="button"
            class="voice-preview-btn"
            :disabled="previewBusy"
            @click="preview"
          >
            <Play :size="13" />{{ previewBusy ? '合成中…' : '试听' }}
          </button>
          <audio v-if="previewAudio" :src="previewAudio" class="voice-audio" controls />
        </div>
      </div>

      <p v-if="previewError" class="voice-hint voice-error">{{ previewError }}</p>
      <p v-else-if="voices.length === 0" class="voice-hint">暂无可用语音模型，请先在设置中配置语音</p>
    </div>
  </div>
</template>

<style scoped>
.ability-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-soft);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: border-color 0.22s ease, background-color 0.22s ease, box-shadow 0.22s ease;
}

.ability-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  background: color-mix(in srgb, var(--border) 25%, var(--bg-soft));
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid transparent;
  transition: background-color 0.2s ease, border-bottom-color 0.2s ease;
}

.ability-card.is-open .ability-card-header {
  border-bottom-color: var(--border);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
}

.checkbox-label input {
  accent-color: var(--accent);
  cursor: pointer;
  margin: 0;
  width: 14px;
  height: 14px;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-primary);
  font-size: 12px;
}

.header-title strong {
  font-size: 12px;
  font-weight: 600;
}

.voice-card-badge {
  font-size: 11px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--border) 55%, transparent);
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
  transition: all 0.15s ease;
}

.voice-card-badge.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.voice-card-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  background: var(--bg-soft);
}

.voice-field {
  display: flex;
  align-items: center;
  gap: 10px;
}

.voice-field-label {
  font-size: 11.5px;
  font-weight: 550;
  color: var(--text-secondary);
  flex: 0 0 32px;
}

.voice-select {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: 0;
  background: var(--bg-input, var(--bg-main));
  color: var(--text-primary);
  font-size: 12px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.voice-select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}

.voice-picker {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.voice-picker-input-field {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: 0;
  background: var(--bg-input, var(--bg-main));
  color: var(--text-primary);
  font-size: 12px;
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
  padding: 6px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 11.5px;
  font-weight: 500;
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

.voice-preview-row {
  align-items: center;
}

.voice-preview-actions {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}

.voice-preview-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 11.5px;
  font-weight: 550;
  cursor: pointer;
  transition: all 0.15s ease;
}

.voice-preview-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.voice-preview-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.voice-audio {
  flex: 1;
  max-width: 220px;
  height: 28px;
}

.voice-hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.voice-error {
  color: var(--danger, #e5484d);
}
</style>