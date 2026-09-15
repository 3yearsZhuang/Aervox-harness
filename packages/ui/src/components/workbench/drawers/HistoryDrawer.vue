<script setup lang="ts">
import { FileText, History, Image as ImageIcon, Music } from 'lucide-vue-next';
import ExtensionSlot from '../../extension/ExtensionSlot.vue';
import { useWorkbenchContext } from '../../../composables/workbench-context';
import { renderMarkdown } from '../../../utils/markdown';
import { AervoxDrawer } from '../../../primitives';

const { layout, conversation } = useWorkbenchContext();
const { assistantDisplayName, historyOpen } = layout;
const { story, historyViewport } = conversation;

function attachmentIconFor(mediaType: string) {
  if (mediaType.startsWith('image/')) return ImageIcon;
  if (mediaType.startsWith('audio/')) return Music;
  return FileText;
}
</script>

<template>
  <AervoxDrawer
    v-model="historyOpen"
    title="对话回看"
    :icon="History"
    width="480px"
    aria-label="对话回看"
    no-padding
  >
    <div ref="historyViewport" class="vn-history-list">
      <p v-for="line in story" :key="line.id" class="vn-history-line" :class="line.speaker">
        <span class="vn-history-speaker">{{ line.speaker === 'assistant' ? assistantDisplayName : '你' }}</span>
        <span class="vn-history-text">
          <span v-if="line.speaker === 'assistant'" class="markdown-body" v-html="renderMarkdown(line.text || '…')" />
          <template v-else>{{ line.text }}</template>
          <span v-if="line.attachments && line.attachments.length > 0" class="vn-history-attachments">
            <span v-for="(att, attIndex) in line.attachments" :key="attIndex" class="vn-history-attachment">
              <component :is="attachmentIconFor(att.mediaType)" :size="12" />
              <span>{{ att.name }}</span>
            </span>
          </span>
          <ExtensionSlot
            name="message:bubble-actions"
            :context="{ message: line, text: line.text, speaker: line.speaker }"
            wrapper-class="vn-history-bubble-actions-slot"
          />
        </span>
      </p>
      <p v-if="story.length === 0" class="vn-history-empty">还没有对话记录，先和思隅说句话吧。</p>
    </div>
    <template #footer>
      上下滚动回溯完整对话 · Esc 或点击空白处关闭
    </template>
  </AervoxDrawer>
</template>

