/**
 * Aervox｜思隅 @aervox/api — 刷题模式作答落库端口（CAP-016 刷题闭环，ADR-021 修订：
 * 伴学域契约与实现回归插件宿主，内核不再持有）
 *
 * 将 PracticeAttemptPort 适配到 SqliteLearningRepository：
 * - createQuestion：题干 + answerSpec（标准答案/题型/解析）落 questions 表；
 * - recordAttempt：用户回答 + AI 判定落 question_attempts 表（sessionId = 触发刷题的 Turn，天然可追溯）；
 * - judgement = incorrect 的作答由 listMistakes 派生逻辑自动进入错题本，无需额外写入。
 *
 * 注：MVP 不联动 knowledge_items / review_items（知识点归一与 CAP-016 复习调度走既有 REST
 * 作答路由逻辑）；错题本派生不依赖 knowledgeId，可正常工作。
 */
import type { SqliteLearningRepository, LocalContext } from "@aervox/repositories";

/** 刷题模式下一次作答的落库请求（AI 判定后委托宿主持久化） */
export interface PracticeAttemptPortRequest {
  turnId: string;
  /** 题干 */
  prompt: string;
  /** 题型：choice | short_answer | fill_blank（展示用） */
  questionType?: string;
  /** 用户原始回答 */
  userAnswer: string;
  /** 标准答案 */
  correctAnswer: string;
  judgement: "correct" | "incorrect" | "partial";
  /** 解析（答错时的纠正说明） */
  explanation?: string;
  /** 可选知识点概念描述 */
  knowledgeConcept?: string;
}

export interface PracticeAttemptPortResult {
  questionId: string;
  attemptId: string;
  judgement: "correct" | "incorrect" | "partial";
  /** judgement === "incorrect" 时进入错题本 */
  enteredMistakeNotebook: boolean;
}

/** 宿主实现的刷题作答落库端口（写 questions + question_attempts） */
export interface PracticeAttemptPort {
  recordAttempt(request: PracticeAttemptPortRequest): Promise<PracticeAttemptPortResult>;
}

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function createPracticeAttemptPortFactory(
  learningRepo: SqliteLearningRepository,
): (tenant: LocalContext) => PracticeAttemptPort {
  return (tenant: LocalContext) => ({
    recordAttempt: async (req: PracticeAttemptPortRequest) => {
      const question = await learningRepo.createQuestion(tenant, {
        id: id("q"),
        prompt: req.prompt,
        answerSpec: {
          answer: req.correctAnswer,
          type: req.questionType ?? null,
          explanation: req.explanation ?? null,
        },
        knowledgeId: null,
      });

      const attempt = await learningRepo.recordAttempt(tenant, {
        id: id("att"),
        sessionId: req.turnId,
        questionId: question.id,
        answer: req.userAnswer,
        judgement: req.judgement,
        evidence: {
          source: "quiz-mode",
          turnId: req.turnId,
          explanation: req.explanation ?? null,
          knowledgeConcept: req.knowledgeConcept ?? null,
        },
      });

      return {
        questionId: question.id,
        attemptId: attempt.id,
        judgement: req.judgement,
        enteredMistakeNotebook: req.judgement === "incorrect",
      };
    },
  });
}
