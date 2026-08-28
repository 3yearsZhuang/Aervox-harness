<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  RotateCcw,
  Zap,
} from 'lucide-vue-next'
import {
  useAervoxLLM,
  type LLMConfigDto,
  type LLMProviderType,
  type LLMTestConnectionResultDto,
} from '@aervox/api-client'

const api = useAervoxLLM()

const config = ref<LLMConfigDto | null>(null)
const loading = ref(true)
const saving = ref(false)
const savedFlash = ref(false)
const showApiKey = ref(false)
const showAdvanced = ref(false)
const testBusy = ref(false)
const testResult = ref<LLMTestConnectionResultDto | null>(null)
const error = ref<string | null>(null)

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

const currentPreset = computed(() => {
  return api.presetProviders.find((p) => p.id === draft.value.providerType)
})

onMounted(async () => {
  await loadConfig()
  loading.value = false
})

async function loadConfig(): Promise<void> {
  try {
    config.value = await api.getConfig()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取大语言模型配置失败'
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
  testResult.value = null
  error.value = null

  try {
    const res = await api.testConnection({
      providerType: draft.value.providerType,
      baseUrl: draft.value.baseUrl.trim(),
      apiKey: draft.value.apiKey?.trim() || undefined,
      modelId: draft.value.modelId.trim(),
    })
    testResult.value = res
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
  error.value = null

  try {
    config.value = await api.saveConfig({
      enabled: draft.value.enabled,
      providerType: draft.value.providerType,
      baseUrl: draft.value.baseUrl.trim(),
      apiKey: draft.value.apiKey?.trim() || undefined,
      modelId: draft.value.modelId.trim(),
      temperature: Number(draft.value.temperature) || 0.7,
      maxTokens: Number(draft.value.maxTokens) || 4096,
      settings: draft.value.settings ?? {},
    })
    savedFlash.value = true
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
    <div class="settings-section-heading">
      <span class="heading-icon-wrap"><Bot :size="18" /></span>
      <span><strong>模型与服务</strong><small>配置大语言模型供应商与运行时调用参数</small></span>
    </div>

    <div v-if="loading" class="pcfg-loading">加载模型配置…</div>

    <template v-else>
      <label class="settings-row settings-choice-row">
        <span><strong>启用大模型服务</strong><small>控制是否在会话中启用此模型配置</small></span>
        <input v-model="draft.enabled" type="checkbox" class="settings-switch" />
      </label>

      <div class="settings-field">
        <span><strong>模型供应商</strong><small>选择主流预设或自定义兼容端点</small></span>
        <select
          :value="draft.providerType"
          class="llm-select-field"
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
          type="text"
          class="llm-input-field"
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
            :type="showApiKey ? 'text' : 'password'"
            class="llm-input-field key-input"
            placeholder="sk-..."
            autocomplete="off"
          />
          <button
            type="button"
            class="key-toggle-btn"
            :title="showApiKey ? '隐藏密钥' : '查看密钥'"
            @click="showApiKey = !showApiKey"
          >
            <EyeOff v-if="showApiKey" :size="15" />
            <Eye v-else :size="15" />
          </button>
        </div>
      </div>

      <div class="settings-field">
        <span><strong>模型名称 (Model ID)</strong><small>要调用的具体模型标识符</small></span>
        <input
          v-model="draft.modelId"
          type="text"
          class="llm-input-field"
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
                class="llm-slider"
              />
              <span class="slider-value-badge">{{ draft.temperature }}</span>
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
              class="llm-input-field number-input"
              placeholder="4096"
            />
          </div>
        </div>
      </div>

      <div class="settings-note llm-actions">
        <button
          type="button"
          class="llm-action-btn test-btn"
          :disabled="testBusy"
          @click="handleTestConnection"
        >
          <Zap :size="15" />
          {{ testBusy ? '测试连接中…' : '测试连接' }}
        </button>
        <button
          type="button"
          class="llm-action-btn save-btn"
          :disabled="saving"
          @click="handleSave"
        >
          <Check v-if="savedFlash" :size="15" />
          <RotateCcw v-else :size="15" />
          {{ saving ? '保存中…' : savedFlash ? '已保存' : '保存配置' }}
        </button>
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

      <p v-if="error" class="llm-error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.llm-select-field,
.llm-input-field {
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

.llm-select-field:focus,
.llm-input-field:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
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

.key-toggle-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.key-toggle-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
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
  accent-color: var(--accent);
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
}

.llm-action-btn {
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

.llm-action-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.llm-action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.test-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

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

.llm-error {
  margin-top: 10px;
  color: var(--danger, #e5484d);
  font-size: 12px;
}
</style>
