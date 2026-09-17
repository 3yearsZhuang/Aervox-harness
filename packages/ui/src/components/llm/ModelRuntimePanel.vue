<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from '../../utils/element'
import {
  Check,
  Cpu,
  Download,
  ExternalLink,
  Loader2,
  Play,
  Power,
  RotateCw,
  Square,
  Trash2,
  X,
  Zap,
} from 'lucide-vue-next'
import {
  useAervoxModelRuntime,
  useAervoxLLM,
  type ModelRuntimeStateDto,
  type LocalModelDto,
} from '@aervox/api-client'

const runtime = useAervoxModelRuntime()
const llm = useAervoxLLM()

const state = ref<ModelRuntimeStateDto | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

// 下载表单
const downloadUrl = ref('')
const downloadSha = ref('')
const downloadBusy = ref(false)

// 启动参数（默认对齐服务端默认值 8080 / 8192 / 99 / 4）
const port = ref(8080)
const ctxSize = ref(8192)
const gpuLayers = ref(99)
const threads = ref(4)
const startBusy = ref(false)
const stopBusy = ref(false)
const selectedModelId = ref<string | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null

/** 下载进度（0~100），未知总量时显示已收字节 */
const downloadProgress = computed(() => {
  const d = state.value?.download
  if (!d?.active || d.totalBytes === undefined || d.totalBytes === null || d.totalBytes === 0) return null
  return Math.min(100, Math.round(((d.receivedBytes ?? 0) / d.totalBytes) * 100))
})

const downloadBytesLabel = computed(() => {
  const d = state.value?.download
  if (!d) return ''
  return `${formatBytes(d.receivedBytes ?? 0)}${d.totalBytes ? ` / ${formatBytes(d.totalBytes)}` : ''}`
})

const runtimeRunning = computed(() => state.value?.runtime.status === 'running' || state.value?.runtime.status === 'starting')
const selectedModel = computed<LocalModelDto | null>(() => {
  const id = selectedModelId.value
  return state.value?.models.find((m) => m.id === id) ?? state.value?.models[0] ?? null
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(1)} ${units[unit]}`
}

function formatSize(size?: number): string {
  return size === undefined ? '—' : formatBytes(size)
}

async function refresh(): Promise<void> {
  try {
    state.value = await runtime.getState()
    // 同步启动参数默认值（首次加载或参数面板未初始化时）
    if (state.value?.params) {
      port.value = state.value.params.port
      ctxSize.value = state.value.params.ctxSize
      gpuLayers.value = state.value.params.gpuLayers
      threads.value = state.value.params.threads
    }
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取本地模型运行时状态失败'
  } finally {
    loading.value = false
  }
}

/** 轮询策略：下载中或运行时持续刷新，否则放缓（仅手动刷新可用） */
function ensurePolling(): void {
  const needPoll = Boolean(state.value?.download.active || runtimeRunning.value)
  if (needPoll && !pollTimer) {
    pollTimer = setInterval(() => void refresh(), 1200)
  } else if (!needPoll && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function handleDownload(): Promise<void> {
  const url = downloadUrl.value.trim()
  if (!url) {
    error.value = '请填写模型下载地址（GGUF 文件 URL）'
    return
  }
  downloadBusy.value = true
  error.value = null
  try {
    state.value = await runtime.download({
      url,
      sha256: downloadSha.value.trim() || undefined,
    })
    downloadUrl.value = ''
    downloadSha.value = ''
    ElMessage.success('已开始下载模型')
  } catch (e) {
    const msg = e instanceof Error ? e.message : '发起下载失败'
    error.value = msg.includes('download_busy') ? '已有下载任务进行中' : msg
    ElMessage.error(error.value)
  } finally {
    downloadBusy.value = false
    refresh()
  }
}

async function handleCancelDownload(): Promise<void> {
  try {
    state.value = await runtime.cancelDownload()
    ElMessage.info('已取消下载')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '取消失败'
  }
}

async function handleStart(): Promise<void> {
  const model = selectedModel.value
  if (!model) {
    error.value = '请先选择要启动的模型'
    return
  }
  startBusy.value = true
  error.value = null
  try {
    state.value = await runtime.start({
      modelId: model.id,
      params: { port: Number(port.value), ctxSize: Number(ctxSize.value), gpuLayers: Number(gpuLayers.value), threads: Number(threads.value) },
    })
    ElMessage.success(`llama-server 已启动：http://127.0.0.1:${port.value}/v1`)
    // 联动 LLM 预设（CR-053/054）：自动切换到 llamacpp 并填充 baseUrl/modelId、回写上下文窗口
    await syncLlmPreset()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '启动失败'
    ElMessage.error(error.value)
  } finally {
    startBusy.value = false
    refresh()
  }
}

