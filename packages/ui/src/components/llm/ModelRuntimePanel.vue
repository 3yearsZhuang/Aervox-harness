<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from '../../utils/element'
import {
  Cpu,
  Download,
  ExternalLink,
  Gauge,
  Loader2,
  Pause,
  Play,
  Power,
  RotateCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-vue-next'
import {
  useAervoxModelRuntime,
  useAervoxLLM,
  type ModelRuntimeStateDto,
  type LocalModelDto,
  type DownloadTaskDto,
  type ModelCatalogEntryDto,
} from '@aervox/api-client'

const runtime = useAervoxModelRuntime()
const llm = useAervoxLLM()

const state = ref<ModelRuntimeStateDto | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

// 下载表单
const downloadUrl = ref('')
const downloadSha = ref('')
/** 限速 bytes/s（0 = 不限） */
const downloadRateLimit = ref(0)
const downloadAutoStart = ref(true)
const downloadBusy = ref(false)

// 启动参数（默认对齐服务端默认值 8080 / 8192 / 99 / 4）
const port = ref(8080)
const ctxSize = ref(8192)
const gpuLayers = ref(99)
const threads = ref(4)
const startBusy = ref(false)
const stopBusy = ref(false)
const selectedModelId = ref<string | null>(null)
let paramsInitialized = false

// 精选模型目录（内置清单）
const catalogOpen = ref(true)
const catalog = ref<ModelCatalogEntryDto[]>([])
const catalogLoading = ref(false)
const catalogBusyId = ref<string | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null
let stopSse: (() => void) | null = null

const runtimeRunning = computed(() => state.value?.runtime.status === 'running' || state.value?.runtime.status === 'starting')
/** 存在未完结下载任务（排队/下载中/已暂停）时保持轮询兜底 */
const hasActiveTasks = computed(
  () => (state.value?.downloads ?? []).some((t) => t.status === 'queued' || t.status === 'running' || t.status === 'paused') ?? false,
)
const selectedModel = computed<LocalModelDto | null>(() => {
  const id = selectedModelId.value
  return state.value?.models.find((m) => m.id === id) ?? state.value?.models[0] ?? null
})

/** 运行指标展示（最近一条采样） */
const metricsText = computed(() => {
  const m = state.value?.runtime.metrics
  const last = m && m.length > 0 ? m[m.length - 1] : undefined
  if (!last) return ''
  const parts: string[] = []
  if (last.tokensPerSec !== undefined) parts.push(`生成 ${last.tokensPerSec.toFixed(1)} tok/s`)
  if (last.promptTokensPerSec !== undefined) parts.push(`Prompt ${last.promptTokensPerSec.toFixed(1)} tok/s`)
  return parts.join(' · ')
})

const runningTaskCount = computed(() => (state.value?.downloads ?? []).filter((t) => t.status === 'running').length)

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return ''
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

/** 单任务进度（0~100），未知总量返回 null */
function taskProgress(task: DownloadTaskDto): number | null {
  if (task.totalBytes === undefined || task.totalBytes === null || task.totalBytes === 0) return null
  return Math.min(100, Math.round(((task.receivedBytes ?? 0) / task.totalBytes) * 100))
}

function taskBytesLabel(task: DownloadTaskDto): string {
  return `${formatBytes(task.receivedBytes ?? 0)}${task.totalBytes ? ` / ${formatBytes(task.totalBytes)}` : ''}`
}

const TASK_STATUS_LABEL: Record<DownloadTaskDto['status'], string> = {
  queued: '排队中',
  running: '下载中',
  paused: '已暂停',
  done: '已完成',
  error: '出错',
  cancelled: '已取消',
}

function taskStatusLabel(task: DownloadTaskDto): string {
  return TASK_STATUS_LABEL[task.status] ?? task.status
}

async function refresh(): Promise<void> {
  try {
    state.value = await runtime.getState()
    // 同步启动参数默认值（首次加载或参数面板未初始化时）
    if (!paramsInitialized && state.value?.params) {
      port.value = state.value.params.port
      ctxSize.value = state.value.params.ctxSize
      gpuLayers.value = state.value.params.gpuLayers
      threads.value = state.value.params.threads
      paramsInitialized = true
    }
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取本地模型运行时状态失败'
  } finally {
    loading.value = false
  }
}

/** 轮询兜底：任务或运行时活跃时持续刷新（SSE 断线/不可用时仍可靠） */
function ensurePolling(): void {
  const needPoll = hasActiveTasks.value || runtimeRunning.value
  if (needPoll && !pollTimer) {
    pollTimer = setInterval(() => void refresh(), 1500)
  } else if (!needPoll && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/** 尝试建立 SSE 实时订阅；失败静默回退轮询 */
function trySse(): void {
  try {
    stopSse = runtime.subscribeState(
      (snap) => {
        state.value = snap
        error.value = null
      },
      () => undefined,
    )
  } catch {
    // 环境不支持 SSE（如桌面 IPC 通路）时保持轮询
  }
}

async function loadCatalog(): Promise<void> {
  catalogLoading.value = true
  try {
    catalog.value = await runtime.getCatalog()
  } catch {
    // 目录缺失不阻断面板
  } finally {
    catalogLoading.value = false
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
      autoStart: downloadAutoStart.value,
      rateLimitBps: downloadRateLimit.value > 0 ? downloadRateLimit.value : undefined,
    })
    downloadUrl.value = ''
    downloadSha.value = ''
    downloadRateLimit.value = 0
    ElMessage.success('已加入下载队列')
  } catch (e) {
    const msg = e instanceof Error ? e.message : '发起下载失败'
    error.value = msg.includes('download_busy') ? '模型已在下载队列中' : msg.includes('model_exists') ? '模型已存在' : msg
    ElMessage.error(error.value)
  } finally {
    downloadBusy.value = false
    refresh()
  }
}

/** 从精选目录一键下载 */
async function handleCatalogDownload(entry: ModelCatalogEntryDto): Promise<void> {
  catalogBusyId.value = entry.id
  error.value = null
  try {
    state.value = await runtime.download({ url: entry.url, sha256: entry.sha256, autoStart: false })
    // 预填该档位的推荐启动参数
    if (entry.recommendedParams) {
      if (entry.recommendedParams.port !== undefined) port.value = entry.recommendedParams.port
      if (entry.recommendedParams.ctxSize !== undefined) ctxSize.value = entry.recommendedParams.ctxSize
      if (entry.recommendedParams.gpuLayers !== undefined) gpuLayers.value = entry.recommendedParams.gpuLayers
      if (entry.recommendedParams.threads !== undefined) threads.value = entry.recommendedParams.threads
    }
    ElMessage.success(`已加入下载队列：${entry.name}（${entry.quant}）`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : '发起下载失败'
    error.value = msg.includes('model_exists') ? '该模型已存在，无需重复下载' : msg
    ElMessage.error(error.value)
  } finally {
    catalogBusyId.value = null
    refresh()
  }
}

async function handlePauseTask(taskId: string): Promise<void> {
  try {
    state.value = await runtime.pauseDownload(taskId)
    ElMessage.info('下载已暂停（保留断点，可恢复）')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '暂停失败')
  } finally {
    refresh()
  }
}

async function handleResumeTask(taskId: string): Promise<void> {
  try {
    state.value = await runtime.resumeDownload(taskId)
    ElMessage.info('已恢复下载')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '恢复失败')
  } finally {
    refresh()
  }
}

