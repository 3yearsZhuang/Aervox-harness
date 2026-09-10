import { nextTick, ref, type Ref } from 'vue';
import { useAervoxVoiceInput, uploadAervoxAttachment } from '@aervox/api-client';
import {
  allowedMediaTypesSchema,
  MAX_ATTACHMENT_SIZE,
  type AttachmentPurpose,
  type TurnAttachmentRef,
} from '@aervox/contracts';
import { MizukiExpression } from '../live2d/model';
import { petReactKind } from '../live2d/petReactions';

export interface PendingAttachment {
  key: string;
  file: File;
  name: string;
  mediaType: string;
  size: number;
  previewUrl?: string;
}

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  weba: 'audio/webm',
};

const ALLOWED_MEDIA_TYPES = allowedMediaTypesSchema.options as readonly string[];
export const attachmentAccept = [...ALLOWED_MEDIA_TYPES, ...Object.keys(EXTENSION_MEDIA_TYPES).map((ext) => `.${ext}`)].join(',');

export function resolveMediaType(file: File): string | null {
  const type = file.type || EXTENSION_MEDIA_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] || '';
  return ALLOWED_MEDIA_TYPES.includes(type) ? type : null;
}

export function purposeForMediaType(mediaType: string): AttachmentPurpose {
  if (mediaType.startsWith('image/')) return 'question';
  if (mediaType === 'application/pdf') return 'reading';
  if (mediaType.startsWith('audio/')) return 'audio';
  return 'file';
}

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function useWorkbenchComposer(options: {
  onSendMessage: (value?: string) => Promise<void>;
  streaming: Ref<boolean>;
  fullAccessDialogOpen: Ref<boolean>;
  enterToSend?: Ref<boolean>;
}) {
  const input = ref('');
  const isComposing = ref(false);
  const enterToSend = options.enterToSend ?? ref(true);
  const composerOpen = ref(false);
  const composerPlaceholder = '和思隅聊聊学习或任何事…';
  const composerTextarea = ref<HTMLTextAreaElement | null>(null);
  const attachmentFileInput = ref<HTMLInputElement | null>(null);

  const pendingAttachments = ref<PendingAttachment[]>([]);
  const attachmentError = ref<string | null>(null);
  const attachmentUploading = ref(false);

  const voiceInput = useAervoxVoiceInput();
  const voiceInputError = ref<string | null>(null);

  function expandComposer() {
    composerOpen.value = true;
    petReactKind('tilthead', { lookAtEl: '.composer-dock' });
    void nextTick(() => composerTextarea.value?.focus());
  }

  function collapseComposer() {
    if (voiceInput.isListening.value) {
      voiceInput.stopListening();
    }
    composerOpen.value = false;
  }

  function handleDockFocusOut(event: FocusEvent) {
    if (!composerOpen.value || isComposing.value) return;
    if (options.fullAccessDialogOpen.value) return;
    if (input.value.trim() || voiceInput.isListening.value) return;
    const dock = event.currentTarget as HTMLElement;
    const next = event.relatedTarget as Node | null;
    if (next && dock.contains(next)) return;

    window.setTimeout(() => {
      if (!composerOpen.value || isComposing.value) return;
      if (options.fullAccessDialogOpen.value) return;
      if (input.value.trim() || voiceInput.isListening.value) return;
      if (dock.contains(document.activeElement)) return;
      composerOpen.value = false;
    }, 160);
  }

  function triggerAttachmentPicker() {
    attachmentFileInput.value?.click();
    petReactKind('tilthead', { lookAtEl: '.composer-dock', lookDuration: 2000 });
  }

  function handleFilesChosen(event: Event) {
    const fileInputEl = event.target as HTMLInputElement;
    const files = Array.from(fileInputEl.files ?? []);
    fileInputEl.value = '';
    attachmentError.value = null;

    for (const file of files) {
      if (pendingAttachments.value.length >= 10) {
        attachmentError.value = '一次最多携带 10 个附件。';
        break;
      }
      const mediaType = resolveMediaType(file);
      if (!mediaType) {
        attachmentError.value = `「${file.name}」的类型暂不支持（支持图片 / PDF / 文档 / 音频）。`;
        continue;
      }
      if (file.size > MAX_ATTACHMENT_SIZE) {
        attachmentError.value = `「${file.name}」超过 10MB 上限。`;
        continue;
      }
      pendingAttachments.value.push({
        key: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        file,
        name: file.name,
        mediaType,
        size: file.size,
        previewUrl: mediaType.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      });
    }
    if (pendingAttachments.value.length > 0) {
      petReactKind('glad', {
        expression: MizukiExpression.face_notice_01,
        lookAtEl: '.composer-attachments',
        lookDuration: 2600,
      });
    }
  }

  function removePendingAttachment(key: string) {
    const index = pendingAttachments.value.findIndex((item) => item.key === key);
    if (index < 0) return;
    const [removed] = pendingAttachments.value.splice(index, 1);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    petReactKind('shake', { lookAtEl: '.composer-dock' });
  }

  async function uploadPendingAttachments(): Promise<TurnAttachmentRef[]> {
    const refs: TurnAttachmentRef[] = [];
    for (const item of pendingAttachments.value) {
      const uploaded = await uploadAervoxAttachment({
        file: item.file,
        name: item.name,
        mediaType: item.mediaType,
        purpose: purposeForMediaType(item.mediaType),
      });
      refs.push({ attachmentId: uploaded.id, name: item.name, mediaType: item.mediaType });
    }
    return refs;
  }

  function clearPendingAttachments() {
    for (const item of pendingAttachments.value) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    pendingAttachments.value = [];
  }

  function insertTranscribedText(text: string) {
    if (!text) return;
    const textarea = composerTextarea.value;
    if (!textarea) {
      input.value += (input.value ? ' ' : '') + text;
      return;
    }

    const start = textarea.selectionStart ?? input.value.length;
    const end = textarea.selectionEnd ?? input.value.length;
    const before = input.value.substring(0, start);
    const after = input.value.substring(end);

    input.value = before + (before && !before.endsWith(' ') ? ' ' : '') + text + after;
    nextTick(() => {
      const newPos = start + text.length + (before && !before.endsWith(' ') ? 1 : 0);
      textarea.focus();
      textarea.setSelectionRange(newPos, newPos);
    });
  }

  async function toggleVoiceInput() {
    voiceInputError.value = null;
    if (voiceInput.isListening.value) {
      voiceInput.stopListening();
      return;
    }

    try {
      const config = await voiceInput.getInputConfig();
      await voiceInput.startListening({
        silenceThresholdMs: config.vadSilenceThresholdMs,
        onText: (text) => {
          insertTranscribedText(text);
        },
        onError: (err) => {
          voiceInputError.value = err.message;
        },
      });
    } catch (err) {
      voiceInputError.value = err instanceof Error ? err.message : '启动语音输入失败';
    }
  }

  function handleComposerEnter(event: KeyboardEvent) {
    if (event.isComposing || isComposing.value) return;
    if (voiceInput.isListening.value) {
      voiceInput.stopListening();
    }
    if (event.shiftKey || !enterToSend.value) return;
    event.preventDefault();
    void options.onSendMessage();
  }

  function handleCompositionStart() {
    isComposing.value = true;
    handleComposerInputOrKey();
  }

  function handleCompositionEnd() {
    isComposing.value = false;
  }

  function handleComposerInputOrKey() {
    if (voiceInput.isListening.value) {
      voiceInput.stopListening();
    }
  }

  return {
    input,
    isComposing,
    enterToSend,
    composerOpen,
    composerPlaceholder,
    composerTextarea,
    attachmentFileInput,
    pendingAttachments,
    attachmentError,
    attachmentAccept,
    attachmentUploading,
    voiceInput,
    voiceInputError,
    expandComposer,
    collapseComposer,
    handleDockFocusOut,
    triggerAttachmentPicker,
    handleFilesChosen,
    removePendingAttachment,
    uploadPendingAttachments,
    clearPendingAttachments,
    toggleVoiceInput,
    handleComposerEnter,
    handleCompositionStart,
    handleCompositionEnd,
    handleComposerInputOrKey,
  };
}

export type WorkbenchComposerComposable = ReturnType<typeof useWorkbenchComposer>;
