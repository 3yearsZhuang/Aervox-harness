import { AervoxHttpError } from '@aervox/api-client';
import type { UserQuestionRequiredEventData } from '@aervox/contracts';

export type QuestionSubmissionIssue =
  | { kind: 'retryable'; message: '暂时无法确认提交结果，请再试一次。' }
  | { kind: 'closed'; message: '问题已结束，无法继续作答。' }
  | { kind: 'unavailable'; message: '旧问题无法继续作答。' };

/** Render only fixed feedback; transport diagnostics never become card copy. */
export function getQuestionSubmissionIssue(error: unknown): QuestionSubmissionIssue {
  if (error instanceof AervoxHttpError) {
    // The /v1 HTTP route retains its machine code in the legacy `error` field.
    // Prefer specific codes and inspect that field only for generic 409 envelopes.
    const code = error.status === 409 && (error.code === 'HTTP_409' || error.code === undefined)
      ? error.problem?.error : error.code;
    switch (code) {
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
  // Persisted legacy fields can be absent; never fabricate a runnable identity.
  if (typeof data.turnId === 'string' && data.turnId.length > 0
    && 'attemptId' in data && typeof data.attemptId === 'string' && data.attemptId.length > 0
    && 'invocationId' in data && typeof data.invocationId === 'string' && data.invocationId.length > 0
    && typeof data.step === 'number' && Number.isSafeInteger(data.step) && data.step > 0) {
    return [data.turnId, data.attemptId, data.invocationId, data.step];
  }
}

export function hasOriginalQuestionIdentity(data: UserQuestionRequiredEventData | undefined): boolean {
  return !!data && originalIdentity(data) !== undefined;
}

/** Matching a legacy object scopes feedback; it does not grant permission to answer. */
export function isSameOriginalQuestion(
  left: UserQuestionRequiredEventData | undefined,
  right: UserQuestionRequiredEventData | undefined,
): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftIdentity = originalIdentity(left), rightIdentity = originalIdentity(right);
  return !!leftIdentity && !!rightIdentity && leftIdentity.every((value, index) => value === rightIdentity[index]);
}
