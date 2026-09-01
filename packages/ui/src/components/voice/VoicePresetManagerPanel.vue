<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Mic, Plus, Sparkles, Trash2, Volume2 } from 'lucide-vue-next'
import {
  useAervoxVoice,
  type VoicePresetDto,
} from '@aervox/api-client'
import LocalVoiceConfigPanel from './LocalVoiceConfigPanel.vue'
import RemoteVoiceConfigPanel from './RemoteVoiceConfigPanel.vue'

const api = useAervoxVoice()

const presets = ref<VoicePresetDto[]>([])
const activePresetId = ref<string | null>(null)
const loading = ref(false)
const busyPresetId = ref<string | null>(null)
const voiceMode = ref<'local' | 'online'>('local')

onMounted(async () => {
  await loadPresets()
})

async function loadPresets(): Promise<void> {
  loading.value = true
  try {
    const res = await api.listPresets()
    presets.value = res.presets ?? []
    activePresetId.value = res.activeId ?? null
  } catch {
    // 后端尚未就绪时静默降级为单配置模式
  } finally {
    loading.value = false
  }
}

/** 新建预设：输入名称后创建（同步三表占位行并激活，若为首个） */
async function handleCreatePreset(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('为新的语音配置预设起个名字（例如「日常对话」「外语学习」）', '新建语音预设', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputPattern: /\S+/,
      inputErrorMessage: '名称不能为空',
      inputValue: `语音配置 ${presets.value.length + 1}`,
    })
    await api.createPreset(value.trim())
    ElMessage.success('语音预设已创建')
    await loadPresets()
  } catch {
    // cancelled
  }
}

/** 激活指定预设 */
async function handleActivatePreset(preset: VoicePresetDto): Promise<void> {
  if (preset.isActive) return
  busyPresetId.value = preset.id
  try {
    await api.activatePreset(preset.id)
    ElMessage.success(`已切换当前语音为「${preset.name}」`)
    await loadPresets()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '激活语音预设失败')
  } finally {
    busyPresetId.value = null
  }
}

/** 删除预设 */
async function handleDeletePreset(preset: VoicePresetDto): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除语音预设「${preset.name}」吗？`, '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await api.deletePreset(preset.id)
    ElMessage.success('语音预设已删除')
    await loadPresets()
  } catch {
    // cancelled
  }
}

/** 当前激活预设的三块配置摘要（用于卡片展示） */
function presetMeta(preset: VoicePresetDto): string {
  const parts: string[] = []
  if (preset.local) parts.push(`本地输出 · ${preset.local.modelId || '未配置'}`)
  if (preset.remote) parts.push(`在线输出 · ${preset.remote.modelId || '未配置'}`)
  if (preset.input) parts.push(`语音输入 · ${preset.input.modelId || '未配置'}`)
  return parts.length > 0 ? parts.join(' / ') : '尚无配置'
}
</script>

<template>
  <div class="voice-preset-panel">
    <!-- 多预设：卡片列表（对齐人格设定同款交互） -->
    <div v-if="loading" class="pcfg-loading">加载语音预设…</div>
    <template v-else>
      <div class="voice-preset-header">
        <strong class="voice-preset-title">语音预设</strong>
        <button type="button" class="voice-preset-add-btn" @click="handleCreatePreset">
          <Plus :size="15" />新建预设
        </button>
      </div>
      <div class="voice-preset-grid">
        <article
          v-for="preset in presets"
          :key="preset.id"
          class="voice-preset-card"
          :class="{active: preset.id === activePresetId}"
        >
          <div class="voice-preset-card-head">
            <strong class="voice-preset-name">{{ preset.name }}</strong>
            <span v-if="preset.id === activePresetId" class="voice-preset-active-badge">
              <Sparkles :size="11" />当前
            </span>
          </div>
          <small class="voice-preset-meta">{{ presetMeta(preset) }}</small>
          <div class="voice-preset-actions">
            <button
              v-if="preset.id !== activePresetId"
              type="button"
              class="voice-preset-action"
              :disabled="busyPresetId === preset.id"
              @click="handleActivatePreset(preset)"
            >设为当前</button>
            <button
              type="button"
              class="voice-preset-action danger"
              :disabled="busyPresetId === preset.id"
              @click="handleDeletePreset(preset)"
            >
              <Trash2 :size="12" />删除
            </button>
          </div>
        </article>
      </div>
    </template>

    <!-- 模式切换与配置编辑（读写当前激活预设） -->
    <div class="voice-mode-toggle">
      <button
        type="button"
        class="voice-mode-btn"
        :class="{active: voiceMode === 'local'}"
        @click="voiceMode = 'local'"
      >
        <Mic :size="14" />本地模型
      </button>
      <button
        type="button"
        class="voice-mode-btn"
        :class="{active: voiceMode === 'online'}"
        @click="voiceMode = 'online'"
      >
        <Volume2 :size="14" />在线模型
      </button>
    </div>
    <LocalVoiceConfigPanel v-if="voiceMode === 'local'" />
    <RemoteVoiceConfigPanel v-else />
  </div>
</template>

<style scoped>
.voice-preset-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 0 10px;
}

.voice-preset-title {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.voice-preset-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.voice-preset-add-btn:hover {
  background: var(--accent);
  color: #fff;
}

.voice-preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}

.voice-preset-card {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-main);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.voice-preset-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
}

.voice-preset-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.voice-preset-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-preset-active-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}

.voice-preset-meta {
  display: block;
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-preset-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.voice-preset-action {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.voice-preset-action:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.voice-preset-action.danger:hover:not(:disabled) {
  border-color: var(--danger, #e5484d);
  color: var(--danger, #e5484d);
}

.voice-preset-action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.voice-mode-toggle {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-soft);
  margin-bottom: 14px;
}

.voice-mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  transition: all 0.15s ease;
}

.voice-mode-btn.active {
  background: var(--bg-main);
  color: var(--accent);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}
</style>