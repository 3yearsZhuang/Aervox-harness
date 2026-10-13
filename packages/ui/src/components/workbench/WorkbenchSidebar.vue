<script setup lang="ts">
import { AervoxButton } from '../../primitives';
import { computed, nextTick, ref, watch } from 'vue';
import { ElDropdown, ElDropdownMenu, ElDropdownItem } from 'element-plus/es/components/dropdown/index.mjs';
import { aervoxConfirm } from '../../primitives/feedback/confirm-service';
import {
  Check,
  CheckSquare,
  Command,
  Download,
  Edit2,
  Ellipsis,
  Folder,
  MessageSquare,
  Moon,
  PanelLeft,
  Pin,
  Plus,
  Puzzle,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-vue-next';
import AervoxBrandMark from '../AervoxBrandMark.vue';
import { useWorkbenchContext } from '../../composables/workbench-context';
import type { SessionItem } from '@aervox/contracts';

const {
  layout,
  sessions,
  projects,
  openProjectManager,
  openImportSession,
  openCommandPalette,
} = useWorkbenchContext();

const searchQuery = ref('');
const editingSessionId = ref<string | null>(null);
const editingTitle = ref('');
const editInputRef = ref<HTMLInputElement | null>(null);
const sidebar = ref<HTMLElement | null>(null);
const sessionError = ref('');
const narrowSidebar = computed(() => layout.narrowSidebar?.value ?? false);
let returnFocus: HTMLElement | null = null;

watch(() => narrowSidebar.value && !layout.standardSidebarCollapsed.value, async (open) => {
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    sidebar.value?.querySelector<HTMLButtonElement>('button')?.focus();
  } else {
    await nextTick();
    if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus();
    else document.querySelector<HTMLButtonElement>('[aria-controls="workbench-sidebar"]')?.focus();
    returnFocus = null;
  }
});

function closeNarrowSidebar() {
  if (narrowSidebar.value) layout.standardSidebarCollapsed.value = true;
}

function handleSidebarKeydown(event: KeyboardEvent) {
  if (!narrowSidebar.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeNarrowSidebar();
  } else if (event.key === 'Tab') {
    const elements = Array.from(sidebar.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [href], [tabindex="0"]',
    ) ?? []).filter((el) => el.getClientRects().length > 0);
    const first = elements[0];
    const last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
}

function isToday(dateStr: string): boolean {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  } catch {
    return false;
  }
}

function isWithin7Days(dateStr: string): boolean {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    return diff > 0 && diff <= 7 * 24 * 3600 * 1000;
  } catch {
    return false;
  }
}

const filteredSessions = computed(() => {
  const list = sessions.sessions.value || [];
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) => s.title.toLowerCase().includes(q));
});

const groupedSessions = computed(() => {
  const pinned: SessionItem[] = [];
  const today: SessionItem[] = [];
  const week: SessionItem[] = [];
  const earlier: SessionItem[] = [];

  for (const s of filteredSessions.value) {
    if (s.isPinned) {
      pinned.push(s);
    } else if (isToday(s.updatedAt)) {
      today.push(s);
    } else if (isWithin7Days(s.updatedAt)) {
      week.push(s);
    } else {
      earlier.push(s);
    }
  }

  const groups: Array<{ key: string; label: string; items: SessionItem[] }> = [];
  if (pinned.length > 0) groups.push({ key: 'pinned', label: '置顶', items: pinned });
  if (today.length > 0) groups.push({ key: 'today', label: '今天', items: today });
  if (week.length > 0) groups.push({ key: 'week', label: '最近 7 天', items: week });
  if (earlier.length > 0) groups.push({ key: 'earlier', label: '更早', items: earlier });

  return groups;
});

const activeProject = computed(() => {
  if (!projects?.selectedProjectId.value) return null;
  return projects.projects.value.find((p) => p.id === projects.selectedProjectId.value) ?? null;
});

async function handleSelectProjectFilter(projectId: string | null) {
  projects?.selectProject(projectId);
  await sessions.fetchSessions({ projectId: projectId || undefined });
}

function getProjectColor(projectId?: string | null): string {
  if (!projectId || !projects) return '';
  const p = projects.projects.value.find((item) => item.id === projectId);
  return p?.color || 'var(--accent, #3b66db)';
}

function getProjectName(projectId?: string | null): string {
  if (!projectId || !projects) return '';
  const p = projects.projects.value.find((item) => item.id === projectId);
  return p?.name || '项目';
}

async function handleCreateSession() {
  const pId = projects?.selectedProjectId.value || undefined;
  await sessions.createNewSession('新对话', undefined, pId);
  closeNarrowSidebar();
}

function handleSelectSession(sessionId: string) {
  sessions.switchSession(sessionId);
  closeNarrowSidebar();
}

async function startRename(session: SessionItem) {
  editingSessionId.value = session.id;
  editingTitle.value = session.title;
  await nextTick();
  editInputRef.value?.focus();
  editInputRef.value?.select();
}

