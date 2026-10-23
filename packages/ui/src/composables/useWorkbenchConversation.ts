import { computed, getCurrentScope, nextTick, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import type { ConversationController } from '@aervox/api-client';
import type {
  AskUserQuestionAnswerItem,
  ToolApprovalMode,
  TurnAttachmentRef,
} from '@aervox/contracts';
import { MizukiExpression } from '../live2d/model';
import { readCompanionIdentity } from '../utils/companion-identity';
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
  turnId?: string;
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

export interface StreamingDeltaBatcherOptions {
  /** Override the frame scheduler in tests or non-browser hosts. */
  schedule?: (callback: () => void) => unknown;
  /** Cancels a callback returned by `schedule`, when supported. */
  cancel?: (handle: unknown) => void;
}

/**
 * Coalesce high-frequency stream chunks into one reactive update per frame.
 *
 * A model can emit dozens of deltas between browser paints. Updating the
 * accumulated message for each chunk makes every computed consumer rescan the
 * whole response. Keeping the scheduler injectable makes the batching contract
 * deterministic in unit tests while using rAF in the browser.
 */
export function createStreamingDeltaBatcher(
  onFlush: (text: string) => void,
  options: StreamingDeltaBatcherOptions = {},
): {
  append: (text: string) => void;
  flush: () => void;
  cancel: () => void;
} {
  const hasAnimationFrame = typeof requestAnimationFrame === 'function';
  const schedule = options.schedule ?? (hasAnimationFrame
    ? (callback: () => void) => requestAnimationFrame(() => callback())
    : (callback: () => void) => setTimeout(callback, 16));
  const cancelScheduled = options.cancel ?? (options.schedule
    ? () => undefined
    : hasAnimationFrame
      ? (handle: unknown) => {
          if (typeof cancelAnimationFrame === 'function' && typeof handle === 'number') {
            cancelAnimationFrame(handle);
          }
        }
      : (handle: unknown) => {
          if (handle !== undefined && handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
        });

  let pending: string[] = [];
  let nextScheduleToken = 0;
  let scheduledToken: number | null = null;
  let scheduledHandle: unknown = null;

  const flushPending = () => {
    if (pending.length === 0) return;
    const text = pending.join('');
    pending = [];
    onFlush(text);
  };

  const runScheduledFlush = () => {
    // The token guards against a stale callback that could not be cancelled by
    // a host scheduler, and also supports schedulers that invoke synchronously.
    const token = scheduledToken;
    if (token === null) return;
    scheduledToken = null;
    scheduledHandle = null;
    flushPending();
  };

  const flush = () => {
    if (scheduledToken !== null) {
      const handle = scheduledHandle;
      scheduledToken = null;
      scheduledHandle = null;
      cancelScheduled(handle);
    }
    flushPending();
  };

  const append = (text: string) => {
    if (!text) return;
    pending.push(text);
    if (scheduledToken === null) {
      const token = ++nextScheduleToken;
      scheduledToken = token;
      let handle: unknown;
      try {
        handle = schedule(() => {
          if (scheduledToken !== token) return;
          runScheduledFlush();
        });
      } catch (error) {
        if (scheduledToken === token) scheduledToken = null;
        throw error;
      }
      // A synchronous scheduler may have already run (and cleared) this token.
      // Do not let its returned handle poison the next scheduling cycle.
      if (scheduledToken === token) scheduledHandle = handle;
    }
  };

  const cancel = () => {
    if (scheduledToken !== null) {
      const handle = scheduledHandle;
      scheduledToken = null;
      scheduledHandle = null;
      cancelScheduled(handle);
    }
    pending = [];
  };

  return { append, flush, cancel };
}

export function useWorkbenchConversation(options: {
  recordActivity: (source: 'aervox.activity' | 'aervox.operation', eventType: string, payloadText?: string, metadata?: Record<string, unknown>) => void;
  onRefreshProactiveStatus?: () => Promise<void>;
  controller: ConversationController;
  onApprovalDecision: (decision: 'granted' | 'denied') => Promise<void>;
  onRetrySubmission?: () => Promise<void>;
}) {
  const turnState = shallowRef(options.controller.state);
  const unsubscribe = options.controller.subscribe(state => { turnState.value = state; });
  if (getCurrentScope()) onScopeDispose(() => unsubscribe());
  const retryAvailable = computed(() => turnState.value?.retryAvailable ?? false);
  const retryLabel = computed(() => turnState.value.status === 'observer-error' ? '恢复接收回复' : '重试发送');
  const retrySubmission = () => options.onRetrySubmission?.();
  // CR-065：问候语用陪伴角色名（思隅是空间名，不是角色名）
  const companionGreeting = () => {
    const { companionName, userAddress } = readCompanionIdentity();
    return `你好${userAddress === '你' ? '' : '，' + userAddress}，我是${companionName}。告诉我你想做的事，或者聊聊今天的安排，我们一起拆成下一步。`;
  };
  let nextStoryId = 2;
  const story = ref<StoryLine[]>([
    {
      id: 1,
      speaker: 'assistant',
      text: companionGreeting(),
      state: 'complete',
    },
  ]);

  const streaming = ref(false);
  const consoleCollapsed = ref(false);
  const novelIndex = ref(0);

  const storyViewport = ref<HTMLElement | null>(null);
  const historyViewport = ref<HTMLElement | null>(null);

  // UQ-01: 挂起向用户提问数据与提交状态
  const activeQuestion = computed(() => turnState.value.question ?? null);
  const questionSubmitting = ref(false);
  const currentTurnId = computed(() => turnState.value.turnId ?? null);

  // PET-05: 写工具审批待决
  const pendingApproval = computed(() => turnState.value.approval ?? null);
  const approvalBusy = ref(false);
  const approvalToolLabels: Record<string, string> = {
    aervox_diary_write: '把今天的日记写进日记本',
    aervox_memory_store: '保存一条长期记忆',
  };
  const approvalToolLabel = computed(() => {
    const name = pendingApproval.value?.toolName ?? '';
    return approvalToolLabels[name] ?? `执行工具 ${name}`;
  });

  // 权限与访问模式
  const toolApprovalMode = ref<ToolApprovalMode>('ask');
  const fullAccessDialogOpen = ref(false);
  const fullAccessAcknowledged = ref(false);

  function createStoryLine(speaker: Speaker, text: string, state: StoryLine['state'] = 'complete'): StoryLine {
    return { id: nextStoryId++, speaker, text, state };
  }

  function resetStory(greeting?: string) {
    options.controller.reset();
    nextStoryId = 2;
    story.value = [
      {
        id: 1,
        speaker: 'assistant',
        text: greeting || companionGreeting(),
        state: 'complete',
      },
    ];
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

  async function handleApprovalDecision(decision: 'granted' | 'denied') {
    const pending = pendingApproval.value;
    if (!pending || approvalBusy.value || streaming.value) return;
    approvalBusy.value = true;
    try {
      await options.onApprovalDecision(decision);
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
      await options.controller.answer(answers);
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
    turnState, retryAvailable, retryLabel, retrySubmission,
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
    resetStory,
    scrollStoryToBottom,
    showNextSentence,
    handleApprovalDecision,
    handleQuestionSubmit,
    saveToolApprovalMode,
    toggleToolApprovalMode,
    enableFullAccess,
    resetFullAccessConfirmation,
  };
}

export type WorkbenchConversationComposable = ReturnType<typeof useWorkbenchConversation>;
