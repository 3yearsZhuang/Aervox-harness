<script setup lang="ts">
import {Maximize2, Minimize2, Minus, Moon, Settings, Sparkles, Sun, X} from 'lucide-vue-next'
import {onMounted, onUnmounted, ref} from 'vue'

const isMaximized = ref(false)
const isDark = ref(false)
let removeThemeListener: (() => void) | undefined

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
      <span class="titlebar-logo"><Sparkles :size="15" :stroke-width="2.2"/></span>
      <span class="titlebar-name">Fairy Agent</span>
      <span class="titlebar-status"><i/>AI companion</span>
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