async function saveRename(sessionId: string) {
  if (editingSessionId.value !== sessionId) return;
  const newTitle = editingTitle.value.trim();
  sessionError.value = '';
  try {
    if (newTitle) await sessions.renameSession(sessionId, newTitle);
    editingSessionId.value = null;
  } catch {
    sessionError.value = '重命名没有保存，请重试。';
  }
}

function cancelRename() {
  editingSessionId.value = null;
}

async function handleDeleteSession(sessionId: string) {
  if (await aervoxConfirm({ title: '删除会话', message: '确认删除此会话记录吗？', confirmText: '删除', variant: 'danger' })) {
    try {
      await sessions.deleteSession(sessionId);
    } catch {
      sessionError.value = '会话未能删除，请重试。';
    }
  }
}

function toggleTheme() {
  layout.setTheme(layout.isDark.value ? 'light' : 'dark');
}
</script>

<template>
  <aside
    id="workbench-sidebar"
    ref="sidebar"
    class="workbench-standard-sidebar"
    :class="{ 'is-collapsed': layout.standardSidebarCollapsed.value, 'is-overlay': narrowSidebar }"
    :role="narrowSidebar ? 'dialog' : undefined"
    :aria-modal="narrowSidebar ? true : undefined"
    :inert="layout.standardSidebarCollapsed.value"
    aria-label="会话与功能导航侧边栏"
    @keydown="handleSidebarKeydown"
  >
    <div class="sidebar-header">
      <div class="brand-badge">
        <AervoxBrandMark :size="22" />
        <span class="brand-title">Aervox 思隅</span>
      </div>
      <AervoxButton variant="ghost" icon-only
        type="button"
        class="sidebar-action-btn"
        :title="layout.standardSidebarCollapsed.value ? '展开侧边栏 (⌘/)' : '折叠侧边栏 (⌘/)'"
        aria-label="折叠侧边栏"
        @click="layout.toggleStandardSidebar()"
      >
        <PanelLeft :size="16" />
      </AervoxButton>
    </div>

    <!-- 新建对话按钮 -->
    <div class="sidebar-new-chat-wrap">
      <AervoxButton variant="primary"
        type="button"
        class="new-chat-btn"
        title="新建对话 (⌘N)"
        @click="handleCreateSession"
      >
        <Plus :size="16" />
        <span>新对话</span>
        <kbd class="shortcut-kbd">⌘N</kbd>
      </AervoxButton>
    </div>

    <!-- 项目上下文与快捷命令栏 (CR-048 / W3) -->
    <div class="sidebar-project-bar">
      <!-- 当前项目过滤状态与切换 -->
      <AervoxButton variant="ghost"
        type="button"
        class="project-filter-pill"
        :class="{ 'is-active': Boolean(activeProject) }"
        :title="activeProject ? `当前项目：${activeProject.name}（点击管理）` : '全部项目（点击管理）'"
        @click="openProjectManager?.()"
      >
        <span
          class="project-dot"
          :style="{ backgroundColor: activeProject?.color || 'var(--text-muted)' }"
        />
        <span>{{ activeProject ? activeProject.name : '全部会话' }}</span>
      </AervoxButton>

      <!-- 快速动作：项目管理、导入会话、命令面板 -->
      <div class="sidebar-quick-tools">
        <AervoxButton variant="ghost" icon-only
          v-if="activeProject"
          type="button"
          class="sidebar-mini-icon-btn"
          title="清除项目筛选"
          aria-label="清除项目筛选"
          @click="handleSelectProjectFilter(null)"
        >
          <X :size="13" />
        </AervoxButton>
        <AervoxButton variant="ghost" icon-only
          type="button"
          class="sidebar-mini-icon-btn"
          title="项目管理"
          aria-label="项目管理"
          @click="openProjectManager?.()"
        >
          <Folder :size="13" />
        </AervoxButton>
        <AervoxButton variant="ghost" icon-only
          type="button"
          class="sidebar-mini-icon-btn"
          title="导入外部会话"
          aria-label="导入外部会话"
          @click="openImportSession?.()"
        >
          <Download :size="13" />
        </AervoxButton>
        <AervoxButton variant="ghost" icon-only
          type="button"
          class="sidebar-mini-icon-btn"
          title="命令面板 (⌘K)"
          aria-label="命令面板"
          @click="openCommandPalette?.()"
        >
          <Command :size="13" />
        </AervoxButton>
      </div>
    </div>

    <!-- 搜索筛选 -->
    <div class="sidebar-search-wrap">
      <Search :size="14" class="search-icon" />
      <input
        v-model="searchQuery"
        type="text"
        placeholder="搜索对话…"
        class="aervox-field sidebar-search-input"
        aria-label="搜索历史会话"
      />
      <AervoxButton variant="ghost" icon-only
        v-if="searchQuery"
        type="button"
        class="search-clear-btn"
        aria-label="清空搜索"
        @click="searchQuery = ''"
      >
        <X :size="12" />
      </AervoxButton>
    </div>

    <!-- 会话列表 -->
    <div class="sidebar-sessions-scroll" role="navigation" aria-label="会话历史">
      <p v-if="sessionError" class="sidebar-error" role="alert">{{ sessionError }}</p>
      <div v-if="groupedSessions.length === 0" class="empty-sessions">
        <span>{{ searchQuery ? '未找到匹配的对话' : '暂无对话，点击上方新建' }}</span>
      </div>

      <div
        v-for="group in groupedSessions"
        :key="group.key"
        class="session-group"
      >
        <div class="session-group-title">{{ group.label }}</div>
        <ul class="session-group-list">
          <li
            v-for="s in group.items"
            :key="s.id"
            class="session-item"
            :class="{ 'is-active': s.id === sessions.activeSessionId.value }"
          >
            <!-- 编辑标题模式 -->
            <div v-if="editingSessionId === s.id" class="session-rename-form" @click.stop>
              <input
                :ref="(el) => { editInputRef = el as HTMLInputElement | null; }"
                v-model="editingTitle"
                type="text"
                class="aervox-field session-rename-input"
                aria-label="会话名称"
                @keydown.enter.prevent="saveRename(s.id)"
                @keydown.esc.prevent="cancelRename"
                @blur="saveRename(s.id)"
              />
              <AervoxButton variant="ghost" icon-only
                type="button"
                class="rename-action-btn"
                title="保存"
                @mousedown.prevent
                @click="saveRename(s.id)"
              >
                <Check :size="13" />
              </AervoxButton>
            </div>

            <!-- 常规标题模式 -->
            <template v-else>
              <button
                type="button"
                class="session-select"
                :aria-current="s.id === sessions.activeSessionId.value ? 'page' : undefined"
                :title="s.title"
                @click="handleSelectSession(s.id)"
              >
                <span class="session-leading-icon">
                  <Pin v-if="s.isPinned" :size="14" class="pin-icon" />
                  <MessageSquare v-else :size="14" />
                </span>
                <span
                  v-if="s.projectId && getProjectColor(s.projectId)"
                  class="session-project-indicator"
                  :style="{ backgroundColor: getProjectColor(s.projectId) }"
                  :title="getProjectName(s.projectId)"
                />
                <span class="session-title" :title="s.title">{{ s.title }}</span>
              </button>
              <ElDropdown trigger="click" placement="bottom-end" @command="(command: string) => command === 'rename' ? startRename(s) : handleDeleteSession(s.id)">
                <AervoxButton variant="ghost" icon-only type="button" class="session-more-btn" :aria-label="`更多操作：${s.title}`">
                  <Ellipsis :size="17" />
                </AervoxButton>
                <template #dropdown>
                  <ElDropdownMenu>
                    <ElDropdownItem command="rename"><Edit2 :size="14" />重命名会话</ElDropdownItem>
                    <ElDropdownItem command="delete" class="danger-item"><Trash2 :size="14" />删除会话</ElDropdownItem>
                  </ElDropdownMenu>
                </template>
              </ElDropdown>
            </template>
          </li>
        </ul>
      </div>
    </div>

    <!-- 导航菜单 -->
    <div class="sidebar-nav-section">
      <AervoxButton variant="ghost"
        type="button"
        class="sidebar-nav-item"
        :class="{ 'is-active': layout.taskCenterOpen.value }"
        @click="layout.toggleTaskCenter()"
      >
        <CheckSquare :size="16" />
        <span>任务中心</span>
      </AervoxButton>

      <AervoxButton variant="ghost"
        type="button"
        class="sidebar-nav-item"
        @click="layout.openSettingsCategory('plugins')"
      >
        <Puzzle :size="16" />
        <span>扩展与插件</span>
      </AervoxButton>

      <AervoxButton variant="ghost"
        type="button"
        class="sidebar-nav-item"
        @click="layout.openSettings()"
      >
        <Settings :size="16" />
        <span>系统设置</span>
      </AervoxButton>
    </div>

    <!-- 底部功能栏 -->
    <div class="sidebar-footer">
      <AervoxButton variant="ghost"
        type="button"
        class="mode-switch-btn"
        title="切换至桌宠陪伴模式"
        @click="layout.switchWorkbenchMode('companion')"
      >
        <Sparkles :size="15" class="sparkles-icon" />
        <span>桌宠陪伴模式</span>
      </AervoxButton>

      <AervoxButton variant="ghost" icon-only
        type="button"
        class="sidebar-action-btn theme-toggle-btn"
        :title="layout.isDark.value ? '切换为明亮模式' : '切换为暗色模式'"
        @click="toggleTheme"
      >
        <Sun v-if="layout.isDark.value" :size="16" />
        <Moon v-else :size="16" />
      </AervoxButton>
    </div>
  </aside>
</template>
