<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue'
import {ElMessage} from 'element-plus'
import {getApiBase, useAervoxPlugins, type PluginPageDto, type PluginSummaryDto} from '@aervox/api-client'
import type {PluginConfigSnapshot} from '@aervox/contracts'

const props = defineProps<{
  open: boolean
  plugin: PluginSummaryDto | null
  page: PluginPageDto | null
  theme?: 'light' | 'dark'
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'openConfig'): void
}>()

const api = useAervoxPlugins()
const iframe = ref<HTMLIFrameElement | null>(null)
const nonce = ref('')
const revision = ref(0)
const contextCapabilities = computed(() => props.page?.capabilities ?? [])

const iframeSrc = computed(() => {
  if (!props.plugin || !props.page) return ''
  return `${getApiBase()}/v1/plugins/${encodeURIComponent(props.plugin.id)}/pages/${encodeURIComponent(props.page.id)}/assets/index.html`
})

const currentContext = () => ({
  pluginId: props.plugin?.id ?? '',
  displayName: props.plugin?.id ?? '',
  pageId: props.page?.id ?? '',
  locale: 'zh-CN',
  theme: props.theme === 'dark' ? 'dark' : 'light',
  capabilities: contextCapabilities.value,
  revision: revision.value,
})

function postInit(): void {
  if (!iframe.value?.contentWindow) return
  iframe.value.contentWindow.postMessage(
    {type: 'aervox:page:init', nonce: nonce.value, context: currentContext()},
    '*',
  )
}

async function handleBridgeCall(message: {
  id?: unknown
  method?: unknown
  args?: unknown
}): Promise<{id: unknown; ok: boolean; value?: unknown; error?: string}> {
  const id = message.id
  const method = message.method
  const args = (message.args ?? {}) as {values?: Record<string, unknown>; secretValues?: Record<string, string | null>}
  try {
    if (method === 'getConfig') {
      if (!contextCapabilities.value.includes('config.read')) {
        return {id, ok: false, error: 'capability config.read required'}
      }
      const snapshot = await api.getConfig(props.plugin?.id ?? '')
      revision.value = snapshot.revision
      return {id, ok: true, value: snapshot}
    }
    if (method === 'saveConfig') {
      if (!contextCapabilities.value.includes('config.write')) {
        return {id, ok: false, error: 'capability config.write required'}
      }
      const snapshot: PluginConfigSnapshot = await api.saveConfig(props.plugin?.id ?? '', {
        revision: revision.value,
        values: args.values ?? {},
        secretValues: args.secretValues ?? {},
      })
      revision.value = snapshot.revision
      return {id, ok: true, value: snapshot}
    }
    if (method === 'notify') {
      const input = args as {type?: 'success' | 'info' | 'warning' | 'error'; message?: string}
      const type = input.type ?? 'info'
      const fn = ElMessage[type] ?? ElMessage.info
      fn(input.message ?? '')
      return {id, ok: true, value: null}
    }
    if (method === 'close') {
      emit('close')
      return {id, ok: true, value: null}
    }
    return {id, ok: false, error: `unknown bridge method: ${String(method)}`}
  } catch (e) {
    return {id, ok: false, error: e instanceof Error ? e.message : 'bridge error'}
  }
}

function onMessage(event: MessageEvent): void {
  const data = event.data as {type?: string; nonce?: unknown; id?: unknown} | null
  if (!data || typeof data !== 'object') return
  if (data.type === 'aervox:page:call') {
    if (data.nonce !== nonce.value) return
    void handleBridgeCall(data).then((result) => {
      iframe.value?.contentWindow?.postMessage({type: 'aervox:page:result', ...result, nonce: nonce.value}, '*')
    })
  }
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    nonce.value = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    revision.value = 0
    window.addEventListener('message', onMessage)
    await nextTick()
    // 若 iframe 已加载则注入 init；未加载等 load 事件
    postInit()
  },
)

function onIframeLoad(): void {
  postInit()
}

watch(
  () => [props.plugin?.id, props.page?.id, props.theme],
  () => postInit(),
)

function close(): void {
  window.removeEventListener('message', onMessage)
  emit('close')
}

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
})
</script>

<template>
  <el-dialog
    :model-value="open"
    :title="`${plugin?.id ?? ''} · ${page?.id ?? ''}`"
    class="plugin-page-dialog"
    width="min(80vw, 1200px)"
    top="6vh"
    @close="close"
    @closed="close"
  >
    <div class="plugin-page-toolbar">
      <button type="button" class="plugin-page-tool" @click="postInit">刷新</button>
      <button v-if="contextCapabilities.includes('config.read') || contextCapabilities.includes('config.write')" type="button" class="plugin-page-tool" @click="emit('openConfig')">设置</button>
      <button type="button" class="plugin-page-tool" @click="close">关闭</button>
    </div>
    <iframe
      v-if="open && iframeSrc"
      ref="iframe"
      class="plugin-page-frame"
      :src="iframeSrc"
      sandbox="allow-scripts allow-forms allow-downloads"
      referrerpolicy="no-referrer"
      @load="onIframeLoad"
    />
  </el-dialog>
</template>

<style scoped>
.plugin-page-dialog :deep(.el-dialog__body) { padding: 8px 12px 12px; }
.plugin-page-toolbar { display: flex; gap: 6px; padding: 0 0 8px; }
.plugin-page-tool {
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-soft);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}
.plugin-page-tool:hover { border-color: var(--accent); color: var(--accent); }
.plugin-page-frame {
  width: 100%;
  height: 72vh;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
}
:root[data-theme='dark'] .plugin-page-frame { background: #1d2420; }
</style>
