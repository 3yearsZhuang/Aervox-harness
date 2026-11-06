/** Phone adapter to the shared durable commands and process-local waiter. */
import type { AskUserQuestionAnswerItem, UserQuestionRequiredEventData } from '@aervox/contracts';
import { UserQuestionWaiter, type UserQuestionCommands, type QuestionExecutionOwner } from '@aervox/host-agent/browser';
import type { AskUserQuestionPortRequest, UserQuestionPort } from '@aervox/core/browser';
import type { QuestionAnswerIdentity } from '@aervox/api-client';

export interface QuestionBridge {
  port: UserQuestionPort;
  observe(turnId: string, deliver: (question: UserQuestionRequiredEventData) => void): () => void;
  submit(turnId: string, answers: AskUserQuestionAnswerItem[], identity?: QuestionAnswerIdentity): Promise<void>;
  cancel(reason?: string): Promise<void>;
}
export const DEFAULT_QUESTION_TIMEOUT_MS = 120_000;
export function createQuestionBridge<Context>(options: {
  commands: UserQuestionCommands<Context>; ctx: Context;
  owner(request: AskUserQuestionPortRequest): QuestionExecutionOwner | undefined;
  timeoutMs?: number;
}): QuestionBridge {
  const waiter = new UserQuestionWaiter(options.commands, { defaultTimeoutMs: options.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS });
  return {
    port: waiter.createPort(options.ctx, options.owner),
    observe(turnId, deliver) {
      let observing = true;
      // Disclosure and deadline come from the same durable question query.
      void waiter.getPending(options.ctx, turnId).then(pending => {
        if (observing && pending) deliver({ turnId: pending.turnId, attemptId: pending.attemptId,
          invocationId: pending.invocationId, identityStatus: pending.identityStatus, step: pending.step,
          questions: pending.questions, expiresAt: pending.expiresAt,
          timeoutMs: Math.max(1, Date.parse(pending.expiresAt) - Date.now()) });
      }).catch(() => undefined);
      return () => { observing = false; };
    },
    async submit(turnId, answers, identity) {
      await waiter.submit(options.ctx, { turnId, attemptId: identity?.attemptId ?? '',
        invocationId: identity?.invocationId ?? '', step: identity?.step ?? 0 }, answers);
    },
    cancel: reason => waiter.cancel(reason),
  };
}
