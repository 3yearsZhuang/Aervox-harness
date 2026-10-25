<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue'
import {ElMessage} from '@aervox/ui/utils/element'
import {LayoutGrid} from 'lucide-vue-next'
import {useAervoxClient, useAervoxPlugins, type PluginPageDto, type PluginSummaryDto} from '@aervox/api-client'
import type {PluginConfigSnapshot} from '@aervox/contracts'
import {AervoxDialog, AervoxButton} from '@aervox/ui/primitives'

const client = useAervoxClient()
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
const frameEnabled = ref(false)
const frameGeneration = ref(0)
const bridgeError = ref('')
const contextCapabilities = computed(() => props.page?.capabilities ?? [])
const eligible = computed(() => props.open && props.plugin?.enabled === 1
  && (props.plugin.availability ?? 'available') === 'available'
  && Boolean(props.plugin.lifecycleGeneration) && typeof props.page?.pageGeneration === 'string'
  && props.page.pageGeneration.length > 0 && props.page.pageGeneration.length <= 128)

interface PageSession {
  nonce: string
  pluginId: string
  lifecycleGeneration: string
  pageId: string
  pageGeneration: string
  target: Window
  revision: number
  capabilities: Set<string>
  pending: Set<string>
}
let session: PageSession | null = null

const iframeSrc = computed(() => {
  if (!props.plugin || !props.page) return ''
  const prefix = `pages/${props.page.id}/`
  const entry = props.page.entry ?? `${prefix}index.html`
  if (!entry.startsWith(prefix)) return ''
  const relative = entry.slice(prefix.length)
  const segments = relative.split('/')
  if (/[\\\u0000-\u001f\u007f]/.test(relative)
    || segments.some(segment => !segment || segment === '.' || segment === '..')) return ''
  const assetPath = segments.map(segment => encodeURIComponent(segment)).join('/')
  return `${client.apiBase}/v1/plugins/${encodeURIComponent(props.plugin.id)}/pages/${encodeURIComponent(props.page.id)}/assets/${assetPath}`
})

function isCurrent(current: PageSession): boolean {
  return session === current && frameEnabled.value && eligible.value
    && iframe.value?.contentWindow === current.target
    && props.plugin?.id === current.pluginId && props.page?.id === current.pageId
    && props.plugin?.lifecycleGeneration === current.lifecycleGeneration
    && props.page?.pageGeneration === current.pageGeneration
}

function currentContext(current: PageSession) {
  return {
    pluginId: current.pluginId,
    displayName: current.pluginId,
    pageId: current.pageId,
    locale: 'zh-CN',
    theme: props.theme === 'dark' ? 'dark' : 'light',
    capabilities: [...current.capabilities],
    revision: current.revision,
  }
}

function postContext(): void {
  if (!session || !isCurrent(session)) return
  session.target.postMessage({type: 'aervox:page:context', nonce: session.nonce, context: currentContext(session)}, '*')
}