async function handleStop(): Promise<void> {
  stopBusy.value = true
  try {
    await runtime.stop()
    ElMessage.info('llama-server 已停止')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '停止失败'
  } finally {
    stopBusy.value = false
    refresh()
  }
}

/** 联动：将当前激活配置切换为 llama.cpp 本地端点并回写探测到的上下文窗口 */
async function syncLlmPreset(): Promise<void> {
  const model = selectedModel.value
  if (!model) return
  try {
    const current = await llm.getConfig()
    await llm.saveConfig({
      ...current,
      providerType: 'llamacpp',
      baseUrl: `http://127.0.0.1:${Number(port.value)}/v1`,
      modelId: model.id,
      settings: { ...(current.settings ?? {}), contextWindow: Number(ctxSize.value) },
    })
    ElMessage.success('已切换到 llama.cpp 模型预设并回写上下文窗口')
  } catch {
    // 联动失败不阻断启动流程
    ElMessage.warning('已启动，但自动切换 LLM 预设失败，请到「模型与服务」手动配置')
  }
}

onMounted(async () => {
  await refresh()
  if (state.value?.models.length && !selectedModelId.value) {
    selectedModelId.value = state.value.models[0].id
  }
  ensurePolling()
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="model-runtime-panel">
    <div class="settings-section-heading">
      <span class="heading-icon-wrap"><Cpu :size="18" /></span>
      <span><strong>本地模型</strong><small>GGUF 下载与 llama.cpp（llama-server）运行管理</small></span>
    </div>

    <div v-if="loading" class="mr-loading">加载本地模型状态…</div>

    <template v-else>
      <!-- llama-server 可用性提示 -->
      <div
        v-if="state?.llamaServer && !state.llamaServer.configured"
        class="mr-banner mr-banner-warn"
      >
        未找到 llama-server 可执行文件。请安装 llama.cpp，或在启动环境设置
        <code>AERVOX_LLAMA_SERVER_PATH</code> 指向 llama-server 路径。
      </div>

      <!-- 运行时状态卡 -->
      <div v-if="runtimeRunning" class="mr-runtime-card">
        <span class="mr-runtime-dot" :class="{ active: state?.runtime.status === 'running' }" />
        <strong>{{ state?.runtime.status === 'running' ? '运行中' : '启动中…' }}</strong>
        <small v-if="state?.runtime.port">端口 {{ state?.runtime.port }}</small>
        <small v-if="state?.runtime.modelId">模型 {{ state?.runtime.modelId }}</small>
        <small v-if="state?.runtime.pid">PID {{ state?.runtime.pid }}</small>
        <span class="mr-runtime-actions">
          <button type="button" class="mr-btn mr-btn-danger" :disabled="stopBusy" @click="handleStop">
            <Power :size="13" />{{ stopBusy ? '停止中…' : '停止' }}
          </button>
        </span>
      </div>

      <!-- 下载区 -->
      <div class="mr-section">
        <div class="mr-section-title">下载模型</div>
        <div class="mr-download-form">
          <input
            v-model="downloadUrl"
            type="url"
            class="mr-input mr-input-url"
            placeholder="GGUF 文件 URL（如 https://huggingface.co/.../model-q4_k_m.gguf）"
            :disabled="state?.download.active"
          />
          <input
            v-model="downloadSha"
            type="text"
            class="mr-input mr-input-mono"
            placeholder="SHA-256（可选，填写则强制校验）"
            :disabled="state?.download.active"
          />
          <button
            type="button"
            class="mr-btn mr-btn-primary"
            :disabled="downloadBusy || state?.download.active"
            @click="handleDownload"
          >
            <Download :size="14" />{{ state?.download.active ? '下载中…' : '开始下载' }}
          </button>
        </div>

        <div v-if="state?.download.active" class="mr-download-progress">
          <div class="mr-progress-track">
            <div
              class="mr-progress-bar"
              :style="{ width: `${downloadProgress ?? 100}%` }"
            />
          </div>
          <span class="mr-progress-label">
            {{ state.download.modelId ?? '模型' }} · {{ downloadBytesLabel }}
            <span v-if="downloadProgress !== null">{{ downloadProgress }}%</span>
          </span>
          <button type="button" class="mr-btn mr-btn-ghost" @click="handleCancelDownload">
            <X :size="12" />取消
          </button>
        </div>
        <div v-if="state?.download.status === 'error' && state.download.error" class="mr-error-text">
          {{ state.download.error }}
        </div>
      </div>

      <!-- 已下载模型 + 启动参数 -->
      <div class="mr-section">
        <div class="mr-section-title">本地模型与启动</div>

        <div v-if="!state?.models.length" class="mr-empty">
          暂无已下载模型。在上方填写 GGUF URL 开始下载，或将 .gguf 文件放入 data/models/。
        </div>

        <template v-else>
          <div class="mr-model-list">
            <label
              v-for="model in state?.models"
              :key="model.id"
              class="mr-model-row"
              :class="{ selected: selectedModelId === model.id }"
            >
              <input
                type="radio"
                :checked="selectedModelId === model.id"
                @change="selectedModelId = model.id"
              />
              <span class="mr-model-name">{{ model.fileName }}</span>
              <span class="mr-model-meta">{{ formatSize(model.sizeBytes) }}</span>
              <span v-if="model.sha256" class="mr-model-meta mono" :title="model.sha256">sha256 已校验</span>
            </label>
          </div>

          <div class="mr-params-grid">
            <label class="mr-param-field">
              <span>端口 (--port)</span>
              <input v-model.number="port" type="number" min="1024" max="65535" class="mr-input" />
            </label>
            <label class="mr-param-field">
              <span>上下文 (-c)</span>
              <input v-model.number="ctxSize" type="number" min="512" step="512" class="mr-input" />
            </label>
            <label class="mr-param-field">
              <span>GPU 层数 (-ngl)</span>
              <input v-model.number="gpuLayers" type="number" min="0" class="mr-input" />
            </label>
            <label class="mr-param-field">
              <span>线程 (-t)</span>
              <input v-model.number="threads" type="number" min="1" max="64" class="mr-input" />
            </label>
          </div>

          <div class="mr-actions">
            <button
              type="button"
              class="mr-btn mr-btn-primary"
              :disabled="startBusy || runtimeRunning"
              @click="handleStart"
            >
              <Loader2 v-if="startBusy" :size="14" class="spin" />
              <Play v-else :size="14" />
              {{ runtimeRunning ? '运行中' : '启动服务' }}
            </button>
            <span class="mr-hint">启动成功后自动切换到 llama.cpp 模型预设</span>
          </div>
        </template>
      </div>

      <p v-if="error" class="mr-error-text">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.model-runtime-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.mr-loading {
  color: var(--text-secondary);
  font-size: 12.5px;
  padding: 12px 0;
}

.mr-banner {
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
}

.mr-banner-warn {
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  color: #b45309;
  border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent);
}

.mr-banner code {
  background: color-mix(in srgb, #f59e0b 18%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
}

.mr-runtime-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, #22c55e 35%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, #22c55e 8%, transparent);
  flex-wrap: wrap;
}

.mr-runtime-card small {
  color: var(--text-secondary);
}

.mr-runtime-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f59e0b;
}

