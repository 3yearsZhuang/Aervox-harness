<script setup lang="ts">
import { AervoxButton, AervoxCard } from '../../primitives';
import { Check, X } from 'lucide-vue-next';
import { useWorkbenchContext } from '../../composables/workbench-context';

const { layout, conversation, sendMessage } = useWorkbenchContext();
const { assistantDisplayName } = layout;
const {
  pendingApproval,
  approvalBusy,
  approvalToolLabel,
  handleApprovalDecision,
} = conversation;

function onDecision(decision: 'granted' | 'denied') {
  void handleApprovalDecision(decision, (outgoing) => sendMessage(outgoing, { resend: true }));
}
</script>

<template>
  <AervoxCard as="div" v-if="pendingApproval" class="tool-approval-card">
    <div class="tool-approval-text">
      <strong>{{ assistantDisplayName }}请求执行写操作</strong>
      <span>{{ approvalToolLabel }} — 需要你的确认后才会执行。</span>
    </div>
    <div class="tool-approval-actions">
      <AervoxButton variant="secondary" type="button" :disabled="approvalBusy" @click="onDecision('granted')">
        <Check :size="14" /> 批准
      </AervoxButton>
      <AervoxButton variant="secondary" type="button" class="secondary" :disabled="approvalBusy" @click="onDecision('denied')">
        <X :size="14" /> 拒绝
      </AervoxButton>
    </div>
  </AervoxCard>
</template>