function beginSession(): void {
  session = null
  const target = iframe.value?.contentWindow
  if (!frameEnabled.value || !eligible.value || !target || !props.plugin?.lifecycleGeneration || !props.page) return
  if (!globalThis.crypto?.getRandomValues) {
    bridgeError.value = '当前环境无法建立安全的插件页面连接。'
    frameEnabled.value = false
    return
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  session = {
    nonce: [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''),
    pluginId: props.plugin.id,
    lifecycleGeneration: props.plugin.lifecycleGeneration,
    pageId: props.page.id,
    pageGeneration: props.page.pageGeneration,
    target,
    revision: 0,
    capabilities: new Set(contextCapabilities.value),
    pending: new Set(),
  }
  // A sandboxed iframe has an opaque origin. Bind the WindowProxy and a fresh
  // document session instead of treating the shared "null" origin as identity.
  target.postMessage({type: 'aervox:page:init', nonce: session.nonce, context: currentContext(session)}, '*')
}

async function requirePageCapability(current: PageSession, capability: PluginPageDto['capabilities'][number]): Promise<void> {
  // Local props can remain enabled after a change in another window/process.
  // The persisted grant and package identity share one SQL read snapshot.
  const pages = await api.listPages(current.pluginId, current.lifecycleGeneration)
  if (!isCurrent(current)) throw new Error('page session is unavailable')
  const page = pages.find(page => page.id === current.pageId)
  if (!page || page.pageGeneration !== current.pageGeneration) throw new Error('page session is unavailable')
  if (!page.capabilities.includes(capability)) throw new Error(`capability ${capability} required`)
}

async function handleBridgeCall(current: PageSession, message: {
  id: string
  method?: unknown
  args?: unknown
}): Promise<{id: string; ok: boolean; value?: unknown; error?: string}> {
  const {id, method} = message
  const args = (message.args && typeof message.args === 'object' && !Array.isArray(message.args)
    ? message.args : {}) as {values?: Record<string, unknown>; secretValues?: Record<string, string | null>}
  try {
    if (!isCurrent(current)) return {id, ok: false, error: 'page session is unavailable'}
    const capabilities: Record<string, PluginPageDto['capabilities'][number]> = {
      getConfig: 'config.read', saveConfig: 'config.write', notify: 'host.notify', close: 'host.close',
    }
    if (typeof method !== 'string' || !Object.hasOwn(capabilities, method)) {
      return {id, ok: false, error: 'unknown bridge method'}
    }
    if (!current.capabilities.has(capabilities[method]!)) {
      return {id, ok: false, error: `capability ${capabilities[method]} required`}
    }
    await requirePageCapability(current, capabilities[method]!)
    if (!isCurrent(current)) return {id, ok: false, error: 'page session is unavailable'}
    if (method === 'getConfig') {
      const snapshot = await api.getConfig(current.pluginId, current.lifecycleGeneration)
      await requirePageCapability(current, 'config.read')
      current.revision = snapshot.revision
      return {id, ok: true, value: snapshot}
    }
    if (method === 'saveConfig') {
      const snapshot: PluginConfigSnapshot = await api.saveConfig(current.pluginId, {
        revision: current.revision,
        expectedLifecycleGeneration: current.lifecycleGeneration,
        expectedPageId: current.pageId,
        expectedPageGeneration: current.pageGeneration,
        values: args.values ?? {},
        secretValues: args.secretValues ?? {},
      })
      await requirePageCapability(current, 'config.write')
      current.revision = snapshot.revision
      return {id, ok: true, value: snapshot}
    }
    if (method === 'notify') {
      const input = args as {type?: string; message?: unknown}
      const type = input.type === 'success' || input.type === 'warning' || input.type === 'error' ? input.type : 'info'
      ElMessage[type](String(input.message ?? '').slice(0, 2000))
      return {id, ok: true, value: null}
    }
    current.target.postMessage({type: 'aervox:page:result', id, ok: true, value: null, nonce: current.nonce}, '*')
    close()
    return {id, ok: true, value: null}
  } catch (e) {
    return {id, ok: false, error: e instanceof Error ? e.message : 'bridge error'}
  }
}

function onMessage(event: MessageEvent): void {
  const current = session
  if (!current || !isCurrent(current) || event.source !== current.target) return
  const data = event.data as {type?: unknown; nonce?: unknown; id?: unknown} | null
  if (!data || typeof data !== 'object' || data.type !== 'aervox:page:call'
    || data.nonce !== current.nonce || typeof data.id !== 'string' || !data.id || data.id.length > 128) return
  if (current.pending.has(data.id) || current.pending.size >= 32) return
  current.pending.add(data.id)
  void handleBridgeCall(current, {...data, id: data.id}).then(result => {
    current.pending.delete(result.id)
    if (isCurrent(current)) current.target.postMessage({type: 'aervox:page:result', ...result, nonce: current.nonce}, '*')
  })
}

watch(
  () => [eligible.value, props.plugin?.id, props.plugin?.lifecycleGeneration, props.page?.id, props.page?.pageGeneration, props.page?.entry, contextCapabilities.value.join(',')],
  async () => {
    session = null
    window.removeEventListener('message', onMessage)
    const generation = ++frameGeneration.value
    frameEnabled.value = eligible.value
    bridgeError.value = ''
    if (!eligible.value) return
    window.addEventListener('message', onMessage)
    await nextTick()
    if (generation === frameGeneration.value && !session) beginSession()
  },
  {immediate: true, flush: 'sync'},
)

function onIframeLoad(event: Event): void {
  if (event.target === iframe.value) beginSession()
}

async function reloadPage(): Promise<void> {
  if (!eligible.value) return
  session = null
  const generation = ++frameGeneration.value
  await nextTick()
  if (generation === frameGeneration.value && eligible.value) beginSession()
}

watch(() => props.theme, postContext)

function close(): void {
  session = null
  frameEnabled.value = false
  window.removeEventListener('message', onMessage)
  emit('close')
}

onBeforeUnmount(() => {
  session = null
  window.removeEventListener('message', onMessage)
})
</script>

<template>
  <AervoxDialog
    :model-value="open"
    :title="`${plugin?.id ?? ''} · ${page?.id ?? ''}`"
    subtitle="插件独立扩展页面"
    :icon="LayoutGrid"
    size="xl"
    width="min(88vw, 1200px)"
    body-max-height="78vh"
    @close="close"
  >
    <div class="plugin-page-toolbar">
      <AervoxButton size="sm" variant="secondary" @click="reloadPage">刷新</AervoxButton>
      <AervoxButton
        v-if="contextCapabilities.includes('config.read') || contextCapabilities.includes('config.write')"
        size="sm"
        variant="secondary"
        @click="emit('openConfig')"
      >
        设置
      </AervoxButton>
      <AervoxButton size="sm" variant="secondary" @click="close">关闭</AervoxButton>
    </div>
    <p v-if="bridgeError" role="alert">{{ bridgeError }}</p>
    <iframe
      v-if="frameEnabled && iframeSrc"
      :key="frameGeneration"
      ref="iframe"
      class="plugin-page-frame"
      :src="iframeSrc"
      sandbox="allow-scripts allow-forms allow-downloads"
      referrerpolicy="no-referrer"
      @load="onIframeLoad"
    />
  </AervoxDialog>
</template>

<style scoped>
.plugin-page-toolbar { display: flex; gap: 6px; padding: 0 0 10px; }

.plugin-page-tool {
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-soft);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}
.plugin-page-tool:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
  transform: translateY(-1px);
}
.plugin-page-tool:active {
  transform: translateY(0) scale(0.97);
}
.plugin-page-frame {
  width: 100%;
  height: 72vh;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
  transition: opacity 0.25s ease;
}
:root[data-theme='dark'] .plugin-page-frame { background: #1d222e; }
</style>
