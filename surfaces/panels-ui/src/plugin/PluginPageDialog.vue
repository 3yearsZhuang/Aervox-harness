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
  (e: 'refresh'): void
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

const OBSERVATION_INTERVAL_MS = 2000
const QUALIFICATION_DEADLINE_MS = 5000
interface PageIdentity {
  pluginId: string
  lifecycleGeneration: string
  pageId: string
  pageGeneration: string
  entry: string
  capabilities: PluginPageDto['capabilities']
}
interface PageOwner {
  identity: PageIdentity
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
  checking?: Promise<boolean>
  wake: () => void
  visibility: () => void
}
interface PageSession extends PageIdentity {
  owner: PageOwner
  controller: AbortController
  nonce: string
  target: Window
  revision: number
  pending: Set<string>
}
class PageQualificationError extends Error {}
let owner: PageOwner | null = null
let session: PageSession | null = null
let documentGeneration = 0
let invalidatedSelection: string | null = null

const selectionKey = () => `${props.plugin?.id ?? ''}\0${props.page?.id ?? ''}`
const capabilityKey = (capabilities: readonly string[]) => [...capabilities].sort().join(',')
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

function isOwner(current: PageOwner): boolean {
  return owner === current && !current.controller.signal.aborted
}
function isCurrent(current: PageSession): boolean {
  return session === current && isOwner(current.owner) && frameEnabled.value && eligible.value
    && iframe.value?.contentWindow === current.target
    && props.plugin?.id === current.pluginId && props.page?.id === current.pageId
    && props.plugin?.lifecycleGeneration === current.lifecycleGeneration
    && props.page?.pageGeneration === current.pageGeneration
}

/** Settle locally on cancellation/deadline even when the transport ignores AbortSignal. */
function ownedRequest<T>(current: PageOwner, request: (signal: AbortSignal) => Promise<T>, deadline?: number, documentSignal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const signals = documentSignal ? [current.controller.signal, documentSignal] : [current.controller.signal]
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      for (const signal of signals) signal.removeEventListener('abort', cancel)
      complete()
    }
    const cancel = () => {
      const error = new Error('page session is unavailable')
      finish(() => reject(error))
      controller.abort(error)
    }
    if (signals.some(signal => signal.aborted)) { cancel(); return }
    for (const signal of signals) signal.addEventListener('abort', cancel, {once: true})
    if (deadline !== undefined) timer = setTimeout(() => {
      const error = new Error('page qualification timed out')
      finish(() => reject(error))
      controller.abort(error)
    }, deadline)
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason
      return request(controller.signal)
    }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
  })
}

function stopSession(): void {
  documentGeneration++
  const previous = session
  session = null
  previous?.pending.clear()
  previous?.controller.abort(new Error('page document is unavailable'))
}
function stopOwner(): void {
  const previous = owner
  owner = null
  if (previous) {
    if (previous.timer !== undefined) clearTimeout(previous.timer)
    window.removeEventListener('focus', previous.wake)
    document.removeEventListener('visibilitychange', previous.visibility)
    previous.controller.abort(new Error('page session is unavailable'))
  }
  stopSession()
  window.removeEventListener('message', onMessage)
  frameEnabled.value = false
}
function invalidate(current: PageOwner): void {
  if (!isOwner(current)) return
  invalidatedSelection = selectionKey()
  stopOwner()
  bridgeError.value = '无法确认页面权限，请刷新后重试。'
}

async function verifyPage(current: PageOwner, capability?: PluginPageDto['capabilities'][number], documentSignal?: AbortSignal): Promise<void> {
  const identity = current.identity
  const pages = await ownedRequest(current,
    signal => api.listPages(identity.pluginId, identity.lifecycleGeneration, signal), QUALIFICATION_DEADLINE_MS, documentSignal)
  if (!isOwner(current)) throw new Error('page session is unavailable')
  const page = pages.find(page => page.id === identity.pageId)
  if (!page || page.pageGeneration !== identity.pageGeneration || page.entry !== identity.entry) {
    throw new Error('page session is unavailable')
  }
  if (capability !== undefined && !page.capabilities.includes(capability)) throw new Error(`capability ${capability} required`)
  if (capabilityKey(page.capabilities) !== capabilityKey(identity.capabilities)) throw new Error('page capabilities changed')
}
function checkOwner(current: PageOwner): Promise<boolean> {
  if (current.checking) return current.checking
  const check = verifyPage(current).then(() => isOwner(current), () => { invalidate(current); return false })
  current.checking = check
  void check.finally(() => { if (current.checking === check) current.checking = undefined })
  return check
}
function scheduleObservation(current: PageOwner): void {
  if (!isOwner(current) || current.timer !== undefined) return
  current.timer = setTimeout(() => {
    current.timer = undefined
    void observe(current)
  }, OBSERVATION_INTERVAL_MS)
}
async function observe(current: PageOwner): Promise<void> {
  if (!isOwner(current) || current.checking) return
  if (current.timer !== undefined) { clearTimeout(current.timer); current.timer = undefined }
  if (await checkOwner(current)) scheduleObservation(current)
}
function createOwner(identity: PageIdentity): PageOwner {
  const current: PageOwner = {
    identity, controller: new AbortController(),
    wake: () => { void observe(current) },
    visibility: () => { if (document.visibilityState === 'visible') void observe(current) },
  }
  owner = current
  window.addEventListener('focus', current.wake)
  document.addEventListener('visibilitychange', current.visibility)
  return current
}
function captureIdentity(): PageIdentity | null {
  if (!eligible.value || !iframeSrc.value || !props.plugin?.lifecycleGeneration || !props.page) return null
  return {
    pluginId: props.plugin.id, lifecycleGeneration: props.plugin.lifecycleGeneration,
    pageId: props.page.id, pageGeneration: props.page.pageGeneration,
    entry: props.page.entry ?? `pages/${props.page.id}/index.html`, capabilities: [...contextCapabilities.value],
  }
}
async function admitPage(): Promise<void> {
  stopOwner()
  const identity = captureIdentity()
  if (!identity) return
  const current = createOwner(identity)
  if (!await checkOwner(current)) return
  if (!isOwner(current)) return
  frameGeneration.value++
  frameEnabled.value = true
  window.addEventListener('message', onMessage)
  await nextTick()
  if (isOwner(current)) scheduleObservation(current)
}

