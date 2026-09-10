/**
 * Aervox｜思隅 @aervox/repositories — user-question 仓储类型（自 types.ts 机械拆分）
 */
import type { PendingUserQuestionModel, PendingUserQuestionUpsertInput } from "./subagent-run.js";
import type { LocalContext } from "../../local-context.js";

export interface IUserQuestionRepository {
  /** 幂等写入挂起会话（同 turnId 覆盖）；供提问时调用 */
  upsertPending(tenant: LocalContext, input: PendingUserQuestionUpsertInput): Promise<void>;
  /** 按 turn 查询挂起会话（租户隔离）；无则 null */
  getPending(tenant: LocalContext, turnId: string): Promise<PendingUserQuestionModel | null>;
  /** 会话完成/超时后清除（租户隔离；仅删除属于本租户的行） */
  deletePending(tenant: LocalContext, turnId: string): Promise<void>;
}

export interface LearningGoalModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
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
  workspaceId: string;
  subjectUserId: string;
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
  workspaceId: string;
  subjectUserId: string;
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
  workspaceId: string;
  subjectUserId: string;
  questionCount: number;
  questionIds: string[];
  status: string;
  startedAt: string;
  endedAt?: string | null;
}

export interface KnowledgeItemModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
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
  workspaceId: string;
  subjectUserId: string;
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
