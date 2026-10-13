<script setup lang="ts">
import { AervoxButton, AervoxCard } from '../../primitives';
import { computed, nextTick, watch } from 'vue';
import {
  AlertTriangle,
  BrainCircuit,
  ChevronDown,
  ChevronUp,
  MessageCircle,
  Mic,
  MicOff,
  Paperclip,
  Send,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-vue-next';
import ExtensionSlot from '../extension/ExtensionSlot.vue';
import ComposerAttachments from './ComposerAttachments.vue';
import type { ComposerContractProps } from '../../registry/types';
import { useWorkbenchContext } from '../../composables/workbench-context';

const props = defineProps<Partial<ComposerContractProps>>();

const emit = defineEmits<{
  (e: 'update:input', value: string): void;
  (e: 'send', text?: string, options?: { metadata?: Record<string, unknown>; resend?: boolean }): void;
  (e: 'voice-trigger'): void;
  (e: 'attachment-picker'): void;
}>();

const { layout, composer, conversation, proactive, sendMessage } = useWorkbenchContext();
const { isWeb, enterToSend, openSettingsCategory } = layout;
const standardMode = computed(() => layout.workbenchMode.value === 'standard');
const {
  input,
  composerOpen,
  composerPlaceholder,
  composerTextarea,
  attachmentFileInput,
  pendingAttachments,
  attachmentError,
  attachmentUploading,
  attachmentAccept,
  voiceInput,
  voiceInputError,
  expandComposer,
  collapseComposer,
  triggerAttachmentPicker,
  handleFilesChosen,
  toggleVoiceInput,
  handleComposerEnter,
  handleCompositionStart,
  handleCompositionEnd,
  handleComposerInputOrKey,
} = composer;
const { streaming, toolApprovalMode, toggleToolApprovalMode } = conversation;
const { proactiveActive } = proactive;
watch([input, standardMode], async () => {
  await nextTick();
  const textarea = composerTextarea.value;
  if (textarea) {
    textarea.style.height = '32px';
    textarea.style.height = `${Math.min(160, Math.max(32, textarea.scrollHeight))}px`;
  }
}, { immediate: true });

const accessChipLabel = computed(() =>
  proactiveActive.value
    ? '主动智能模式'
    : toolApprovalMode.value === 'full_access'
      ? '完全访问'
      : '操作需确认',
);

const accessChipIcon = computed(() =>
  proactiveActive.value
    ? BrainCircuit
    : toolApprovalMode.value === 'full_access'
      ? ShieldAlert
      : ShieldCheck,
);

function onFormSubmit() {
  if (props.onSend) {
    void props.onSend(input.value);
  } else {
    emit('send', input.value);
    void sendMessage();
  }
}

function handleAttachmentTrigger() {
  if (props.onAttachmentPicker) {
    props.onAttachmentPicker();
  } else {
    emit('attachment-picker');
    triggerAttachmentPicker();
  }
}

function handleVoiceTrigger() {
  if (props.onVoiceTrigger) {
    props.onVoiceTrigger();
  } else {
    emit('voice-trigger');
    toggleVoiceInput();
  }
}
</script>

<template>
  <AervoxCard as="section" class="composer-dock companion-panel" :class="{ open: composerOpen || standardMode, 'has-draft': input.trim() || pendingAttachments.length }" aria-label="消息输入">
    <button v-if="!composerOpen && !standardMode" class="composer-collapsed" type="button" @click="expandComposer">
      <MessageCircle :size="16" />
      <span class="composer-collapsed-hint">
        {{
          streaming ? '思隅正在回应…' : composerPlaceholder
        }}
      </span>
      <!-- CR-060：模式标记由插件经通用插槽渲染，宿主不内建插件文案与样式 -->
      <ExtensionSlot name="composer:indicator" />
      <span class="composer-access-chip" :class="{ full: toolApprovalMode === 'full_access', proactive: proactiveActive }">
        <component :is="accessChipIcon" :size="12" />
        {{ accessChipLabel }}
      </span>
      <ChevronUp :size="15" />
    </button>

    <form v-else class="composer-expanded" @submit.prevent="onFormSubmit">
      <header v-if="!standardMode" class="companion-panel-head">
        <MessageCircle class="companion-panel-icon" :size="18" aria-hidden="true" />
        <label class="companion-panel-title" for="aervox-composer">发消息</label>
        <AervoxButton variant="ghost" icon-only
          class="companion-panel-action"
          type="button"
          aria-label="收起输入框"
          title="收起输入框"
          @click="collapseComposer"
        >
          <ChevronDown :size="16" />
        </AervoxButton>
      </header>
      <label v-else class="sr-only" for="aervox-composer">输入要发送给思隅的内容</label>
      <input
        ref="attachmentFileInput"
        type="file"
        class="sr-only"
        multiple
        :accept="attachmentAccept"
        aria-label="选择要上传的附件（图片 / PDF / 文档 / 音频）"
        @change="handleFilesChosen"
      />
      <ComposerAttachments />
      <textarea
        id="aervox-composer"
        ref="composerTextarea"
        v-model="input"
        aria-label="输入要发送给思隅的内容"
        rows="1"
        :placeholder="standardMode ? '发送消息' : composerPlaceholder"
        :disabled="attachmentUploading"
        @keydown.enter="handleComposerEnter"
        @input="handleComposerInputOrKey"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
      />
      <div v-if="attachmentError" class="composer-error-banner" role="alert">
        <AlertTriangle :size="13" />
        <span>{{ attachmentError }}</span>
      </div>
      <div v-if="voiceInputError" class="composer-error-banner" role="alert">
        <AlertTriangle :size="13" />
        <span>{{ voiceInputError }}</span>
      </div>
      <p v-if="streaming || attachmentUploading" class="composer-status" role="status">
        <span class="composer-status-dot" aria-hidden="true" />
        {{ attachmentUploading ? '正在上传附件…' : '正在回复，你可以先写下一条消息' }}
      </p>
      <div class="composer-footer companion-panel-footer">
        <div class="composer-ops">
          <AervoxButton variant="ghost"
            class="composer-op-btn composer-access-btn"
            :icon="accessChipIcon"
            type="button"
            :title="toolApprovalMode === 'full_access' ? '当前已开启完全访问（点击切换）' : '当前处于普通授权模式（点击开启完全访问）'"
            :class="{ active: toolApprovalMode === 'full_access', full: toolApprovalMode === 'full_access' }"
            :aria-pressed="toolApprovalMode === 'full_access'"
            :disabled="streaming"
            @click="toggleToolApprovalMode"
          >
            <span>{{ accessChipLabel }}</span>
          </AervoxButton>
          <AervoxButton variant="ghost"
            v-if="!isWeb"
            class="composer-op-btn composer-proactive-btn"
            :icon="BrainCircuit"
            type="button"
            :title="proactiveActive ? '主动智能模式已生效（点击管理）' : '开启全量本地画像与主动智能模式'"
            :class="{ active: proactiveActive }"
            :aria-pressed="proactiveActive"
            @click="openSettingsCategory('proactive')"
          >
            <span>{{ proactiveActive ? '主动智能生效中' : '主动智能模式' }}</span>
          </AervoxButton>
          <AervoxButton variant="ghost"
            class="composer-op-btn composer-attachment-btn"
            :icon="Paperclip"
            icon-only
            aria-label="添加附件"
            type="button"
            title="上传附件（图片 / PDF / 文档 / 音频，单文件 ≤10MB）"
            :class="{ uploading: attachmentUploading }"
            :disabled="streaming || attachmentUploading || pendingAttachments.length >= 10"
            @click="handleAttachmentTrigger"
          >
            <span v-if="pendingAttachments.length > 0" class="composer-op-count">{{ pendingAttachments.length }}</span>
          </AervoxButton>
          <AervoxButton variant="ghost"
            class="composer-op-btn composer-voice-btn"
            :icon="voiceInput.isListening.value ? MicOff : Mic"
            icon-only
            :aria-label="voiceInput.isListening.value ? '停止语音输入' : '语音输入'"
            type="button"
            :title="voiceInput.isListening.value ? '点击停止语音输入' : '语音输入（点击开始录音）'"
            :class="{ active: voiceInput.isListening.value, recording: voiceInput.isListening.value }"
            :aria-pressed="voiceInput.isListening.value"
            :disabled="streaming"
            @click="handleVoiceTrigger"
          />
          <ExtensionSlot name="composer:toolbar-actions" />
        </div>
        <div class="composer-actions">
          <span class="composer-shortcut-hint">{{ enterToSend ? 'Enter 发送 · Shift+Enter 换行' : '点击发送或使用快捷键' }}</span>
          <AervoxButton variant="ghost"
            class="composer-send"
            :icon="Send"
            icon-only
            type="submit"
            :disabled="(!input.trim() && pendingAttachments.length === 0) || streaming || attachmentUploading"
            :aria-label="streaming ? '思隅正在回应' : (attachmentUploading ? '正在上传附件' : '发送消息')"
          />
        </div>
      </div>
      <ExtensionSlot name="composer:bottom-bar" />
    </form>
  </AervoxCard>
</template>
