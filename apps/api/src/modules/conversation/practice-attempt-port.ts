/**
 * Aervox｜思隅 @aervox/api — 刷题模式作答落库端口实现（CAP-016 刷题闭环）
 *
 * 将 agent-loop 的 PracticeAttemptPort 适配到 SqliteLearningRepository：
 * - createQuestion：题干 + answerSpec（标准答案/题型/解析）落 questions 表；
 * - recordAttempt：用户回答 + AI 判定落 question_attempts 表（sessionId = 触发刷题的 Turn，天然可追溯）；
 * - judgement = incorrect 的作答由 listMistakes 派生逻辑自动进入错题本，无需额外写入。
 *
 * 注：MVP 不联动 knowledge_items / review_items（知识点归一与 CAP-016 复习调度走既有 REST
 * 作答路由逻辑）；错题本派生不依赖 knowledgeId，可正常工作。
 */
import type { PracticeAttemptPort, PracticeAttemptPortRequest } from "@aervox/agent-loop";
import type { SqliteLearningRepository, TenantContext } from "@aervox/database";

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function createPracticeAttemptPortFactory(
  learningRepo: SqliteLearningRepository,
): (tenant: TenantContext) => PracticeAttemptPort {
  return (tenant: TenantContext) => ({
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