.mr-runtime-dot.active {
  background: #22c55e;
  box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 25%, transparent);
}

.mr-runtime-actions {
  margin-left: auto;
}

.mr-section {
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 12px 14px;
  background: var(--bg-main);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mr-section-title {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text-primary);
}

.mr-download-form {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.mr-input {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input, var(--bg-soft));
  color: var(--text-primary);
  font-size: 12.5px;
  padding: 8px 12px;
  outline: 0;
  transition: border-color 0.15s ease;
}

.mr-input:focus {
  border-color: var(--accent);
}

.mr-input-url {
  flex: 1 1 320px;
  min-width: 220px;
}

.mr-input-mono {
  flex: 1 1 220px;
  min-width: 160px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.mr-btn {
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

.mr-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.mr-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.mr-btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.mr-btn-primary:hover:not(:disabled) {
  opacity: 0.9;
  color: #fff;
}

.mr-btn-danger {
  border-color: var(--danger, #e5484d);
  color: var(--danger, #e5484d);
}

.mr-btn-ghost {
  padding: 3px 8px;
  font-size: 11px;
}

.mr-download-progress {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mr-progress-track {
  flex: 1;
  height: 8px;
  border-radius: 5px;
  background: var(--bg-soft, rgba(0, 0, 0, 0.06));
  overflow: hidden;
}

.mr-progress-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 5px;
  transition: width 0.3s ease;
}

.mr-progress-label {
  font-size: 11.5px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.mr-model-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mr-model-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s ease;
  font-size: 12.5px;
}

.mr-model-row.selected {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}

.mr-model-name {
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mr-model-meta {
  color: var(--text-secondary);
  font-size: 11px;
}

.mr-model-meta.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  margin-left: auto;
}

.mr-params-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}

.mr-param-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.mr-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mr-hint {
  color: var(--text-secondary);
  font-size: 11px;
}

.mr-empty {
  color: var(--text-secondary);
  font-size: 12px;
  padding: 8px 0;
}

.mr-error-text {
  color: var(--danger, #e5484d);
  font-size: 12px;
}

.spin {
  animation: mr-spin 1s linear infinite;
}

@keyframes mr-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>