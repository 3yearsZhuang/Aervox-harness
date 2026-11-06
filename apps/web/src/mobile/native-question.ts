/** One-question-at-a-time bridge between the agent loop and the phone UI.
 *
 * Core's `ask_user_question` tool suspends the running turn and waits for a
 * human answer. The API host resolves that wait from another HTTP request; on
 * the phone the same process owns both sides, so this bridge holds the pending
 * promise, hands the question to the observing turn as a
 * `user_question_required` event, and resolves when the user submits.
 *
 * A pending question never outlives its turn: timeout, abort and host
 * retirement all reject with a fixed code instead of leaving the loop hanging.
 */
import type { AskUserQuestionAnswerItem, UserQuestionRequiredEventData } from '@aervox/contracts';
import type { AskUserQuestionPortRequest, AskUserQuestionPortResult, UserQuestionPort } from '@aervox/core/browser';

interface Pending {
  turnId: string;
  data: UserQuestionRequiredEventData;
  expiresAt: number;
  resolve: (result: AskUserQuestionPortResult) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  detach?: () => void;
}

export interface QuestionBridge {
  port: UserQuestionPort;
  /** Attach the currently observing turn; returns a scoped unregister. */
  observe(turnId: string, deliver: (question: UserQuestionRequiredEventData) => void): () => void;
  submit(turnId: string, answers: AskUserQuestionAnswerItem[]): Promise<void>;
  cancel(reason?: string): void;
}

export const DEFAULT_QUESTION_TIMEOUT_MS = 120_000;

export function createQuestionBridge(options: { timeoutMs?: number } = {}): QuestionBridge {
  const fallbackTimeout = options.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
  let pending: Pending | undefined;
  let sink: { turnId: string; deliver: (question: UserQuestionRequiredEventData) => void } | undefined;

  const settle = () => {
    const current = pending;
    pending = undefined;
    if (current?.timer) clearTimeout(current.timer);
    current?.detach?.();
    return current;
  };
  const deliver = (data: UserQuestionRequiredEventData) => {
    if (sink && sink.turnId === data.turnId) sink.deliver(data);
  };

  const port: UserQuestionPort = {
    ask(request: AskUserQuestionPortRequest): Promise<AskUserQuestionPortResult> {
      if (pending) return Promise.reject(new Error('QUESTION_PENDING'));
      return new Promise<AskUserQuestionPortResult>((resolve, reject) => {
        const timeout = request.timeoutMs ?? fallbackTimeout;
        const data = { turnId: request.turnId, questions: request.questions, ...(request.step ? { step: request.step } : {}), timeoutMs: timeout };
        const entry: Pending = { turnId: request.turnId, data, expiresAt: Date.now() + timeout, resolve, reject };
        pending = entry;
        entry.timer = setTimeout(() => {
          if (pending !== entry) return;
          settle();
          reject(new Error('QUESTION_TIMEOUT'));
        }, timeout);
        if (request.signal) {
          const abort = () => {
            if (pending !== entry) return;
            settle();
            reject(new Error('QUESTION_CANCELLED'));
          };
          if (request.signal.aborted) { abort(); return; }
          request.signal.addEventListener('abort', abort, { once: true });
          entry.detach = () => request.signal?.removeEventListener('abort', abort);
        }
        deliver(data);
      });
    },
  };

  return {
    port,
    observe(turnId, nextSink) {
      sink = { turnId, deliver: nextSink };
      if (pending?.turnId === turnId) nextSink({ ...pending.data, timeoutMs: Math.max(0, pending.expiresAt - Date.now()) });
      return () => { if (sink?.deliver === nextSink) { sink = undefined; } };
    },
    async submit(turnId, answers) {
      const current = pending;
      // Only the turn that asked may be answered, and only once.
      if (!current || current.turnId !== turnId) throw new Error('QUESTION_NOT_PENDING');
      if (!Array.isArray(answers) || !answers.length) throw new Error('QUESTION_ANSWERS_REQUIRED');
      settle();
      current.resolve({ answers });
    },
    cancel(reason = 'QUESTION_CANCELLED') {
      const current = pending;
      if (!current) return;
      settle();
      current.reject(new Error(reason));
    },
  };
}
