<script setup lang="ts">
import { AervoxCard, AervoxSwitch, AervoxSettingsHeading, AervoxButton } from '../../primitives';
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from '../../utils/element'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-vue-next'
import {
  useAervoxLLM,
  type LLMConfigDto,
  type LLMPresetDto,
  type LLMProviderType,
  type LLMTestConnectionResultDto,
} from '@aervox/api-client'

const api = useAervoxLLM()

const config = ref<LLMConfigDto | null>(null)
const loading = ref(true)
const saving = ref(false)
const savedFlash = ref(false)
const savedSnapshot = ref('')
const showApiKey = ref(false)
const showAdvanced = ref(false)
const testBusy = ref(false)
const testResult = ref<LLMTestConnectionResultDto | null>(null)
const error = ref<string | null>(null)
/** 连通性测试探测到的可用模型列表（本地端点 /models 自动感知） */
const detectedModels = ref<string[]>([])

/** 多预设：全部预设 + 当前激活 */
const presets = ref<LLMPresetDto[]>([])
const presetsLoading = ref(false)
const activePresetId = ref<string | null>(null)
const busyPresetId = ref<string | null>(null)

const draft = computed<LLMConfigDto>({
  get() {
    return (
      config.value ?? {
        enabled: true,
        providerType: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: '',
        modelId: 'llama3.2',
        temperature: 0.7,
        maxTokens: 4096,
        settings: {},
      }
    )
  },
  set(val) {
    config.value = val
  },
})

const hasUnsavedChanges = computed(() => Boolean(savedSnapshot.value)
  && JSON.stringify(draft.value) !== savedSnapshot.value)

function discardDraft() {
  if (savedSnapshot.value) config.value = JSON.parse(savedSnapshot.value) as LLMConfigDto
}

watch(() => JSON.stringify(draft.value), () => {
  testResult.value = null
  detectedModels.value = []
})

async function confirmReplaceDraft(): Promise<boolean> {
  if (!hasUnsavedChanges.value) return true
  try {
    await ElMessageBox.confirm('当前配置有未保存的修改，继续会放弃这些修改。', '切换模型预设', {
      confirmButtonText: '放弃修改并继续',
      cancelButtonText: '返回编辑',
      type: 'warning',
    })
    return true
  } catch {
    return false
  }
}

const currentPreset = computed(() => {
  return api.presetProviders.find((p) => p.id === draft.value.providerType)
})

const activePreset = computed(() => {
  return presets.value.find((p) => p.id === activePresetId.value) ?? null
})

onMounted(async () => {
  await Promise.all([loadConfig(), loadPresets()])
  loading.value = false
})

onActivated(() => {
  if (!loading.value && !hasUnsavedChanges.value) {
    void Promise.all([loadConfig(), loadPresets()])
  }
})

async function loadConfig(): Promise<void> {
  const previousDraft = JSON.stringify(draft.value)
  try {
    const loaded = await api.getConfig()
    if (JSON.stringify(draft.value) !== previousDraft) return
    config.value = loaded
    savedSnapshot.value = JSON.stringify(loaded)
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取大语言模型配置失败'
  }
}

/** 加载全部预设并同步激活标记 */
async function loadPresets(): Promise<void> {
  presetsLoading.value = true
  try {
    const res = await api.listPresets()
    presets.value = res.presets ?? []
    activePresetId.value = res.activeId ?? null
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载模型预设失败'
  } finally {
    presetsLoading.value = false
  }
}

/** 新建预设：输入名称后创建并自动激活 */
async function handleCreatePreset(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('为新的模型配置预设起个名字（例如「本地 Ollama」「DeepSeek Chat」）', '新建模型预设', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputPattern: /\S+/,
      inputErrorMessage: '名称不能为空',
      inputValue: `配置 ${presets.value.length + 1}`,
    })
    const created = await api.createPreset(value.trim(), draft.value)
    ElMessage.success(`已创建预设「${created.name}」并设为当前`)
    await Promise.all([loadPresets(), loadConfig()])
  } catch {
    // cancelled
  }
}

