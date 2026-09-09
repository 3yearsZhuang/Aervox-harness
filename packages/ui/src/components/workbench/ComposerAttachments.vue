<script setup lang="ts">
import { FileText, Image as ImageIcon, Music, X } from 'lucide-vue-next';
import { useWorkbenchContext } from '../../composables/workbench-context';
import { formatAttachmentSize } from '../../composables/useWorkbenchComposer';

const { composer, conversation } = useWorkbenchContext();
const { streaming } = conversation;
const {
  pendingAttachments,
  attachmentUploading,
  removePendingAttachment,
} = composer;

function attachmentIconFor(mediaType: string) {
  if (mediaType.startsWith('image/')) return ImageIcon;
  if (mediaType.startsWith('audio/')) return Music;
  return FileText;
}
</script>

<template>
  <div v-if="pendingAttachments.length > 0" class="composer-attachments" aria-label="待发送附件">
    <div v-for="item in pendingAttachments" :key="item.key" class="attachment-chip">
      <img v-if="item.previewUrl" :src="item.previewUrl" :alt="item.name" class="attachment-thumb" />
      <span v-else class="attachment-icon"><component :is="attachmentIconFor(item.mediaType)" :size="15" /></span>
      <span class="attachment-meta">
        <span class="attachment-name" :title="item.name">{{ item.name }}</span>
        <span class="attachment-size">{{ formatAttachmentSize(item.size) }}</span>
      </span>
      <button
        type="button"
        class="attachment-remove"
        :aria-label="`移除附件 ${item.name}`"
        :disabled="streaming || attachmentUploading"
        @click="removePendingAttachment(item.key)"
      >
        <X :size="13" />
      </button>
    </div>
  </div>
</template>
