import { AervoxHttpError } from '@aervox/api-client';
import type { UserQuestionRequiredEventData } from '@aervox/contracts';

export type QuestionSubmissionIssue =
  | { kind: 'retryable'; message: '暂时无法确认提交结果，请再试一次。' }
  | { kind: 'closed'; message: '问题已结束，无法继续作答。' }
  | { kind: 'unavailable'; message: '旧问题无法继续作答。' };

/** Render only fixed feedback; transport diagnostics never become card copy. */
export function getQuestionSubmissionIssue(error: unknown): QuestionSubmissionIssue {
  if (error instanceof AervoxHttpError) {
    switch (error.code) {
      case 'QUESTION_IDENTITY_UNAVAILABLE':
      case 'QUESTION_IDENTITY_REQUIRED':
      case 'QUESTION_EXECUTION_IDENTITY_REQUIRED':
      case 'QUESTION_IDENTITY_CONFLICT':
        return { kind: 'unavailable', message: '旧问题无法继续作答。' };
      case 'QUESTION_EXPIRED':
      case 'QUESTION_NOT_PENDING':
      case 'QUESTION_CANCELLED':
      case 'QUESTION_CLOSED':
      case 'QUESTION_TIMEOUT':
      case 'QUESTION_ANSWER_CONFLICT':
        return { kind: 'closed', message: '问题已结束，无法继续作答。' };
    }
  }
  return { kind: 'retryable', message: '暂时无法确认提交结果，请再试一次。' };
}

function originalIdentity(data: UserQuestionRequiredEventData): readonly [string, string, string, number] | undefined {
  // Read optional newer protocol fields without fabricating identity for v1.
  if ('attemptId' in data && typeof data.attemptId === 'string' && data.attemptId.length > 0
    && 'invocationId' in data && typeof data.invocationId === 'string' && data.invocationId.length > 0
    && typeof data.step === 'number' && Number.isSafeInteger(data.step) && data.step > 0) {
    return [data.turnId, data.attemptId, data.invocationId, data.step];
  }
}

/** A v1 request can be matched only to its exact object, never a guessed ID. */
export function isSameOriginalQuestion(
  left: UserQuestionRequiredEventData | undefined,
  right: UserQuestionRequiredEventData | undefined,
): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftIdentity = originalIdentity(left), rightIdentity = originalIdentity(right);
  return !!leftIdentity && !!rightIdentity && leftIdentity.every((value, index) => value === rightIdentity[index]);
}
