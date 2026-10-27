<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SessionItem } from '@aervox/contracts';
import { AervoxButton, AervoxDialog } from '@aervox/ui/primitives';
import { History, Plus, RefreshCw } from 'lucide-vue-next';

const props = withDefaults(defineProps<{
  modelValue: boolean; sessions: readonly SessionItem[]; activeSessionId: string;
  loading?: boolean; error?: string | null; changing?: boolean;
  switchLocked?: boolean; lockReason?: string; notice?: string;
}>(), { loading: false, error: null, changing: false, switchLocked: false, lockReason: '', notice: '' });
const emit = defineEmits<{
  'update:modelValue': [value: boolean]; refresh: []; new: [];
  select: [id: string]; history: [session: SessionItem];
}>();
const query = ref('');
const matching = computed(() => props.sessions.filter(item => item.title.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
function select(id: string) {
  if (!props.switchLocked && !props.changing) emit('select', id);
}
</script>

<template>
  <AervoxDialog :model-value="modelValue" title="会话" custom-class="mobile-sessions-dialog" body-max-height="calc(100dvh - 180px)" @update:model-value="emit('update:modelValue', $event)">
    <div class="mobile-session-actions">
      <AervoxButton variant="primary" :icon="Plus" :loading="changing" :disabled="loading || changing || switchLocked" @click="emit('new')">新对话</AervoxButton>
      <AervoxButton variant="ghost" :icon="RefreshCw" :disabled="loading || changing" @click="emit('refresh')">刷新</AervoxButton>
    </div>
    <p v-if="notice" role="alert" class="mobile-session-error">{{ notice }}</p>
    <p v-if="switchLocked" class="mobile-session-note" role="status">{{ lockReason || '当前回复或交互尚未结束。可以回看记录，结束当前回复后再切换或新建。' }}</p>
    <label class="mobile-session-search">搜索会话<input v-model="query" class="aervox-field" type="search" autocomplete="off" aria-label="搜索会话" placeholder="输入会话标题" /></label>
    <p v-if="loading" role="status">正在读取会话…</p>
    <div v-if="error" class="mobile-session-error" role="alert"><p>暂时无法更新会话列表，已保留上次结果。</p><AervoxButton variant="ghost" :disabled="loading" @click="emit('refresh')">重试读取会话</AervoxButton></div>
    <ul class="mobile-session-list" aria-label="已保存的会话" :aria-busy="loading">
      <li v-for="session in matching" :key="session.id" :class="{ 'is-current': session.id === activeSessionId }">
        <button type="button" class="mobile-session-select" :aria-current="session.id === activeSessionId ? 'true' : undefined" :disabled="changing || switchLocked" @click="select(session.id)">
          <span>{{ session.title }}</span><small>{{ session.id === activeSessionId ? '当前会话' : '继续对话' }}</small>
        </button>
        <AervoxButton variant="ghost" :icon="History" icon-only :aria-label="`回看「${session.title}」`" @click="emit('history', session)" />
      </li>
    </ul>
    <p v-if="!loading && !error && !sessions.length">还没有会话，点击“新对话”开始。</p>
    <p v-else-if="sessions.length && !matching.length">没有匹配的会话。</p>
  </AervoxDialog>
</template>

<style scoped>
.mobile-session-actions { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.mobile-session-note { padding: 12px 16px; border-radius: 16px; background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); font-size: 14px; line-height: 20px; }
.mobile-session-search { display: grid; gap: 8px; font-size: 14px; line-height: 20px; }
.mobile-session-search input { width: 100%; }
.mobile-session-list { list-style: none; padding: 0; margin: 16px 0 0; display: grid; gap: 8px; }
.mobile-session-list li { display: flex; align-items: center; gap: 4px; border-radius: 16px; background: var(--md-sys-color-surface-container); }
.mobile-session-list li.is-current { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.mobile-session-select { display: grid; gap: 4px; flex: 1; min-width: 0; min-height: 64px; padding: 12px 16px; border: 0; border-radius: 16px; text-align: start; font: inherit; color: inherit; background: transparent; cursor: pointer; }
.mobile-session-select span { overflow-wrap: anywhere; font-size: 16px; line-height: 24px; }
.mobile-session-select small { font-size: 12px; line-height: 16px; color: var(--md-sys-color-on-surface-variant); }
.mobile-session-select:disabled { cursor: default; }
.mobile-session-select:disabled:not([aria-current]) { opacity: .6; }
.mobile-session-error { color: var(--md-sys-color-error); }
</style>
