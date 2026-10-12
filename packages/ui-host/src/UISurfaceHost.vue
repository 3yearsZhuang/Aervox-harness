<script setup lang="ts">
import { markRaw, onErrorCaptured, shallowRef, ref, watch, type Component } from 'vue';
import SurfaceInstance from './SurfaceInstance';
import type { UIPlatform, UISurfaceContext, UISurfaceKind, UISurfacePlugin } from './surface-context';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{
  plugin: UISurfacePlugin | null;
  surface: UISurfaceKind;
  platform: UIPlatform;
  viewProps?: Record<string, unknown>;
  requestClose?: () => void;
  requestReload?: () => void;
  loadTimeoutMs?: number;
}>(), { viewProps: () => ({}), loadTimeoutMs: 15_000 });

const root = shallowRef<Component>();
const context = shallowRef<UISurfaceContext>();
const state = ref<'loading' | 'ready' | 'failed'>('loading');
const retry = ref(0);
const generation = ref(0);
let failCurrent: (() => void) | undefined;

watch(
  () => [props.plugin, props.surface, props.platform, props.requestClose, retry.value] as const,
  ([plugin, surface, platform, requestClose], _, onCleanup) => {
    const epoch = ++generation.value;
    const controller = new AbortController();
    root.value = undefined;
    state.value = 'loading';
    context.value = Object.freeze({ platform, surface, signal: controller.signal, requestClose });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (controller.signal.aborted || generation.value !== epoch) return;
      clearTimeout(timer);
      controller.abort();
      root.value = undefined;
      state.value = 'failed';
    };
    failCurrent = fail;
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
      if (failCurrent === fail) failCurrent = undefined;
    });
    if (!plugin || typeof plugin.id !== 'string' || !plugin.id.trim() || plugin.apiVersion !== 1
      || plugin.surface !== surface || !Array.isArray(plugin.platforms)
      || !plugin.platforms.includes(platform) || typeof plugin.load !== 'function') {
      fail();
      return;
    }
    const timeout = Number.isFinite(props.loadTimeoutMs)
      ? Math.max(1, props.loadTimeoutMs) : 15_000;
    timer = setTimeout(fail, timeout);
    // A loader may throw synchronously, ignore cancellation, or resolve after replacement.
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return plugin.load(controller.signal);
    }).then((component) => {
      if (controller.signal.aborted || generation.value !== epoch) return;
      if (!component || !['object', 'function'].includes(typeof component)) {
        fail();
        return;
      }
      clearTimeout(timer);
      root.value = markRaw(component);
      state.value = 'ready';
    }).catch(fail);
  },
  { immediate: true },
);

onErrorCaptured(() => {
  failCurrent?.();
  return false;
});
</script>

<template>
  <SurfaceInstance
    v-if="state === 'ready' && root && context"
    :key="generation"
    :root="root"
    :context="context"
    :view-props="viewProps"
    v-bind="$attrs"
  />
  <section v-else class="surface-status" :role="state === 'failed' ? 'alert' : 'status'" aria-live="polite">
    <p>{{ state === 'failed' ? '界面暂时无法打开' : '正在打开界面…' }}</p>
    <template v-if="state === 'failed'">
      <p>请重试。已保存的会话和资料仍会保留。</p>
      <button type="button" @click="retry++">重新打开</button>
      <button v-if="requestReload" type="button" @click="requestReload">重新加载界面</button>
      <button v-if="requestClose" type="button" @click="requestClose">关闭窗口</button>
    </template>
  </section>
</template>

<style scoped>
.surface-status {
  box-sizing: border-box;
  min-height: 100%;
  padding: 24px;
  color: #273047;
  background: #f6f7fa;
  font: 15px/1.6 system-ui, sans-serif;
  -webkit-app-region: no-drag;
}
.surface-status button {
  margin: 4px 12px 4px 0;
  padding: 8px 14px;
  color: inherit;
  background: white;
  border: 1px solid #b8c0ce;
  border-radius: 6px;
  cursor: pointer;
}
.surface-status button:focus-visible { outline: 2px solid #315ed1; outline-offset: 3px; }
</style>
