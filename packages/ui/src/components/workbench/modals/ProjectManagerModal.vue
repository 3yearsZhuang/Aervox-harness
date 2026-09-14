<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Archive,
  Check,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-vue-next';
import { useWorkbenchContext } from '../../../composables/workbench-context';
import type { CreateProjectRequest, ProjectItem } from '@aervox/contracts';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
}>();

const { projects, sessions } = useWorkbenchContext();

const isCreating = ref(false);
const newName = ref('');
const newDescription = ref('');
const newColor = ref('#6366f1');

const editingId = ref<string | null>(null);
const editName = ref('');
const editDescription = ref('');
const editColor = ref('#6366f1');

const colorPresets = [
  '#6366f1', // Indigo
  '#3b82f6', // Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ef4444', // Red
  '#ec4899', // Pink
  '#8b5cf6', // Purple
  '#06b6d4', // Cyan
];

watch(
  () => props.open,
  (val) => {
    if (val && projects) {
      void projects.fetchProjects(true);
      isCreating.value = false;
      editingId.value = null;
    }
  },
);

function close() {
  emit('update:open', false);
}

async function handleCreate() {
  if (!newName.value.trim() || !projects) return;
  const payload: CreateProjectRequest = {
    name: newName.value.trim(),
    description: newDescription.value.trim() || undefined,
    color: newColor.value,
  };
  await projects.createProject(payload);
  newName.value = '';
  newDescription.value = '';
  isCreating.value = false;
}

function startEdit(p: ProjectItem) {
  editingId.value = p.id;
  editName.value = p.name;
  editDescription.value = p.description || '';
  editColor.value = p.color || '#6366f1';
}

async function handleUpdate(id: string) {
  if (!editName.value.trim() || !projects) return;
  await projects.updateProject(id, {
    name: editName.value.trim(),
    description: editDescription.value.trim() || undefined,
    color: editColor.value,
  });
  editingId.value = null;
}

async function handleToggleArchive(p: ProjectItem) {
  if (!projects) return;
  await projects.updateProject(p.id, {
    archived: !p.archivedAt,
  });
}

