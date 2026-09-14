<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  ArrowRight,
  Command,
  Download,
  FilterX,
  Folder,
  MessageSquare,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  X,
} from 'lucide-vue-next';
import { useWorkbenchContext } from '../../composables/workbench-context';
import type { ProjectItem, SessionItem } from '@aervox/contracts';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
}>();

const { layout, sessions, projects, openProjectManager, openImportSession } = useWorkbenchContext();

const query = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const activeIndex = ref(0);

interface PaletteItem {
  id: string;
  type: 'action' | 'project' | 'session';
  title: string;
  subtitle?: string;
  icon?: any;
  color?: string;
  handler: () => void | Promise<void>;
}

watch(
  () => props.open,
  async (val) => {
    if (val) {
      query.value = '';
      activeIndex.value = 0;
      await nextTick();
      inputRef.value?.focus();
    }
  },
);

function close() {
  emit('update:open', false);
}

const items = computed<PaletteItem[]>(() => {
  const q = query.value.trim().toLowerCase();
  const list: PaletteItem[] = [];

  // 1. Actions
  const actions: PaletteItem[] = [
    {
      id: 'action-new-session',
      type: 'action',
      title: '新建会话',
      subtitle: '开启一个崭新的思维与学习对话',
      icon: Plus,
      handler: async () => {
        const pId = projects?.selectedProjectId.value || undefined;
        await sessions.createNewSession('新对话', undefined, pId);
        close();
      },
    },
    {
      id: 'action-project-manager',
      type: 'action',
      title: '项目管理',
      subtitle: '新建、编辑与归档项目上下文',
      icon: Folder,
      handler: () => {
        close();
        openProjectManager?.();
      },
    },
    {
      id: 'action-import-session',
      type: 'action',
      title: '导入外部会话',
      subtitle: '从 ChatGPT、Claude 或 JSON 导入历史记录',
      icon: Download,
      handler: () => {
        close();
        openImportSession?.();
      },
    },
    {
      id: 'action-settings',
      type: 'action',
      title: '系统设置',
      subtitle: '模型配置、人格设定、番茄钟与界面选项',
      icon: Settings,
      handler: () => {
        close();
        layout.openSettings();
      },
    },
    {
      id: 'action-toggle-theme',
      type: 'action',
      title: layout.isDark.value ? '切换至亮色模式' : '切换至暗色模式',
      subtitle: '调整工作台色彩外观风格',
      icon: layout.isDark.value ? Sun : Moon,
      handler: () => {
        void layout.setTheme(layout.isDark.value ? 'light' : 'dark');
        close();
      },
    },
  ];

  if (projects?.selectedProjectId.value) {
    actions.unshift({
      id: 'action-clear-filter',
      type: 'action',
      title: '清除当前项目筛选',
      subtitle: '恢复展示全部会话列表',
      icon: FilterX,
      handler: async () => {
        projects.selectProject(null);
        await sessions.fetchSessions();
        close();
      },
    });
  }

  for (const act of actions) {
    if (!q || act.title.toLowerCase().includes(q) || act.subtitle?.toLowerCase().includes(q)) {
      list.push(act);
    }
  }

  // 2. Projects
  if (projects?.projects.value) {
    for (const p of projects.projects.value) {
      if (!q || p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q)) {
        list.push({
          id: `project-${p.id}`,
          type: 'project',
          title: p.name,
          subtitle: p.description ? `项目 · ${p.description}` : '项目上下文',
          icon: Folder,
          color: p.color || '#6366f1',
          handler: async () => {
            projects.selectProject(p.id);
            await sessions.fetchSessions({ projectId: p.id });
            close();
          },
        });
      }
    }
  }

  // 3. Sessions
  if (sessions.sessions.value) {
    for (const s of sessions.sessions.value) {
      if (!q || s.title.toLowerCase().includes(q)) {
        list.push({
          id: `session-${s.id}`,
          type: 'session',
          title: s.title,
          subtitle: `会话 · 最近更新：${new Date(s.updatedAt).toLocaleDateString()}`,
          icon: MessageSquare,
          handler: () => {
            sessions.switchSession(s.id);
            close();
          },
        });
      }
    }
  }

  return list;
});

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (items.value.length > 0) {
      activeIndex.value = (activeIndex.value + 1) % items.value.length;
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.value.length > 0) {
      activeIndex.value = (activeIndex.value - 1 + items.value.length) % items.value.length;
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const item = items.value[activeIndex.value];
    if (item) {
      void item.handler();
    }
  } else if (e.key === 'Escape') {
    close();
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-black/50 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="w-full max-w-xl rounded-2xl border border-white/10 bg-neutral-900 text-neutral-100 shadow-2xl overflow-hidden flex flex-col max-h-[70vh] animate-in fade-in zoom-in-95 duration-150"
        @keydown="handleKeydown"
      >
        <!-- Search Input Bar -->
        <div class="flex items-center gap-3 border-b border-white/10 px-4 py-3.5 bg-neutral-900">
          <Search class="h-5 w-5 text-neutral-400 flex-shrink-0" />
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            placeholder="搜索功能、项目或会话... (↑↓ 导航，回车执行)"
            class="w-full bg-transparent text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none"
          />
          <kbd
            class="hidden sm:inline-flex items-center rounded border border-white/10 bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400 font-mono"
          >
            ESC
          </kbd>
        </div>

        <!-- Result List -->
        <div class="flex-1 overflow-y-auto p-2 space-y-1">
          <div
            v-if="items.length === 0"
            class="py-12 text-center text-xs text-neutral-500"
          >
            未找到匹配的命令、项目或会话
          </div>

          <button
            v-for="(item, index) in items"
            :key="item.id"
            type="button"
            class="group w-full flex items-center justify-between rounded-xl px-3 py-2.5 text-left transition-colors"
            :class="index === activeIndex ? 'bg-indigo-600/20 text-white' : 'hover:bg-neutral-800 text-neutral-300'"
            @click="item.handler()"
            @mouseenter="activeIndex = index"
          >
            <div class="flex items-center gap-3 min-w-0">
              <div
                class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
                :class="
                  item.type === 'project'
                    ? 'bg-neutral-800'
                    : item.type === 'action'
                      ? 'bg-indigo-500/15 text-indigo-400'
                      : 'bg-neutral-800 text-neutral-400'
                "
              >
                <span
                  v-if="item.color"
                  class="h-2.5 w-2.5 rounded-full"
                  :style="{ backgroundColor: item.color }"
                />
                <component :is="item.icon" v-else class="h-4 w-4" />
              </div>
              <div class="min-w-0">
                <p class="text-xs font-medium truncate" :class="{ 'text-indigo-300': index === activeIndex }">
                  {{ item.title }}
                </p>
                <p v-if="item.subtitle" class="text-[11px] text-neutral-400 truncate mt-0.5">
                  {{ item.subtitle }}
                </p>
              </div>
            </div>

            <ArrowRight
              class="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100"
              :class="{ 'opacity-100 text-indigo-400': index === activeIndex }"
            />
          </button>
        </div>

        <!-- Footer -->
        <div class="border-t border-white/10 px-4 py-2 bg-neutral-900/60 flex items-center justify-between text-[11px] text-neutral-500">
          <div class="flex items-center gap-2">
            <span>使用 <kbd class="rounded bg-neutral-800 px-1 text-neutral-400">↑</kbd> <kbd class="rounded bg-neutral-800 px-1 text-neutral-400">↓</kbd> 切换选项</span>
            <span>·</span>
            <span>按 <kbd class="rounded bg-neutral-800 px-1 text-neutral-400">Enter</kbd> 确认</span>
          </div>
          <div class="flex items-center gap-1.5">
            <Command class="h-3 w-3" />
            <span>Aervox Command</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
