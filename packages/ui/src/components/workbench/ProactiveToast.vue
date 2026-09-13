<!--
  Aervox｜思隅 @aervox/ui — 主动智能通知 Toast（CR-032 S5 · Web 端最小闭环）

  Web 工作台无桌宠 SSE 通道，主动关怀经主库 notifications（type=proactive.*，
  payload 携带话术与表现声明）轮询触达：每 30s 拉取一次，仅提示组件挂载之后的
  新通知，单条展示 8s 自动消退，多条排队逐条展示。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Bell } from 'lucide-vue-next';
import { getTransport } from '@aervox/api-client';

interface ProactiveNotificationPayload {
  title?: string;
  message?: string;
  pluginId?: string;
  triggerType?: string;
}

interface NotificationRow {
  id: string;
  type: string;
  scheduledAt: string;
  channel: string;
  status: string;
  payloadJson?: unknown;
  createdAt: string;
}

const POLL_INTERVAL_MS = 30_000;
const TOAST_DURATION_MS = 8_000;

const transport = getTransport();
const seenIds = new Set<string>();
const mountedAt = new Date().toISOString();

const current = ref<ProactiveNotificationPayload | null>(null);
let dismissTimer: number | null = null;
let queue: ProactiveNotificationPayload[] = [];
let pollTimer: number | null = null;

function dismiss(): void {
  current.value = null;
  if (dismissTimer !== null) {
    window.clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  const next = queue.shift();
  if (next) show(next);
}

function show(payload: ProactiveNotificationPayload): void {
  current.value = payload;
  dismissTimer = window.setTimeout(dismiss, TOAST_DURATION_MS);
}

async function poll(): Promise<void> {
  try {
    const res = await transport.request<{ items: NotificationRow[] }>('GET', '/v1/notifications?limit=20');
    const fresh = (res.items ?? [])
      .filter((item) => item.type.startsWith('proactive.'))
      .filter((item) => !seenIds.has(item.id))
      .filter((item) => item.createdAt >= mountedAt);
    for (const item of fresh) {
      seenIds.add(item.id);
      const payload = (item.payloadJson ?? {}) as ProactiveNotificationPayload;
      if (payload.message) queue.push(payload);
    }
    if (!current.value && queue.length > 0) show(queue.shift()!);
  } catch {
    // API 暂不可达时静默，下个节拍重试
  }
}

onMounted(() => {
  void poll();
  pollTimer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
});
onBeforeUnmount(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  if (dismissTimer !== null) window.clearTimeout(dismissTimer);
});
</script>

<template>
  <Transition name="proactive-toast">
    <div v-if="current" class="proactive-toast" role="status" aria-live="polite" aria-label="主动智能关怀通知" @click="dismiss">
      <span class="proactive-toast-icon"><Bell :size="15" /></span>
      <div class="proactive-toast-body">
        <strong>{{ current.title ?? '主动关怀' }}</strong>
        <p>{{ current.message }}</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.proactive-toast {
  position: fixed;
  top: 76px;
  right: 20px;
  z-index: 90;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: 300px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-soft);
  box-shadow: 0 10px 30px rgba(15, 20, 32, 0.14);
  cursor: pointer;
}
.proactive-toast-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
}
.proactive-toast-body {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.proactive-toast-body strong {
  font-size: 12px;
  color: var(--text-primary);
}
.proactive-toast-body p {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.proactive-toast-enter-active,
.proactive-toast-leave-active {
  transition: all 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.proactive-toast-enter-from,
.proactive-toast-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.96);
}
</style>
