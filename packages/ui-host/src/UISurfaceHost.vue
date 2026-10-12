<script setup lang="ts">
import { markRaw, onErrorCaptured, shallowRef, ref, computed, watch, type Component } from 'vue';
import SurfaceInstance from './SurfaceInstance';
import {
  UI_HOST_API_VERSION,
  type UIPlatform,
  type UISurfaceContext,
  type UISurfaceFailureReason,
  type UISurfaceKind,
  type UISurfacePlugin,
} from './surface-context';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{
  plugin: UISurfacePlugin | null;
  surface: UISurfaceKind;
  platform: UIPlatform;
  viewProps?: Record<string, unknown>;
  requestClose?: () => void;
  requestReload?: () => void;
  loadTimeoutMs?: number;
  /** 宿主当前提供的能力标识，用于校验插件清单的 requires.capabilities */
  hostCapabilities?: readonly string[];
  /** 瞬时故障自动重试次数与退避间隔（毫秒），默认 800ms → 2400ms 两次 */
  autoRetryDelaysMs?: readonly number[];
}>(), { viewProps: () => ({}), loadTimeoutMs: 15_000, hostCapabilities: () => [], autoRetryDelaysMs: () => [800, 2400] });

const FAILURE_COPY: Record<UISurfaceFailureReason, string> = {
  missing: '没有可用的界面。',
  malformed: '界面插件描述不完整。',
  'api-version': '界面插件版本与宿主不兼容。',
  'host-api-version': '界面插件需要更新版本的宿主。',
  'surface-mismatch': '界面插件类型与宿主插槽不匹配。',
  'platform-unsupported': '该界面暂不支持当前平台。',
  'capability-unsupported': '该界面需要当前宿主不具备的能力。',
  'load-failed': '界面资源加载失败。',
  'load-timeout': '界面加载超时。',
  'render-error': '界面渲染时发生错误。',
};

/** 契约类拒绝是永久性的，自动重试无意义；只有瞬时故障才自动退避重试 */
const TRANSIENT_REASONS: ReadonlySet<UISurfaceFailureReason> = new Set(['load-failed', 'load-timeout', 'render-error']);

const root = shallowRef<Component>();
const context = shallowRef<UISurfaceContext>();
const state = ref<'loading' | 'ready' | 'failed'>('loading');
const failureReason = ref<UISurfaceFailureReason | null>(null);
const retry = ref(0);
const autoRetryAttempt = ref(0);
const generation = ref(0);
let failCurrent: ((reason: UISurfaceFailureReason) => void) | undefined;
// 自动重试链计数跨世代保留；手动重试或换插件时才清零
let autoRetryChain = 0;
let retryIsAutomatic = false;

const failureCopy = computed(() => (failureReason.value ? FAILURE_COPY[failureReason.value] : ''));
const pluginName = computed(() => props.plugin?.displayName ?? props.plugin?.id ?? '');
const autoRetryScheduled = ref(false);
const autoRetrying = computed(() => state.value === 'failed' && autoRetryScheduled.value);

/** 装配前校验清单契约：返回 null 表示可加载，否则为结构化拒绝原因 */
function validateManifest(plugin: UISurfacePlugin | null): UISurfaceFailureReason | null {
  if (!plugin) return 'missing';
  if (typeof plugin.id !== 'string' || !plugin.id.trim() || typeof plugin.load !== 'function'
    || !Array.isArray(plugin.platforms)) return 'malformed';
  if (plugin.apiVersion !== 1) return 'api-version';
  if ((plugin.requires?.hostApiVersion ?? 1) > UI_HOST_API_VERSION) return 'host-api-version';
  if (plugin.surface !== props.surface) return 'surface-mismatch';
  if (!plugin.platforms.includes(props.platform)) return 'platform-unsupported';
  const missing = (plugin.requires?.capabilities ?? []).filter((c) => !props.hostCapabilities.includes(c));
  if (missing.length > 0) return 'capability-unsupported';
  return null;
}