async function handleCancelTask(taskId: string): Promise<void> {
  try {
    state.value = await runtime.cancelDownload(taskId)
    ElMessage.info('已取消下载并清理残片')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '取消失败')
  } finally {
    refresh()
  }
}

/** 删除已下载模型（运行中当前模型禁用） */
async function handleDeleteModel(modelId: string): Promise<void> {
  try {
    await runtime.deleteModel(modelId)
    if (selectedModelId.value === modelId) selectedModelId.value = null
    ElMessage.success('模型已删除')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
    ElMessage.error(error.value)
  } finally {
    refresh()
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
  await Promise.all([refresh(), loadCatalog()])
  if (state.value?.models.length && !selectedModelId.value) {
    selectedModelId.value = state.value.models[0].id
  }
  trySse()
  ensurePolling()
})

onBeforeUnmount(() => {
  stopSse?.()
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

      <!-- 运行时状态卡（含实时指标） -->
      <div v-if="runtimeRunning" class="mr-runtime-card">
        <span class="mr-runtime-dot" :class="{ active: state?.runtime.status === 'running' }" />
        <strong>{{ state?.runtime.status === 'running' ? '运行中' : '启动中…' }}</strong>
        <small v-if="state?.runtime.port">端口 {{ state?.runtime.port }}</small>
        <small v-if="state?.runtime.modelId">模型 {{ state?.runtime.modelId }}</small>
        <small v-if="state?.runtime.pid">PID {{ state?.runtime.pid }}</small>
        <span v-if="metricsText" class="mr-metrics-chip" title="llama-server /metrics 采样">
          <Gauge :size="13" />{{ metricsText }}
        </span>
        <span class="mr-runtime-actions">
          <button type="button" class="mr-btn mr-btn-danger" :disabled="stopBusy" @click="handleStop">
            <Power :size="13" />{{ stopBusy ? '停止中…' : '停止' }}
          </button>
        </span>
      </div>

      <!-- 精选模型目录 -->
      <div class="mr-section">
        <div class="mr-section-title mr-section-title-row" @click="catalogOpen = !catalogOpen">
          <span class="mr-section-title-icon"><Sparkles :size="14" />精选模型</span>
          <span class="mr-catalog-toggle">{{ catalogOpen ? '收起' : '展开' }} <RotateCw :size="10" class="mr-rotate-up" /></span>
        </div>
        <p v-if="!catalogLoading && !catalog.length" class="mr-empty">暂无精选目录（任意 GGUF URL 下载入口保留）。</p>
        <template v-if="catalogOpen || catalogLoading">
          <div class="mr-catalog-list">
            <div v-for="entry in catalog" :key="entry.id" class="mr-catalog-row">
              <span class="mr-catalog-main">
                <span class="mr-catalog-name">{{ entry.name }}</span>
                <span class="mr-catalog-meta">{{ entry.family }} · {{ entry.sizeLabel }}</span>
              </span>
              <span class="mr-badge mr-badge-quant">{{ entry.quant }}</span>
              <a v-if="entry.url" class="mr-catalog-link" :href="entry.url" target="_blank" rel="noopener noreferrer" title="查看源文件">
                <ExternalLink :size="12" />
              </a>
              <button
                type="button"
                class="mr-btn mr-btn-primary mr-catalog-download"
                :disabled="catalogBusyId === entry.id"
                @click="handleCatalogDownload(entry)"
              >
                <Loader2 v-if="catalogBusyId === entry.id" :size="13" class="spin" />
                <Download v-else :size="13" />下载
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- 下载任务（多任务队列） -->
      <div class="mr-section">
        <div class="mr-section-title">下载任务</div>
        <div class="mr-download-form">
          <input
            v-model="downloadUrl"
            type="url"
            class="mr-input mr-input-url"
            placeholder="GGUF 文件 URL（如 https://huggingface.co/.../model-q4_k_m.gguf）"
          />
          <input
            v-model="downloadSha"
            type="text"
            class="mr-input mr-input-mono"
            placeholder="SHA-256（可选，填写则强制校验）"
          />
          <input
            v-model.number="downloadRateLimit"
            type="number"
            min="0"
            step="1024"
            class="mr-input mr-input-rate"
            placeholder="限速 bytes/s"
            title="下载限速（bytes/sec），0 或留空表示不限"
          />
          <button
            type="button"
            class="mr-btn mr-btn-primary"
            :disabled="downloadBusy"
            @click="handleDownload"
          >
            <Download :size="14" />{{ downloadBusy ? '提交中…' : '发起下载' }}
          </button>
        </div>
        <label class="mr-auto-start-row">
          <input v-model="downloadAutoStart" type="checkbox" />
          <span>下载完成后自动启动并连接（切换为 llama.cpp 预设）</span>
        </label>

        <div v-if="!state?.downloads?.length" class="mr-empty">暂无下载任务。可从上方的精选目录一键下载，或粘贴任意 GGUF URL。</div>

        <div v-for="task in state?.downloads ?? []" :key="task.id" class="mr-task-card" :class="`mr-task-${task.status}`">
          <div class="mr-task-head">
            <span class="mr-task-name" :title="task.fileName">{{ task.modelId }}</span>
            <span class="mr-task-badge" :class="`mr-badge-${task.status}`">{{ taskStatusLabel(task) }}</span>
          </div>
          <div class="mr-task-meta">
            {{ taskBytesLabel(task) }}
            <span v-if="task.status !== 'running' && task.resumableFrom !== undefined" class="mr-task-meta"> · 断点 {{ formatBytes(task.resumableFrom) }}</span>
            <span v-if="task.rateLimitBps" class="mr-task-meta"> · 限速 {{ formatBytes(task.rateLimitBps) }}/s</span>
          </div>
          <div v-if="task.status === 'running' || task.status === 'paused'" class="mr-progress-track">
            <div class="mr-progress-bar" :style="{ width: `${taskProgress(task) ?? 100}%` }" />
          </div>
          <span v-if="task.error" class="mr-error-text">{{ task.error }}</span>
          <div class="mr-task-actions">
            <button v-if="task.status === 'running'" type="button" class="mr-btn mr-btn-ghost" @click="handlePauseTask(task.id)">
              <Pause :size="12" />暂停
            </button>
            <button v-if="task.status === 'paused'" type="button" class="mr-btn mr-btn-ghost" @click="handleResumeTask(task.id)">
              <Play :size="12" />恢复
            </button>
            <button
              v-if="task.status === 'queued' || task.status === 'running' || task.status === 'paused'"
              type="button"
              class="mr-btn mr-btn-ghost"
              @click="handleCancelTask(task.id)"
            >
              <X :size="12" />取消
            </button>
          </div>
        </div>

        <span v-if="state?.llamaServer?.maxConcurrentDownloads" class="mr-task-meta mr-task-hint">
          并发上限 {{ state.llamaServer.maxConcurrentDownloads }}，当前 {{ runningTaskCount }} 个任务执行中
        </span>
      </div>

      <!-- 已下载模型 + 启动参数 -->
      <div class="mr-section">
        <div class="mr-section-title">本地模型与启动</div>

        <div v-if="!state?.models.length" class="mr-empty">
          暂无已下载模型。从上方精选目录下载，或将 .gguf 文件放入 data/models/。
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
              <span v-if="model.sha256" class="mr-model-meta mono" :title="model.sha256">sha256 ✓</span>
              <button
                type="button"
                class="mr-btn mr-model-delete"
                :disabled="runtimeRunning && state?.runtime.modelId === model.id"
                :title="runtimeRunning && state?.runtime.modelId === model.id ? '运行中，请先停止' : '删除模型'"
                @click.stop="handleDeleteModel(model.id)"
              >
                <Trash2 :size="12" />
              </button>
            </label>
          </div>

          <!-- 运行日志（stderr 环形缓冲） -->
          <details v-if="state?.runtime.logs?.length" class="mr-log-details">
            <summary>运行日志（{{ state.runtime.logs.length }} 条）</summary>
            <pre class="mr-log-pre"><code v-for="(line, i) in state.runtime.logs" :key="i">{{ line }}</code></pre>
          </details>

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

.mr-metrics-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 550;
  color: #15803d;
  background: color-mix(in srgb, #22c55e 14%, transparent);
  border-radius: 999px;
  padding: 3px 9px;
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

.mr-section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}

.mr-section-title-icon {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text-primary);
}

.mr-catalog-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}

