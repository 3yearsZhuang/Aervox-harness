<script setup lang="ts">
import { computed } from 'vue';
import {
  AlertTriangle,
  BrainCircuit,
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
  (e: 'send', text?: string, options?: { quizMode?: boolean; resend?: boolean }): void;
  (e: 'voice-trigger'): void;
  (e: 'attachment-picker'): void;
}>();

const { layout, composer, conversation, proactive, sendMessage } = useWorkbenchContext();
const { isWeb, studyModeEnabled, enterToSend, openSettingsCategory } = layout;
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
  handleDockFocusOut,
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
  <section class="composer-dock" :class="{ open: composerOpen }" @focusout="handleDockFocusOut">
    <button v-if="!composerOpen" class="composer-collapsed" type="button" @click="expandComposer">
      <MessageCircle :size="16" />
      <span class="composer-collapsed-hint">
        {{
          streaming
            ? '思隅正在回应…'
            : studyModeEnabled
              ? '输入学习问题或卡点（专注模式已开启）…'
              : '点击输入消息…'
        }}
      </span>
      <span v-if="studyModeEnabled" class="composer-mode-chip">专注模式</span>
      <span class="composer-access-chip" :class="{ full: toolApprovalMode === 'full_access', proactive: proactiveActive }">
        <component :is="accessChipIcon" :size="12" />
        {{ accessChipLabel }}
      </span>
      <ChevronUp :size="15" />
    </button>

    <form v-else class="composer-expanded" @submit.prevent="onFormSubmit">
      <label class="sr-only" for="aervox-composer">输入要发送给思隅的内容</label>
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
        rows="3"
        :placeholder="studyModeEnabled ? '输入学习问题或卡点（专注模式已开启，将引导探索而非直接给答案）…' : composerPlaceholder"
        :disabled="streaming"
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
      <div class="composer-footer">
        <div class="composer-ops">
          <button
            class="composer-op-btn composer-access-btn"
            type="button"
            :title="toolApprovalMode === 'full_access' ? '当前已开启完全访问（点击切换）' : '当前处于普通授权模式（点击开启完全访问）'"
            :class="{ active: toolApprovalMode === 'full_access', full: toolApprovalMode === 'full_access' }"
            :aria-pressed="toolApprovalMode === 'full_access'"
            :disabled="streaming"
            @click="toggleToolApprovalMode"
          >
            <component :is="accessChipIcon" :size="15" />
            <span>{{ accessChipLabel }}</span>
          </button>
          <button
            v-if="!isWeb"
            class="composer-op-btn composer-proactive-btn"
            type="button"
            :title="proactiveActive ? '主动智能模式已生效（点击管理）' : '开启全量本地画像与主动智能模式'"
            :class="{ active: proactiveActive }"
            :aria-pressed="proactiveActive"
            @click="openSettingsCategory('proactive')"
          >
            <BrainCircuit :size="15" />
            <span>{{ proactiveActive ? '主动智能生效中' : '主动智能模式' }}</span>
          </button>
          <button
            class="composer-op-btn composer-attachment-btn"
            type="button"
            title="上传附件（图片 / PDF / 文档 / 音频，单文件 ≤10MB）"
            :class="{ uploading: attachmentUploading }"
            :disabled="streaming || attachmentUploading || pendingAttachments.length >= 10"
            @click="handleAttachmentTrigger"
          >
            <Paperclip :size="15" />
            <span>{{ attachmentUploading ? '上传中…' : '附件' }}</span>
            <span v-if="pendingAttachments.length > 0" class="composer-op-count">{{ pendingAttachments.length }}</span>
          </button>
          <button
            class="composer-op-btn composer-voice-btn"
            type="button"
            :title="voiceInput.isListening.value ? '点击停止语音输入' : '语音输入（点击开始录音）'"
            :class="{ active: voiceInput.isListening.value, recording: voiceInput.isListening.value }"
            :aria-pressed="voiceInput.isListening.value"
            :disabled="streaming"
            @click="handleVoiceTrigger"
          >
            <Mic v-if="!voiceInput.isListening.value" :size="15" />
            <MicOff v-else :size="15" />
            <span>{{ voiceInput.isListening.value ? '录音中…' : '语音' }}</span>
          </button>
          <ExtensionSlot name="composer:toolbar-actions" />
        </div>
        <div class="composer-actions">
          <span class="composer-shortcut-hint">{{ enterToSend ? 'Enter 发送 · Shift+Enter 换行' : '点击发送或使用快捷键' }}</span>
          <button
            class="composer-send"
            type="submit"
            :disabled="(!input.trim() && pendingAttachments.length === 0) || streaming || attachmentUploading"
            :aria-label="streaming ? '思隅正在回应' : (attachmentUploading ? '正在上传附件' : '发送消息')"
          >
            <Send :size="15" />
            <span>{{ streaming ? '回应中…' : (attachmentUploading ? '上传中…' : '发送') }}</span>
          </button>
        </div>
      </div>
      <ExtensionSlot name="composer:bottom-bar" />
    </form>
  </section>
</template>
