<script setup lang="ts">
import {Maximize2, Minimize2, Minus, Moon, Settings, Sun, X} from 'lucide-vue-next'
import {computed, onMounted, onUnmounted, ref} from 'vue'
import {useAervoxLLM, type LLMConfigDto} from '@aervox/api-client'
import {AervoxBrandMark} from '@aervox/ui'

const isMaximized = ref(false)
const isDark = ref(false)
let removeThemeListener: (() => void) | undefined

/** 大模型连接状态：unknown 探测中 / online 已连通 / offline 不可用，驱动标题栏呼吸灯 */
const llmStatus = ref<'unknown' | 'online' | 'offline'>('unknown')
const llmStatusLabel = computed(() =>
  llmStatus.value === 'online' ? '模型已连接' : llmStatus.value === 'offline' ? '模型未连接' : '模型连接检测中',
)
let llmProbeTimer: ReturnType<typeof setInterval> | undefined

const llmApi = useAervoxLLM()

/** 轻量探测：读取配置并试连供应商端点（与设置面板「测试连接」同一后端逻辑） */
async function probeLlmConnection() {
  try {
    const config = await llmApi.getConfig() as LLMConfigDto
    if (!config.enabled) {
      llmStatus.value = 'offline'
      return
    }
    const result = await llmApi.testConnection({
      providerType: config.providerType,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      modelId: config.modelId,
    })
    llmStatus.value = result.ok ? 'online' : 'offline'
  } catch {
    llmStatus.value = 'offline'
  }
}

onMounted(async () => {
  const fallbackTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  applyTheme(await window.fairyDesktop?.getTheme() ?? fallbackTheme)
  removeThemeListener = window.fairyDesktop?.onThemeChange(applyTheme)
  void probeLlmConnection()
  llmProbeTimer = setInterval(probeLlmConnection, 60_000)
})

onUnmounted(() => {
  removeThemeListener?.()
  if (llmProbeTimer) clearInterval(llmProbeTimer)
})

function applyTheme(theme: 'light' | 'dark') {
  isDark.value = theme === 'dark'
  document.documentElement.dataset.theme = theme
}

async function toggleTheme() {
  const theme = isDark.value ? 'light' : 'dark'
  const appliedTheme = await window.fairyDesktop?.setTheme(theme) ?? theme
  applyTheme(appliedTheme)
}

onMounted(async () => {
  const fallbackTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  applyTheme(await window.fairyDesktop?.getTheme() ?? fallbackTheme)
  removeThemeListener = window.fairyDesktop?.onThemeChange(applyTheme)
})

onUnmounted(() => removeThemeListener?.())

async function toggleMaximize() {
  isMaximized.value = await window.fairyDesktop?.toggleMaximize() ?? false
}

async function minimizeWindow() {
  await window.fairyDesktop?.minimize()
}

async function closeWindow() {
  await window.fairyDesktop?.close()
}

function openSettings() {
  window.dispatchEvent(new CustomEvent('aervox:open-settings'))
}
</script>

<template>
  <header class="app-titlebar" @dblclick="toggleMaximize">
    <div class="titlebar-brand">
      <span class="titlebar-logo"><AervoxBrandMark :size="18"/></span>
      <span class="titlebar-name">Aervox｜思隅</span>
      <el-tooltip :content="llmStatusLabel" placement="bottom" :show-after="300">
        <span
          class="titlebar-status"
          :class="`llm-${llmStatus}`"
          :aria-label="`大模型连接状态：${llmStatusLabel}`"
        >
          <i/>
          {{ llmStatusLabel }}
        </span>
      </el-tooltip>
    </div>
    <div class="titlebar-drag-space"/>
    <nav class="window-controls" aria-label="窗口控制">
      <el-tooltip :content="isDark ? '切换亮色模式' : '切换暗色模式'" placement="bottom" :show-after="500">
        <button class="window-control theme-control" type="button"
                :aria-label="isDark ? '切换亮色模式' : '切换暗色模式'" @click.stop="toggleTheme">
          <Moon v-if="isDark" :size="18"/>
          <Sun v-else :size="18"/>
        </button>
      </el-tooltip>
      <el-tooltip content="设置" placement="bottom" :show-after="500">
        <button class="window-control" type="button" aria-label="打开设置" @click.stop="openSettings">
          <Settings :size="17"/>
        </button>
      </el-tooltip>
      <el-tooltip content="最小化" placement="bottom" :show-after="500">
        <button class="window-control" type="button" aria-label="最小化" @click.stop="minimizeWindow">
          <Minus :size="16"/>
        </button>
      </el-tooltip>
      <el-tooltip :content="isMaximized ? '还原' : '最大化'" placement="bottom" :show-after="500">
        <button class="window-control" type="button" :aria-label="isMaximized ? '还原' : '最大化'"
                @click.stop="toggleMaximize">
          <Minimize2 v-if="isMaximized" :size="16"/>
          <Maximize2 v-else :size="16"/>
        </button>
      </el-tooltip>
      <el-tooltip content="关闭" placement="bottom" :show-after="500">
        <button class="window-control close" type="button" aria-label="关闭" @click.stop="closeWindow">
          <X :size="17"/>
        </button>
      </el-tooltip>
    </nav>
  </header>
</template>