/** 激活指定预设并加载其配置 */
async function handleActivatePreset(preset: LLMPresetDto): Promise<void> {
  if (saving.value || busyPresetId.value) return
  if (preset.isActive) return
  if (!(await confirmReplaceDraft())) return
  busyPresetId.value = preset.id
  try {
    await api.activatePreset(preset.id)
    ElMessage.success(`已切换当前模型为「${preset.name}」`)
    await Promise.all([loadPresets(), loadConfig()])
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '激活预设失败')
  } finally {
    busyPresetId.value = null
  }
}

/** 删除预设 */
async function handleDeletePreset(preset: LLMPresetDto): Promise<void> {
  if (saving.value || busyPresetId.value) return
  if (!(await confirmReplaceDraft())) return
  try {
    await ElMessageBox.confirm(`确定删除模型预设「${preset.name}」吗？`, '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await api.deletePreset(preset.id)
    ElMessage.success('模型预设已删除')
    await Promise.all([loadPresets(), loadConfig()])
  } catch {
    // cancelled
  }
}

function handleProviderChange(providerId: LLMProviderType) {
  const preset = api.presetProviders.find((p) => p.id === providerId)
  if (preset) {
    draft.value = {
      ...draft.value,
      providerType: providerId,
      baseUrl: preset.defaultBaseUrl,
      modelId: preset.recommendedModels[0] || draft.value.modelId,
    }
  } else {
    draft.value = {
      ...draft.value,
      providerType: providerId,
    }
  }
}

async function handleTestConnection(): Promise<void> {
  if (!draft.value.baseUrl.trim()) {
    error.value = '请先填写服务 Base URL'
    return
  }
  if (!draft.value.modelId.trim()) {
    error.value = '请先填写模型 ID'
    return
  }

  testBusy.value = true
  const testedDraft = JSON.stringify(draft.value)
  testResult.value = null
  error.value = null
  detectedModels.value = []

  try {
    const res = await api.testConnection({
      providerType: draft.value.providerType,
      baseUrl: draft.value.baseUrl.trim(),
      apiKey: draft.value.apiKey?.trim() || undefined,
      modelId: draft.value.modelId.trim(),
    })
    if (JSON.stringify(draft.value) !== testedDraft) return
    testResult.value = res
    // 本地端点 /models 自动感知：探测到可用模型时供一键选择
    if (res.ok && Array.isArray(res.availableModels) && res.availableModels.length > 0) {
      detectedModels.value = res.availableModels
    }
  } catch (e) {
    if (JSON.stringify(draft.value) !== testedDraft) return
    testResult.value = {
      ok: false,
      latencyMs: 0,
      message: e instanceof Error ? e.message : '连通性测试请求失败',
    }
  } finally {
    testBusy.value = false
  }
}

/** 应用探测到的模型：填充 modelId 并保持其它字段不变 */
function applyDetectedModel(modelId: string) {
  draft.value = { ...draft.value, modelId }
}

async function handleSave(): Promise<void> {
  if (!draft.value.baseUrl.trim()) {
    error.value = 'Base URL 不能为空'
    return
  }
  if (!draft.value.modelId.trim()) {
    error.value = '模型 ID 不能为空'
    return
  }

  saving.value = true
  const submittedDraft = JSON.stringify(draft.value)
  error.value = null

  try {
    const saved = await api.saveConfig({
      enabled: draft.value.enabled,
      providerType: draft.value.providerType,
      baseUrl: draft.value.baseUrl.trim(),
      apiKey: draft.value.apiKey?.trim() || undefined,
      modelId: draft.value.modelId.trim(),
      temperature: Number(draft.value.temperature) || 0.7,
      maxTokens: Number(draft.value.maxTokens) || 4096,
      settings: draft.value.settings ?? {},
    })
    savedSnapshot.value = JSON.stringify(saved)
    if (JSON.stringify(draft.value) === submittedDraft) config.value = saved
    savedFlash.value = true
    await loadPresets()
    setTimeout(() => {
      savedFlash.value = false
    }, 1600)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存配置失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="llm-config-panel">
    <AervoxSettingsHeading title="模型与服务" description="配置大语言模型供应商与运行时调用参数" />

    <!-- 多预设：卡片列表（对齐人格设定同款交互） -->
    <div v-if="presetsLoading" class="pcfg-loading">加载模型预设…</div>
    <div v-else class="llm-preset-header">
      <strong class="llm-preset-title">模型预设</strong>
      <AervoxButton variant="secondary" type="button" class="llm-preset-add-btn" @click="handleCreatePreset">
        <Plus :size="15" />新建预设
      </AervoxButton>
    </div>
    <div v-if="!presetsLoading" class="settings-list llm-preset-grid">
      <AervoxCard as="article"
        v-for="preset in presets"
        :key="preset.id"
        class="settings-item llm-preset-card"
        :class="{active: preset.id === activePresetId}"
      >
        <div class="llm-preset-card-head">
          <strong class="llm-preset-name">{{ preset.name }}</strong>
          <span v-if="preset.id === activePresetId" class="aervox-badge llm-preset-active-badge">
            <Sparkles :size="11" />当前
          </span>
        </div>
        <small class="llm-preset-meta">
          {{ preset.providerType }} · {{ preset.modelId }}
        </small>
        <div class="llm-preset-actions">
          <AervoxButton variant="secondary"
            v-if="preset.id !== activePresetId"
            type="button"
            class="llm-preset-action"
            :disabled="saving || Boolean(busyPresetId)"
            @click="handleActivatePreset(preset)"
          >设为当前</AervoxButton>
          <AervoxButton variant="danger"
            type="button"
            class="llm-preset-action danger"
            :disabled="saving || Boolean(busyPresetId)"
            @click="handleDeletePreset(preset)"
          >
            <Trash2 :size="12" />删除
          </AervoxButton>
        </div>
      </AervoxCard>
    </div>

    <div v-if="loading" class="pcfg-loading">加载模型配置…</div>

    <template v-else>
      <label class="settings-row settings-choice-row">
        <span><strong>启用大模型服务</strong><small>控制是否在会话中启用此模型配置</small></span>
        <AervoxSwitch v-model="draft.enabled"   />
      </label>

      <div class="settings-field">
        <span><strong>模型供应商</strong><small>选择主流预设或自定义兼容端点</small></span>
        <select
          :value="draft.providerType"
          aria-label="模型供应商"
          class="aervox-field llm-select-field"
          @change="handleProviderChange(($event.target as HTMLSelectElement).value as LLMProviderType)"
        >
          <option
            v-for="provider in api.presetProviders"
            :key="provider.id"
            :value="provider.id"
          >
            {{ provider.name }}
          </option>
        </select>
      </div>

      <div class="settings-field">
        <span><strong>服务基址 (Base URL)</strong><small>{{ currentPreset?.description }}</small></span>
        <input
          v-model="draft.baseUrl"
          aria-label="服务基址"
          type="text"
          class="aervox-field llm-input-field"
          placeholder="http://127.0.0.1:11434/v1"
        />
      </div>

      <div class="settings-field">
        <span>
          <strong>API Key</strong>
          <small>{{ currentPreset?.requiresApiKey ? '访问服务所需的授权密钥' : '本地模型通常无需 API Key，留空即可' }}</small>
        </span>
        <div class="api-key-input-wrapper">
          <input
            v-model="draft.apiKey"
            aria-label="API Key"
            :type="showApiKey ? 'text' : 'password'"
            class="aervox-field llm-input-field key-input"
            placeholder="sk-..."
            autocomplete="off"
          />
          <AervoxButton variant="secondary" icon-only
            type="button"
            class="key-toggle-btn"
            :title="showApiKey ? '隐藏密钥' : '查看密钥'"
            @click="showApiKey = !showApiKey"
          >
            <EyeOff v-if="showApiKey" :size="15" />
            <Eye v-else :size="15" />
          </AervoxButton>
        </div>
      </div>

      <div class="settings-field">
        <span><strong>模型名称 (Model ID)</strong><small>要调用的具体模型标识符</small></span>
        <input
          v-model="draft.modelId"
          aria-label="模型名称"
          type="text"
          class="aervox-field llm-input-field"
          placeholder="llama3.2"
          list="recommended-llm-models"
        />
        <datalist id="recommended-llm-models">
          <option
            v-for="model in currentPreset?.recommendedModels || []"
            :key="model"
            :value="model"
          >
            {{ model }}
          </option>
        </datalist>
      </div>

      <div class="advanced-section">
        <button
          type="button"
          class="advanced-toggle"
          @click="showAdvanced = !showAdvanced"
        >
          <span>高级推理参数 (Temperature / Max Tokens)</span>
          <ChevronUp v-if="showAdvanced" :size="16" />
          <ChevronDown v-else :size="16" />
        </button>

        <div v-if="showAdvanced" class="advanced-content">
          <div class="settings-field">
            <span><strong>采样温度 (Temperature)</strong><small>值越低回答越聚焦稳定，值越高越具发散性 (0.0 ~ 2.0)</small></span>
            <div class="slider-field-row">
              <input
                v-model.number="draft.temperature"
                type="range"
                min="0"
                max="2"
                step="0.05"
                class="aervox-range llm-slider"
              />
              <span class="aervox-badge slider-value-badge">{{ draft.temperature }}</span>
            </div>
          </div>

          <div class="settings-field">
            <span><strong>最大生成长度 (Max Tokens)</strong><small>单次回答允许生成的最大 Token 数量</small></span>
            <input
              v-model.number="draft.maxTokens"
              type="number"
              min="128"
              max="65536"
              step="256"
              class="aervox-field llm-input-field number-input"
              placeholder="4096"
            />
          </div>
        </div>
      </div>

      <div class="settings-note llm-actions">
        <div class="llm-save-status" role="status">
          <strong>{{ saving ? '正在保存…' : hasUnsavedChanges ? '有未保存的修改' : savedFlash ? '配置已保存' : '保存后生效' }}</strong>
          <small>{{ hasUnsavedChanges ? '切换分类时会保留草稿' : '模型配置需要手动保存' }}</small>
        </div>
        <AervoxButton variant="secondary" v-if="hasUnsavedChanges" type="button" class="llm-action-btn" :disabled="saving" @click="discardDraft">放弃修改</AervoxButton>
        <AervoxButton variant="secondary"
          type="button"
          class="llm-action-btn test-btn"
          :disabled="testBusy"
          @click="handleTestConnection"
        >
          <Zap :size="15" />
          {{ testBusy ? '测试连接中…' : '测试连接' }}
        </AervoxButton>
        <AervoxButton variant="primary"
          type="button"
          class="llm-action-btn save-btn"
          :disabled="saving || Boolean(busyPresetId) || !savedSnapshot"
          @click="handleSave"
        >
          <Check v-if="savedFlash" :size="15" />
          <RotateCcw v-else :size="15" />
          {{ saving ? '保存中…' : savedFlash ? '已保存' : '保存配置' }}
        </AervoxButton>
      </div>

      <div
        v-if="testResult"
        class="test-result-badge"
        :class="{ success: testResult.ok, failure: !testResult.ok }"
      >
        <span class="result-status-dot" />
        <span>{{ testResult.message }}</span>
        <small v-if="testResult.latencyMs > 0">时延 {{ testResult.latencyMs }}ms</small>
      </div>

      <!-- 能力探测标注：上下文窗口 / 工具调用（连通性测试顺带感知） -->
      <div v-if="testResult?.ok && testResult.capabilities" class="capabilities-row">
        <span v-if="testResult.capabilities.contextWindow" class="capability-chip">
          上下文窗口 <strong>{{ testResult.capabilities.contextWindow }}</strong> tokens
        </span>
        <span
          v-if="testResult.capabilities.supportsToolCalls !== undefined"
          class="capability-chip"
          :class="testResult.capabilities.supportsToolCalls ? 'chip-ok' : 'chip-warn'"
        >
          工具调用 <strong>{{ testResult.capabilities.supportsToolCalls ? '支持' : '不支持' }}</strong>
        </span>
        <span class="capability-hint">已自动按上下文窗口收紧最大生成长度</span>
      </div>

      <!-- 本地端点 /models 自动感知：探测到可用模型时提供一键选择 -->
      <div v-if="detectedModels.length > 0" class="detected-models-row">
        <span class="detected-models-label">探测到 {{ detectedModels.length }} 个可用模型：</span>
        <select
          class="aervox-field llm-select-field detected-model-select"
          :value="draft.modelId"
          @change="applyDetectedModel(($event.target as HTMLSelectElement).value)"
        >
          <option :value="draft.modelId" disabled>选择模型…</option>
          <option v-for="model in detectedModels" :key="model" :value="model">
            {{ model }}
          </option>
        </select>
      </div>

      <p v-if="error" class="llm-error" role="alert">{{ error }}</p>
      <AervoxButton variant="secondary" v-if="!savedSnapshot" type="button" class="llm-action-btn" @click="loadConfig">重新加载配置</AervoxButton>
    </template>
  </div>
</template>

<style scoped>
.llm-preset-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 0 10px;
}

.llm-preset-title {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.llm-preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}

.llm-preset-card {
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.llm-preset-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.llm-preset-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.llm-preset-active-badge {
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

.llm-preset-meta {
  display: block;
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.llm-preset-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.llm-select-field,
.llm-input-field {
  width: min(380px, 58%);

}

.api-key-input-wrapper {
  width: min(380px, 58%);
  display: flex;
  align-items: center;
  gap: 6px;
}

.api-key-input-wrapper .key-input {
  flex: 1;
  width: auto;
}

.advanced-section {
  margin-top: 10px;
  margin-bottom: 12px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  background: var(--bg-soft, rgba(0, 0, 0, 0.02));
}

.advanced-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  border: none;
  background: transparent;
  padding: 0;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
}

.advanced-toggle:hover {
  color: var(--text-primary);
}

.advanced-content {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.slider-field-row {
  width: min(380px, 58%);
  display: flex;
  align-items: center;
  gap: 12px;
}

.llm-slider {
  flex: 1;

}

.slider-value-badge {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  min-width: 32px;
}

.number-input {
  width: 120px;
}

.llm-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
  position: sticky;
  bottom: -32px;
  z-index: 1;
  padding: 14px 0;
  border-top: 1px solid var(--border);
  background: var(--bg-main);
}

.llm-save-status { display: grid; gap: 3px; flex: 1 0 150px; color: var(--text-primary); }
.llm-save-status strong { font-size: 13px; font-weight: 500; }
.llm-save-status small { font-size: 12px; color: var(--text-secondary); }

.test-result-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  margin-top: 8px;
}

.test-result-badge.success {
  background: color-mix(in srgb, #22c55e 12%, transparent);
  color: #16a34a;
  border: 1px solid color-mix(in srgb, #22c55e 30%, transparent);
}

.test-result-badge.failure {
  background: color-mix(in srgb, #ef4444 12%, transparent);
  color: #dc2626;
  border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
}

.result-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.capabilities-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-soft, rgba(0, 0, 0, 0.02));
}

.capability-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--text-secondary);
  font-size: 11px;
}

.capability-chip strong {
  color: var(--text-primary);
  font-weight: 650;
}

.capability-chip.chip-ok {
  background: color-mix(in srgb, #22c55e 12%, transparent);
}

.capability-chip.chip-warn {
  background: color-mix(in srgb, #f59e0b 14%, transparent);
}

.capability-hint {
  color: var(--text-secondary);
  font-size: 11px;
  margin-left: auto;
}

.detected-models-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.detected-models-label {
  color: var(--text-secondary);
  font-size: 12px;
}

.detected-model-select {
  width: min(320px, 46%);
}

.llm-error {
  margin-top: 10px;
  color: var(--danger, #e5484d);
  font-size: 12px;
}
</style>