function currentContext(current: PageSession) {
  return {
    pluginId: current.pluginId, displayName: current.pluginId, pageId: current.pageId,
    locale: 'zh-CN', theme: props.theme === 'dark' ? 'dark' : 'light',
    capabilities: [...current.capabilities], revision: current.revision,
  }
}
function postContext(): void {
  if (!session || !isCurrent(session)) return
  session.target.postMessage({type: 'aervox:page:context', nonce: session.nonce, context: currentContext(session)}, '*')
}
function beginSession(current: PageOwner): void {
  const target = iframe.value?.contentWindow
  if (!isOwner(current) || !frameEnabled.value || !eligible.value || !target) return
  if (!globalThis.crypto?.getRandomValues) {
    invalidate(current)
    return
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  session = {
    ...current.identity, owner: current, controller: new AbortController(), target, revision: 0, pending: new Set(),
    nonce: [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''),
  }
  target.postMessage({type: 'aervox:page:init', nonce: session.nonce, context: currentContext(session)}, '*')
}
async function onIframeLoad(event: Event): Promise<void> {
  if (event.target !== iframe.value || !owner) return
  const current = owner
  // A load is a new document even when its WindowProxy remains the same.
  // Rotate document calls/nonce without resetting the owner's observation or
  // deadline: repeated navigation cannot prolong a silent qualification query.
  stopSession()
  const document = documentGeneration
  if (!await checkOwner(current)) return
  if (!isOwner(current) || documentGeneration !== document) return
  beginSession(current)
  scheduleObservation(current)
}

async function requirePageCapability(current: PageSession, capability: PluginPageDto['capabilities'][number]): Promise<void> {
  try {
    await verifyPage(current.owner, capability, current.controller.signal)
    if (!isCurrent(current)) throw new Error('page session is unavailable')
  } catch (error) {
    throw new PageQualificationError(error instanceof Error ? error.message : 'page session is unavailable')
  }
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
    if (typeof method !== 'string' || !Object.hasOwn(capabilities, method)) return {id, ok: false, error: 'unknown bridge method'}
    if (!current.capabilities.includes(capabilities[method]!)) return {id, ok: false, error: `capability ${capabilities[method]} required`}
    await requirePageCapability(current, capabilities[method]!)
    if (!isCurrent(current)) return {id, ok: false, error: 'page session is unavailable'}
    if (method === 'getConfig') {
      const snapshot = await ownedRequest(current.owner, () => api.getConfig(current.pluginId, current.lifecycleGeneration, {
        expectedPageId: current.pageId, expectedPageGeneration: current.pageGeneration,
      }), undefined, current.controller.signal)
      await requirePageCapability(current, 'config.read')
      current.revision = snapshot.revision
      return {id, ok: true, value: snapshot}
    }
    if (method === 'saveConfig') {
      const snapshot: PluginConfigSnapshot = await ownedRequest(current.owner, () => api.saveConfig(current.pluginId, {
        revision: current.revision, expectedLifecycleGeneration: current.lifecycleGeneration,
        expectedPageId: current.pageId, expectedPageGeneration: current.pageGeneration,
        values: args.values ?? {}, secretValues: args.secretValues ?? {},
      }), undefined, current.controller.signal)
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
  } catch (error) {
    const result = {id, ok: false, error: error instanceof Error ? error.message : 'bridge error'}
    if (error instanceof PageQualificationError && isCurrent(current)) {
      // Queue the structured failure before releasing the revoked document.
      current.target.postMessage({type: 'aervox:page:result', ...result, nonce: current.nonce}, '*')
      invalidate(current.owner)
    }
    return result
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
  () => [props.open, eligible.value, props.plugin?.id, props.plugin?.lifecycleGeneration,
    props.page?.id, props.page?.pageGeneration, props.page?.entry, capabilityKey(contextCapabilities.value)],
  (current, previous) => {
    if (previous && current.every((value, index) => value === previous[index])) return
    const key = selectionKey()
    const previousKey = previous ? `${previous[2] ?? ''}\0${previous[4] ?? ''}` : null
    const sameOpenSelection = props.open && previous?.[0] === true && key === previousKey
    if (!props.open) { invalidatedSelection = null; stopOwner(); return }
    if (sameOpenSelection) {
      // Prop refresh is not explicit permission to revive an already-open Page.
      invalidatedSelection = key
      stopOwner()
      bridgeError.value = '页面已变化，请刷新后重试。'
      return
    }
    if (invalidatedSelection === key && key === previousKey) return
    invalidatedSelection = null
    bridgeError.value = ''
    void admitPage()
  },
  {immediate: true, flush: 'sync'},
)
function reloadPage(): void {
  invalidatedSelection = selectionKey()
  stopOwner()
  emit('refresh')
}
watch(() => props.theme, postContext)
function close(): void {
  // ElDialog also emits close after a parent-driven hide. That acknowledgement
  // must not cancel the fresh identity lookup already replacing this document.
  if (!props.open) return
  invalidatedSelection = selectionKey()
  stopOwner()
  emit('close')
}
onBeforeUnmount(() => stopOwner())
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