async function handleDelete(id: string) {
  if (!projects) return;
  if (confirm('确认删除该项目？下属会话将保留并转为无归属。')) {
    await projects.deleteProject(id);
    void sessions.fetchSessions();
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="w-full max-w-lg rounded-2xl border border-white/10 bg-neutral-900 text-neutral-100 shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in zoom-in-95 duration-150"
      >
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div class="flex items-center gap-2.5">
            <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-400">
              <Folder class="h-4 w-4" />
            </div>
            <div>
              <h3 class="text-sm font-semibold tracking-wide">项目管理 (Project Context)</h3>
              <p class="text-xs text-neutral-400">组织归类会话，构建专注的工作与学习上下文</p>
            </div>
          </div>
          <button
            type="button"
            class="rounded-lg p-1 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
            @click="close"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto p-5 space-y-4">
          <!-- Create Toggle or Form -->
          <div v-if="!isCreating" class="flex justify-end">
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors shadow-sm"
              @click="isCreating = true"
            >
              <Plus class="h-3.5 w-3.5" />
              新建项目
            </button>
          </div>

          <!-- Create Form -->
          <div
            v-else
            class="rounded-xl border border-indigo-500/30 bg-indigo-950/20 p-4 space-y-3"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium text-indigo-300">新建项目</span>
              <button
                type="button"
                class="text-neutral-400 hover:text-white"
                @click="isCreating = false"
              >
                <X class="h-3.5 w-3.5" />
              </button>
            </div>
            <input
              v-model="newName"
              type="text"
              placeholder="项目名称（例如：考研数学、算法竞赛）"
              class="w-full rounded-lg border border-white/10 bg-neutral-800 px-3 py-2 text-xs text-white placeholder-neutral-500 focus:border-indigo-500 focus:outline-none"
              autofocus
            />
            <input
              v-model="newDescription"
              type="text"
              placeholder="项目简短描述（可选）"
              class="w-full rounded-lg border border-white/10 bg-neutral-800 px-3 py-2 text-xs text-white placeholder-neutral-500 focus:border-indigo-500 focus:outline-none"
            />
            <div class="flex items-center gap-2">
              <span class="text-xs text-neutral-400">强调色：</span>
              <div class="flex items-center gap-1.5">
                <button
                  v-for="color in colorPresets"
                  :key="color"
                  type="button"
                  class="h-5 w-5 rounded-full transition-transform"
                  :style="{ backgroundColor: color }"
                  :class="newColor === color ? 'ring-2 ring-white ring-offset-2 ring-offset-neutral-900 scale-110' : 'opacity-70 hover:opacity-100'"
                  @click="newColor = color"
                />
              </div>
            </div>
            <div class="flex justify-end gap-2 pt-1">
              <button
                type="button"
                class="rounded-lg px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
                @click="isCreating = false"
              >
                取消
              </button>
              <button
                type="button"
                class="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                :disabled="!newName.trim()"
                @click="handleCreate"
              >
                创建
              </button>
            </div>
          </div>

          <!-- Project List -->
          <div class="space-y-2">
            <div
              v-if="!projects?.projects.value || projects.projects.value.length === 0"
              class="py-8 text-center text-xs text-neutral-500"
            >
              暂无项目，点击上方“新建项目”开始聚合会话。
            </div>

            <div
              v-for="p in projects?.projects.value"
              :key="p.id"
              class="group rounded-xl border border-white/5 bg-neutral-800/40 p-3 hover:border-white/10 hover:bg-neutral-800/80 transition-all flex flex-col gap-2"
              :class="{ 'opacity-60': p.archivedAt }"
            >
              <!-- Normal display -->
              <div v-if="editingId !== p.id" class="flex items-center justify-between">
                <div class="flex items-center gap-2.5 min-w-0">
                  <div
                    class="h-3 w-3 rounded-full flex-shrink-0"
                    :style="{ backgroundColor: p.color || '#6366f1' }"
                  />
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <span class="text-xs font-medium text-neutral-100 truncate">{{ p.name }}</span>
                      <span
                        v-if="p.archivedAt"
                        class="rounded bg-neutral-700/80 px-1 py-0.5 text-[10px] text-neutral-300"
                      >
                        已归档
                      </span>
                    </div>
                    <p v-if="p.description" class="text-[11px] text-neutral-400 truncate mt-0.5">
                      {{ p.description }}
                    </p>
                  </div>
                </div>

                <div class="flex items-center gap-1 opacity-80 group-hover:opacity-100">
                  <button
                    type="button"
                    class="rounded-md p-1 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200 transition-colors"
                    title="编辑项目"
                    @click="startEdit(p)"
                  >
                    <Pencil class="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    class="rounded-md p-1 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200 transition-colors"
                    :title="p.archivedAt ? '取消归档' : '归档项目'"
                    @click="handleToggleArchive(p)"
                  >
                    <Archive class="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    class="rounded-md p-1 text-neutral-400 hover:bg-red-950/50 hover:text-red-400 transition-colors"
                    title="删除项目"
                    @click="handleDelete(p.id)"
                  >
                    <Trash2 class="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <!-- Editing mode -->
              <div v-else class="space-y-2 py-1">
                <input
                  v-model="editName"
                  type="text"
                  class="w-full rounded-lg border border-white/10 bg-neutral-700/80 px-2.5 py-1 text-xs text-white focus:border-indigo-500 focus:outline-none"
                />
                <input
                  v-model="editDescription"
                  type="text"
                  placeholder="项目描述"
                  class="w-full rounded-lg border border-white/10 bg-neutral-700/80 px-2.5 py-1 text-xs text-white focus:border-indigo-500 focus:outline-none"
                />
                <div class="flex items-center justify-between pt-1">
                  <div class="flex items-center gap-1.5">
                    <button
                      v-for="color in colorPresets"
                      :key="color"
                      type="button"
                      class="h-4 w-4 rounded-full transition-transform"
                      :style="{ backgroundColor: color }"
                      :class="editColor === color ? 'ring-2 ring-white ring-offset-1 ring-offset-neutral-900 scale-110' : 'opacity-60 hover:opacity-100'"
                      @click="editColor = color"
                    />
                  </div>
                  <div class="flex items-center gap-1.5">
                    <button
                      type="button"
                      class="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-700"
                      @click="editingId = null"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      class="rounded bg-indigo-600 px-2.5 py-1 text-xs text-white hover:bg-indigo-500"
                      @click="handleUpdate(p.id)"
                    >
                      保存
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="border-t border-white/10 px-5 py-3 bg-neutral-900/50 flex justify-end">
          <button
            type="button"
            class="rounded-lg bg-neutral-800 px-4 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
            @click="close"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
