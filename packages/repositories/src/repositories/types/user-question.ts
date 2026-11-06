/**
 * Aervox｜思隅 @aervox/repositories — user-question 仓储类型（自 types.ts 机械拆分）
 */
import type { PendingUserQuestionModel, PendingUserQuestionUpsertInput } from "./subagent-run.js";
import type { LocalContext } from "../../local-context.js";
import type { AskUserQuestionItem, AskUserQuestionAnswerItem } from "@aervox/contracts";
import type { TurnStreamEventModel } from "./conversation.js";

export interface UserQuestionIdentity {
  turnId: string;
  attemptId: string;
  invocationId: string;
  step: number;
}

export interface UserQuestionExecutionProof {
  expectedFencingToken: number;
  leaseId: string;
}

export interface RequireUserQuestionInput extends UserQuestionIdentity, UserQuestionExecutionProof {
  questions: AskUserQuestionItem[];
  timeoutMs: number;
}

export interface PendingUserQuestionState extends PendingUserQuestionModel {
  questions: AskUserQuestionItem[];
  identityStatus: "available" | "identity_unavailable";
}

export interface UserQuestionAnswerReceipt extends UserQuestionIdentity {
  accepted: true;
  answers: AskUserQuestionAnswerItem[];
  event: TurnStreamEventModel;
}

export interface RequireUserQuestionResult {
  event: TurnStreamEventModel;
  pending: PendingUserQuestionState | null;
  receipt: UserQuestionAnswerReceipt | null;
}

export interface CancelUserQuestionInput {
  turnId: string;
  attemptId: string;
  invocationId: string | null;
  step: number;
  reason: "cancelled" | "expired";
  /** An execution owner supplies its original proof. Human cancellation need not impersonate an owner. */
  proof?: UserQuestionExecutionProof;
}

export interface IUserQuestionRepository {
  /** 幂等写入挂起会话（同 turnId 覆盖）；供提问时调用 */
  upsertPending(ctx: LocalContext, input: PendingUserQuestionUpsertInput): Promise<void>;
  /** 按 turn 查询本地挂起会话；无则 null */
  getPending(ctx: LocalContext, turnId: string): Promise<PendingUserQuestionModel | null>;
  /** 会话完成/超时后按 turnId 清除 */
  deletePending(ctx: LocalContext, turnId: string): Promise<void>;
}

export interface LearningGoalModel {
  id: string;
  topic: string;
  level: string;
  availableMinutes: number;
  status: string;
  idempotencyKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionModel {
  id: string;
  sourceArtifactId?: string | null;
  knowledgeId?: string | null;
  prompt: string;
  answerSpec: unknown;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionAttemptModel {
  id: string;
  sessionId: string;
  questionId: string;
  answer: string;
  judgement: string;
  evidence?: unknown;
  idempotencyKey?: string | null;
  hintCount: number;
  timeSpentSec?: number | null;
  createdAt: string;
}

export interface MistakeItemModel {
  questionId: string;
  knowledgeId?: string | null;
  prompt: string;
  latestAnswer: string;
  latestAttemptAt: string;
  wrongCount: number;
  masteryState: string;
  status: "active" | "mastered" | "dismissed";
  reasonCode?: "concept_gap" | "calculation" | "careless" | "misread" | "other" | null;
  note?: string | null;
}

export interface PracticeSessionModel {
  id: string;
  questionCount: number;
  questionIds: string[];
  status: string;
  startedAt: string;
  endedAt?: string | null;
}

export interface KnowledgeItemModel {
  id: string;
  concept: string;
  sourceStatus: string;
  masteryState: string;
  correctCount: number;
  wrongCount: number;
  correctStreak: number;
  mastery: number;
  masteryBasis?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewItemModel {
  id: string;
  knowledgeId: string;
  dueAt: string;
  intervalDays: number;
  schedulerVersion: number;
  timezoneSnapshot: string;
  status: string;
  completionIsCorrect?: boolean | null;
  nextReviewId?: string | null;
  createdAt: string;
  updatedAt: string;
}
