import { computed, nextTick, ref, watch, type Ref } from 'vue';
import {
  decideToolApproval,
  streamAervoxTurn,
  submitQuestionAnswers,
} from '@aervox/api-client';
import type {
  AskUserQuestionAnswerItem,
  ExtractedTerm,
  ToolApprovalMode,
  ToolApprovalRequiredEventData,
  TurnAttachmentRef,
  UserQuestionRequiredEventData,
} from '@aervox/contracts';
import { MizukiExpression } from '../live2d/model';
import { petReact, petReactKind } from '../live2d/petReactions';

export type Speaker = 'assistant' | 'user';

export interface StoryLineAttachment {
  name: string;
  mediaType: string;
  previewUrl?: string;
}

export interface StoryLine {
  id: number;
  speaker: Speaker;
  text: string;
  state?: 'streaming' | 'complete' | 'error';
  attachments?: StoryLineAttachment[];
}

export function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[。！？!?…])\s*|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function useWorkbenchConversation(options: {
  focusModeEnabled?: Ref<boolean>;
  studyModeEnabled?: Ref<boolean>;
  recordActivity: (source: 'aervox.activity' | 'aervox.operation', eventType: string, payloadText?: string, metadata?: Record<string, unknown>) => void;
  onRefreshProactiveStatus?: () => Promise<void>;
}) {
  let nextStoryId = 2;
  const story = ref<StoryLine[]>([
    {
      id: 1,
      speaker: 'assistant',
      text: '你好，我是思隅。告诉我你正在学什么，或者把卡住的地方直接发来，我们一起拆成下一步。',
      state: 'complete',
    },
  ]);

  const streaming = ref(false);
  const consoleCollapsed = ref(false);
  const novelIndex = ref(0);

  const storyViewport = ref<HTMLElement | null>(null);
  const historyViewport = ref<HTMLElement | null>(null);

  // UQ-01: 挂起向用户提问数据与提交状态
  const activeQuestion = ref<UserQuestionRequiredEventData | null>(null);
  const questionSubmitting = ref(false);
  const currentTurnId = ref<string | null>(null);

  // PET-05: 写工具审批待决
  const pendingApproval = ref<(ToolApprovalRequiredEventData & { turnId: string; outgoing: string }) | null>(null);
  const approvalBusy = ref(false);
  const approvalToolLabels: Record<string, string> = {
    aervox_diary_write: '把今天的日记写进日记本',
    aervox_memory_store: '保存一条长期记忆',
  };
  const approvalToolLabel = computed(() => {
    const name = pendingApproval.value?.toolName ?? '';
    return approvalToolLabels[name] ?? `执行工具 ${name}`;
  });

  // CAP-007 / CAP-002: 术语抽取与追问探索弹窗
  const currentExtractedTerms = ref<ExtractedTerm[]>([]);
  const exploreDialogOpen = ref(false);
  const selectedTerm = ref<ExtractedTerm | null>(null);

  // 权限与访问模式
  const toolApprovalMode = ref<ToolApprovalMode>('ask');
  const fullAccessDialogOpen = ref(false);
  const fullAccessAcknowledged = ref(false);

  function createStoryLine(speaker: Speaker, text: string, state: StoryLine['state'] = 'complete'): StoryLine {
    return { id: nextStoryId++, speaker, text, state };
  }

  let scrollRafId: ReturnType<typeof requestAnimationFrame> | ReturnType<typeof setTimeout> | null = null;

  async function scrollStoryToBottom(options?: { instant?: boolean }) {
    if (options?.instant) {
      if (scrollRafId !== null) {
        if (typeof cancelAnimationFrame !== 'undefined' && typeof scrollRafId === 'number') {
          cancelAnimationFrame(scrollRafId);
        } else if (typeof clearTimeout !== 'undefined') {
          clearTimeout(scrollRafId as any);
        }
        scrollRafId = null;
      }
      const schedule = typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 0);

      scrollRafId = schedule(() => {
        scrollRafId = null;
        if (!storyViewport.value) return;
        storyViewport.value.scrollTop = storyViewport.value.scrollHeight;
        const sentenceBody = storyViewport.value.querySelector(
          '.message-novel-text .markdown-body, .message-text > .markdown-body',
        ) as HTMLElement | null;
        if (sentenceBody) sentenceBody.scrollTop = sentenceBody.scrollHeight;
      });
      return;
    }

    await nextTick();
    storyViewport.value?.scrollTo({ top: storyViewport.value.scrollHeight, behavior: 'smooth' });
    const sentenceBody = storyViewport.value?.querySelector(
      '.message-novel-text .markdown-body, .message-text > .markdown-body',
    ) as HTMLElement | null;
    if (sentenceBody) sentenceBody.scrollTop = sentenceBody.scrollHeight;
  }

  const latestAssistantLine = computed<StoryLine | null>(() => {
    for (let i = story.value.length - 1; i >= 0; i--) {
      if (story.value[i].speaker === 'assistant') return story.value[i];
    }
    return null;
  });

  const novelSentences = computed(() => {
    const line = latestAssistantLine.value;
    return line ? splitIntoSentences(line.text) : [];
  });

  const novelStreamingText = computed(() => novelSentences.value[0] ?? '');
  const novelDisplayText = computed(() => novelSentences.value[Math.min(novelIndex.value, novelSentences.value.length - 1)] ?? '');
  const queuedSentenceCount = computed(() => Math.max(0, novelSentences.value.length - novelIndex.value - 1));
  const hasQueuedSentence = computed(() => queuedSentenceCount.value > 0);

  const collapsedSummaryText = computed(() => {
    const line = latestAssistantLine.value;
    if (!line) return '正在连接 Aervox…';
    if (line.state === 'streaming') return novelStreamingText.value || '思隅正在回应…';
    if (line.state === 'error') return line.text;
    return novelDisplayText.value || '这次没有收到可展示的回答。';
  });

  watch(latestAssistantLine, (_line, old) => {
    if (old !== undefined) novelIndex.value = 0;
  });

  function showNextSentence() {
    if (!hasQueuedSentence.value) return;
    novelIndex.value++;
    const sentence = novelSentences.value[novelIndex.value];
    if (sentence) petReact({ speak: sentence });
    void nextTick(() => {
      const sentenceBody = storyViewport.value?.querySelector('.message-novel-text .markdown-body') as HTMLElement | null;
      if (sentenceBody) sentenceBody.scrollTop = 0;
    });
  }

  function openTermExplore(term: ExtractedTerm) {
    selectedTerm.value = term;
    exploreDialogOpen.value = true;
  }

  async function handleApprovalDecision(decision: 'granted' | 'denied', onResend?: (outgoing: string) => Promise<void>) {
    const pending = pendingApproval.value;
    if (!pending || approvalBusy.value) return;
    approvalBusy.value = true;
    try {
      await decideToolApproval(pending.turnId, pending.approvalId, decision);
      pendingApproval.value = null;
      if (decision === 'granted') {
        if (onResend) {
          await onResend(pending.outgoing);
        }
      } else if (streaming.value) {
        streaming.value = false;
      }
    } catch (err) {
      console.error('提交授权决定失败', err);
    } finally {
      approvalBusy.value = false;
    }
  }

  async function handleQuestionSubmit(answers: AskUserQuestionAnswerItem[]) {
    if (!currentTurnId.value || questionSubmitting.value) return;
    questionSubmitting.value = true;
    try {
      await submitQuestionAnswers(currentTurnId.value, answers);
      activeQuestion.value = null;
    } catch (err) {
      console.error('提交回答失败', err);
    } finally {
      questionSubmitting.value = false;
    }
  }

  function saveToolApprovalMode(mode: ToolApprovalMode) {
    toolApprovalMode.value = mode;
    localStorage.setItem('aervox-tool-approval-mode', mode);
    void options.onRefreshProactiveStatus?.();
  }

  function toggleToolApprovalMode() {
    if (streaming.value) return;
    if (toolApprovalMode.value === 'full_access') {
      saveToolApprovalMode('ask');
      return;
    }
    fullAccessAcknowledged.value = false;
    fullAccessDialogOpen.value = true;
  }

  function enableFullAccess() {
    if (!fullAccessAcknowledged.value) return;
    saveToolApprovalMode('full_access');
    fullAccessDialogOpen.value = false;
  }

  function resetFullAccessConfirmation() {
    fullAccessAcknowledged.value = false;
  }

  return {
    story,
    streaming,
    consoleCollapsed,
    novelIndex,
    storyViewport,
    historyViewport,
    activeQuestion,
    questionSubmitting,
    currentTurnId,
    pendingApproval,
    approvalBusy,
    approvalToolLabel,
    currentExtractedTerms,
    exploreDialogOpen,
    selectedTerm,
    toolApprovalMode,
    fullAccessDialogOpen,
    fullAccessAcknowledged,
    latestAssistantLine,
    novelSentences,
    novelStreamingText,
    novelDisplayText,
    queuedSentenceCount,
    hasQueuedSentence,
    collapsedSummaryText,
    createStoryLine,
    scrollStoryToBottom,
    showNextSentence,
    openTermExplore,
    handleApprovalDecision,
    handleQuestionSubmit,
    saveToolApprovalMode,
    toggleToolApprovalMode,
    enableFullAccess,
    resetFullAccessConfirmation,
  };
}

export type WorkbenchConversationComposable = ReturnType<typeof useWorkbenchConversation>;