.mr-rotate-up {
  transform: rotate(180deg);
}

.mr-catalog-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mr-catalog-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12.5px;
}

.mr-catalog-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.mr-catalog-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mr-catalog-meta {
  color: var(--text-secondary);
  font-size: 11px;
}

.mr-catalog-link {
  color: var(--text-secondary);
  flex-shrink: 0;
  display: inline-flex;
}

.mr-catalog-link:hover {
  color: var(--accent);
}

.mr-catalog-download {
  flex-shrink: 0;
}

.mr-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10.5px;
  font-weight: 600;
  flex-shrink: 0;
}

.mr-badge-quant {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
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

.mr-input-rate {
  flex: 0 1 140px;
  min-width: 110px;
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

.mr-task-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.mr-task-running {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: color-mix(in srgb, var(--accent) 4%, transparent);
}

.mr-task-error {
  border-color: color-mix(in srgb, var(--danger, #e5484d) 45%, transparent);
}

.mr-task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mr-task-name {
  font-weight: 600;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mr-task-badge {
  flex-shrink: 0;
}

.mr-badge-queued {
  background: color-mix(in srgb, #64748b 14%, transparent);
  color: #64748b;
}

.mr-badge-running {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.mr-badge-paused {
  background: color-mix(in srgb, #f59e0b 16%, transparent);
  color: #b45309;
}

.mr-badge-done {
  background: color-mix(in srgb, #22c55e 14%, transparent);
  color: #15803d;
}

.mr-badge-error {
  background: color-mix(in srgb, var(--danger, #e5484d) 14%, transparent);
  color: var(--danger, #e5484d);
}

.mr-badge-cancelled {
  background: color-mix(in srgb, #64748b 14%, transparent);
  color: #64748b;
}

.mr-task-meta {
  font-size: 11px;
  color: var(--text-secondary);
}

.mr-task-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.mr-task-hint {
  display: block;
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

.mr-model-delete {
  padding: 3px 8px;
  color: var(--danger, #e5484d);
  border-color: transparent;
  flex-shrink: 0;
}

.mr-model-delete:hover:not(:disabled) {
  border-color: var(--danger, #e5484d);
  color: var(--danger, #e5484d);
}

.mr-model-delete:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.mr-auto-start-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.mr-log-details {
  font-size: 11.5px;
}

.mr-log-details summary {
  cursor: pointer;
  color: var(--text-secondary);
  user-select: none;
}

.mr-log-pre {
  margin: 8px 0 0;
  padding: 8px 10px;
  max-height: 180px;
  overflow: auto;
  border-radius: 8px;
  background: var(--bg-soft, rgba(0, 0, 0, 0.04));
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}

.mr-log-pre code {
  display: block;
  line-height: 1.5;
  color: var(--text-secondary);
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