watch(
  () => [props.plugin, props.surface, props.platform, props.requestClose, retry.value] as const,
  ([plugin, surface, platform, requestClose], _, onCleanup) => {
    const epoch = ++generation.value;
    const controller = new AbortController();
    root.value = undefined;
    state.value = 'loading';
    failureReason.value = null;
    autoRetryScheduled.value = false;
    if (!retryIsAutomatic) autoRetryChain = 0;
    retryIsAutomatic = false;
    autoRetryAttempt.value = autoRetryChain;
    context.value = Object.freeze({ platform, surface, signal: controller.signal, requestClose });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (reason: UISurfaceFailureReason) => {
      if (controller.signal.aborted || generation.value !== epoch) return;
      clearTimeout(timer);
      controller.abort();
      root.value = undefined;
      failureReason.value = reason;
      state.value = 'failed';
      // 瞬时故障按退避表自动重试；手动「重新打开」会递增 retry 并进入新世代
      const delay = TRANSIENT_REASONS.has(reason) ? props.autoRetryDelaysMs[autoRetryAttempt.value] : undefined;
      if (delay !== undefined) {
        autoRetryChain += 1;
        autoRetryAttempt.value = autoRetryChain;
        autoRetryScheduled.value = true;
        retryTimer = setTimeout(() => {
          if (generation.value === epoch && state.value === 'failed') {
            retryIsAutomatic = true;
            retry.value += 1;
          }
        }, delay);
      }
    };
    failCurrent = fail;
    onCleanup(() => {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      controller.abort();
      if (failCurrent === fail) failCurrent = undefined;
    });
    const rejected = validateManifest(plugin);
    if (rejected) {
      fail(rejected);
      return;
    }
    const timeout = Number.isFinite(props.loadTimeoutMs)
      ? Math.max(1, props.loadTimeoutMs) : 15_000;
    timer = setTimeout(() => fail('load-timeout'), timeout);
    // A loader may throw synchronously, ignore cancellation, or resolve after replacement.
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return plugin!.load(controller.signal);
    }).then((component) => {
      if (controller.signal.aborted || generation.value !== epoch) return;
      if (!component || !['object', 'function'].includes(typeof component)) {
        fail('load-failed');
        return;
      }
      clearTimeout(timer);
      autoRetryChain = 0;
      root.value = markRaw(component);
      state.value = 'ready';
    }).catch(() => fail('load-failed'));
  },
  { immediate: true },
);

onErrorCaptured(() => {
  failCurrent?.('render-error');
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
  <section
    v-else
    class="surface-status"
    :class="{ 'surface-status--failed': state === 'failed' }"
    :role="state === 'failed' ? 'alert' : 'status'"
    aria-live="polite"
    :data-failure-reason="failureReason ?? undefined"
  >
    <!-- 加载骨架：在真实根组件就位前给出结构预览，而非一行纯文本 -->
    <div v-if="state === 'loading'" class="surface-skeleton" aria-hidden="true">
      <div class="surface-skeleton__bar" />
      <div class="surface-skeleton__row">
        <div class="surface-skeleton__side" />
        <div class="surface-skeleton__main">
          <div class="surface-skeleton__card" />
          <div class="surface-skeleton__card surface-skeleton__card--short" />
        </div>
      </div>
    </div>
    <p class="surface-status__title">{{ state === 'failed' ? '界面暂时无法打开' : '正在打开界面…' }}</p>
    <template v-if="state === 'failed'">
      <p>{{ pluginName ? `${pluginName}：` : '' }}{{ failureCopy }}</p>
      <p v-if="autoRetrying" class="surface-status__hint">正在自动重试（第 {{ autoRetryAttempt }} 次）…</p>
      <p v-else>请重试。已保存的会话和资料仍会保留。</p>
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
.surface-status__title { margin: 0 0 4px; font-weight: 600; }
.surface-status__hint { color: #5b6475; }
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

.surface-skeleton {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 20px;
}
.surface-skeleton__bar {
  height: 40px;
  border-radius: 8px;
  background: linear-gradient(90deg, #e6e9f0 25%, #f2f4f9 50%, #e6e9f0 75%);
  background-size: 200% 100%;
  animation: surface-shimmer 1.4s ease infinite;
}
.surface-skeleton__row { display: flex; gap: 16px; }
.surface-skeleton__side {
  width: 180px;
  height: 220px;
  border-radius: 8px;
  background: linear-gradient(90deg, #e6e9f0 25%, #f2f4f9 50%, #e6e9f0 75%);
  background-size: 200% 100%;
  animation: surface-shimmer 1.4s ease infinite;
}
.surface-skeleton__main { flex: 1; display: flex; flex-direction: column; gap: 12px; }
.surface-skeleton__card {
  height: 120px;
  border-radius: 8px;
  background: linear-gradient(90deg, #e6e9f0 25%, #f2f4f9 50%, #e6e9f0 75%);
  background-size: 200% 100%;
  animation: surface-shimmer 1.4s ease infinite;
}
.surface-skeleton__card--short { height: 64px; width: 70%; }
@keyframes surface-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .surface-skeleton__bar,
  .surface-skeleton__side,
  .surface-skeleton__card { animation: none; }
}
</style>
