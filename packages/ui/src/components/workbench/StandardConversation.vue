<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { ArrowDown, Check, Copy, FileText } from 'lucide-vue-next';
import ExtensionSlot from '../extension/ExtensionSlot.vue';
import ToolApprovalCard from './ToolApprovalCard.vue';
import { useWorkbenchContext } from '../../composables/workbench-context';
import { renderMarkdown } from '../../utils/markdown';

const { layout, conversation } = useWorkbenchContext();
const { story, streaming } = conversation;
const viewport = ref<HTMLElement | null>(null);
const following = ref(true);
const copiedId = ref<number | null>(null);
const copyError = ref('');
let copyAttempt = 0;

function trackScroll() {
  const el = viewport.value;
  if (el) following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
}

async function scrollToLatest() {
  following.value = true;
  await nextTick();
  const el = viewport.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(() => [story.value, story.value.length, story.value.at(-1)?.text, story.value.at(-1)?.state], async () => {
  if (following.value) await scrollToLatest();
});
onMounted(scrollToLatest);
watch(() => story.value, scrollToLatest);

async function copyMessage(id: number, text: string) {
  const attempt = ++copyAttempt;
  copiedId.value = null;
  copyError.value = '';
  try {
    await navigator.clipboard.writeText(text);
    if (attempt === copyAttempt) {
      copiedId.value = id;
      setTimeout(() => {
        if (copiedId.value === id) copiedId.value = null;
      }, 2000);
    }
  } catch {
    if (attempt === copyAttempt) {
      copyError.value = '无法复制，请选择文字后复制';
      setTimeout(() => {
        if (copyError.value === '无法复制，请选择文字后复制') copyError.value = '';
      }, 4000);
    }
  }
}
</script>

<template>
  <section class="standard-conversation" aria-label="完整对话">
    <div ref="viewport" class="standard-message-scroll" @scroll="trackScroll">
      <div class="standard-message-list">
        <ExtensionSlot name="conversation:top" />
        <article v-for="line in story" :key="line.id" class="standard-message" :class="[line.speaker, line.state]" :aria-label="line.speaker === 'assistant' ? layout.assistantDisplayName.value : '你'">
          <span v-if="line.speaker === 'assistant'" class="standard-message-speaker">{{ layout.assistantDisplayName.value }}</span>
          <div class="standard-message-content">
            <div v-if="line.speaker === 'assistant'" class="markdown-body" v-html="renderMarkdown(line.text || (line.state === 'streaming' ? '正在思考…' : '这次没有收到回答'))" />
            <div v-else class="standard-user-text">{{ line.text }}</div>
            <span v-if="line.state === 'streaming'" class="standard-stream-indicator" aria-label="正在生成" />
            <div v-if="line.attachments?.length" class="standard-message-attachments">
              <span v-for="(attachment, index) in line.attachments" :key="index"><FileText :size="14" />{{ attachment.name }}</span>
            </div>
          </div>
          <div v-if="line.speaker === 'assistant' && line.text && line.state !== 'streaming'" class="standard-message-actions">
            <button type="button" :aria-label="copiedId === line.id ? '已复制回复' : '复制回复'" :title="copiedId === line.id ? '已复制' : '复制回复'" @click="copyMessage(line.id, line.text)">
              <Check v-if="copiedId === line.id" :size="15" /><Copy v-else :size="15" />
            </button>
            <ExtensionSlot name="message:bubble-actions" :context="{ message: line, text: line.text, speaker: line.speaker }" />
          </div>
        </article>
        <p v-if="story.length === 0" class="standard-empty">发送消息，开始新的对话</p>
        <ToolApprovalCard />
        <ExtensionSlot name="conversation:bottom" />
        <p v-if="copyError" class="standard-copy-error" role="alert">{{ copyError }}</p>
      </div>
    </div>
    <button v-if="!following" class="standard-jump-latest" type="button" @click="scrollToLatest"><ArrowDown :size="14" />回到最新</button>
    <span class="sr-only" role="status">{{ streaming ? '思隅正在生成回复' : '回复已就绪' }}</span>
  </section>
</template>
