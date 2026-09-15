<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileText,
  Upload,
  X,
} from 'lucide-vue-next';
import { useWorkbenchContext } from '../../../composables/workbench-context';
import type { ImportSessionMessage, ImportSessionRequest } from '@aervox/contracts';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
}>();

const { projects, sessions } = useWorkbenchContext();

const title = ref('');
const selectedProjectId = ref<string>('');
const rawText = ref('');
const errorMessage = ref<string | null>(null);
const isImporting = ref(false);
const importSuccess = ref<string | null>(null);

watch(
  () => props.open,
  (val) => {
    if (val) {
      title.value = '';
      rawText.value = '';
      errorMessage.value = null;
      importSuccess.value = null;
      selectedProjectId.value = projects?.selectedProjectId.value || '';
      if (projects) void projects.fetchProjects();
    }
  },
);

function close() {
  emit('update:open', false);
}

function parseMessages(content: string): ImportSessionMessage[] {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('请输入待导入的对话内容或 JSON');

  // 1. 尝试按 JSON 解析
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);

      // 直接数组格式 [{ role, content }]
      if (Array.isArray(parsed)) {
        return parsed
          .filter((m) => m && typeof m.content === 'string' && m.content.trim())
          .map((m) => ({
            role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
            content: m.content.trim(),
            createdAt: m.createdAt || m.created_at,
          }));
      }

      // 对象包裹格式 { messages: [...] }
      if (parsed.messages && Array.isArray(parsed.messages)) {
        return parsed.messages
          .filter((m: any) => m && typeof m.content === 'string' && m.content.trim())
          .map((m: any) => ({
            role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
            content: m.content.trim(),
            createdAt: m.createdAt || m.created_at,
          }));
      }

      // ChatGPT mapping 导出格式
      if (parsed.mapping && typeof parsed.mapping === 'object') {
        const msgs: ImportSessionMessage[] = [];
        for (const node of Object.values(parsed.mapping) as any[]) {
          if (node?.message?.content?.parts && Array.isArray(node.message.content.parts)) {
            const role = node.message.author?.role;
            const textParts = node.message.content.parts.filter((p: any) => typeof p === 'string').join('\n').trim();
            if (textParts && (role === 'user' || role === 'assistant' || role === 'system')) {
              msgs.push({
                role,
                content: textParts,
                createdAt: node.message.create_time ? new Date(node.message.create_time * 1000).toISOString() : undefined,
              });
            }
          }
        }
        if (msgs.length > 0) return msgs;
      }
    } catch {
      // JSON 解析失败则回退到纯文本段落模式
    }
  }

  // 2. 纯文本降级为单条或问答段落
  return [
    {
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    },
  ];
}

async function handleImport() {
  errorMessage.value = null;
  importSuccess.value = null;
  if (!projects) return;

  let messages: ImportSessionMessage[] = [];
  try {
    messages = parseMessages(rawText.value);
    if (messages.length === 0) {
      throw new Error('未解析到有效的对话消息');
    }
  } catch (err: any) {
    errorMessage.value = err.message || '格式解析错误';
    return;
  }

  isImporting.value = true;
  try {
    const payload: ImportSessionRequest = {
      title: title.value.trim() || undefined,
      projectId: selectedProjectId.value || undefined,
      messages,
    };
    const result = await projects.importSession(payload);
    if (!result) {
      throw new Error('导入服务未响应或请求失败');
    }

    importSuccess.value = `成功导入 ${result.turnsCount} 轮对话（共 ${result.messagesCount} 条消息）！`;
    await sessions.fetchSessions();
    sessions.switchSession(result.session.id);

    setTimeout(() => {
      close();
    }, 900);
  } catch (err: any) {
    errorMessage.value = err.message || '导入会话失败';
  } finally {
    isImporting.value = false;
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
            <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
              <Download class="h-4 w-4" />
            </div>
            <div>
              <h3 class="text-sm font-semibold tracking-wide">外部会话安全导入 (Session Import)</h3>
              <p class="text-xs text-neutral-400">导入 ChatGPT、Claude 或本地 JSON 对话历史为标准本地会话</p>
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
          <!-- Title & Project inputs -->
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label class="block text-xs font-medium text-neutral-300 mb-1">会话标题（可选）</label>
              <input
                v-model="title"
                type="text"
                placeholder="缺省自动从首条消息提炼"
                class="w-full rounded-lg border border-white/10 bg-neutral-800 px-3 py-2 text-xs text-white placeholder-neutral-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-neutral-300 mb-1">归属项目（可选）</label>
              <select
                v-model="selectedProjectId"
                class="w-full rounded-lg border border-white/10 bg-neutral-800 px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
              >
                <option value="">无项目（未分类）</option>
                <option
                  v-for="p in projects?.projects.value"
                  :key="p.id"
                  :value="p.id"
                >
                  {{ p.name }}
                </option>
              </select>
            </div>
          </div>

          <!-- Raw Content -->
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="block text-xs font-medium text-neutral-300">对话内容或导出的 JSON</label>
              <span class="text-[11px] text-neutral-400">支持标准 JSON 数组或 ChatGPT 导出</span>
            </div>
            <textarea
              v-model="rawText"
              rows="8"
              placeholder='粘贴外部对话 JSON，例如：
[
  { "role": "user", "content": "你好，请解释微积分" },
  { "role": "assistant", "content": "微积分是研究极限、微分与积分的数学分支..." }
]'
              class="w-full font-mono rounded-lg border border-white/10 bg-neutral-800/90 px-3 py-2 text-xs text-white placeholder-neutral-500 focus:border-emerald-500 focus:outline-none resize-none"
            />
          </div>

          <!-- Alerts -->
          <div
            v-if="errorMessage"
            class="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-950/30 p-2.5 text-xs text-red-300"
          >
            <AlertCircle class="h-4 w-4 flex-shrink-0" />
            <span>{{ errorMessage }}</span>
          </div>

          <div
            v-if="importSuccess"
            class="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-950/30 p-2.5 text-xs text-emerald-300"
          >
            <CheckCircle2 class="h-4 w-4 flex-shrink-0" />
            <span>{{ importSuccess }}</span>
          </div>
        </div>

        <!-- Footer -->
        <div class="border-t border-white/10 px-5 py-3 bg-neutral-900/50 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 transition-colors"
            @click="close"
          >
            取消
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 transition-colors disabled:opacity-50"
            :disabled="!rawText.trim() || isImporting"
            @click="handleImport"
          >
            <Upload class="h-3.5 w-3.5" />
            {{ isImporting ? '导入中...' : '开始导入' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
