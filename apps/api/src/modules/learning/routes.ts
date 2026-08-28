/**
 * Aervox｜思隅 @aervox/api — 学习/练习/复习域路由
 *
 * 面向用户侧：学习目标 / 题目 / 作答 / 知识点 / 复习项。
 */
import type { FastifyInstance } from "fastify";
import { createLearningGoalSchema, updateLearningGoalSchema, updateMistakeRequestSchema } from "@aervox/contracts";
import type { SqliteLearningRepository } from "@aervox/database";
import { resolveTenant } from "../../shared/tenant.js";
import { createReviewItem, getLocalDayBounds, getPracticeSessionProgress, normalizeMistakeNote, updateAfterAnswer } from "@aervox/practice-review";

let seq = 0;
const estimatedMinutesPerReview = 2;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function judgeAnswer(answerSpec: unknown, answer: string): "correct" | "incorrect" | "unverifiable" {
  if (
    !answerSpec ||
    typeof answerSpec !== "object" ||
    !("answer" in answerSpec) ||
    typeof answerSpec.answer !== "string"
  ) {
    return "unverifiable";
  }

  return answer.trim().toLocaleLowerCase() === answerSpec.answer.trim().toLocaleLowerCase()
    ? "correct"
    : "incorrect";
}

function nextStepFor(judgement: "correct" | "incorrect" | "unverifiable"): string {
  if (judgement === "correct") return "continue";
  if (judgement === "incorrect") return "review_scheduled";
  return "await_review";
}

function practiceReport(sessionId: string, attempted: Array<{ judgement: string }>, questionCount: number) {
  const correctCount = attempted.filter((attempt) => attempt.judgement === "correct").length;
  const incorrectCount = attempted.filter((attempt) => attempt.judgement === "incorrect").length;
  const unverifiableCount = attempted.filter((attempt) => attempt.judgement === "unverifiable").length;
  const judgedCount = correctCount + incorrectCount;
  return {
    sessionId,
    questionCount,
    answeredCount: attempted.length,
    remainingCount: Math.max(questionCount - attempted.length, 0),
    correctCount,
    incorrectCount,
    unverifiableCount,
    accuracy: judgedCount === 0 ? null : correctCount / judgedCount,
    nextStep:
      incorrectCount > 0 ? "review_scheduled" : unverifiableCount > 0 ? "await_review" : "continue",
  };
}

async function practiceSessionResumePayload(
  learningRepo: SqliteLearningRepository,
  tenant: ReturnType<typeof resolveTenant>,
  session: { id: string; questionIds: string[]; startedAt: string },
) {
  const items = await Promise.all(session.questionIds.map((questionId) => learningRepo.getQuestion(tenant, questionId)));
  if (items.some((item) => !item)) return null;

  const attempts = await learningRepo.listAttemptsBySession(tenant, session.id);
  const { answeredQuestionIds, nextQuestionIndex } = getPracticeSessionProgress(session.questionIds, attempts);
  return {
    sessionId: session.id,
    items,
    startedAt: session.startedAt,
    answeredQuestionIds,
    nextQuestionIndex,
  };
}

export function registerLearningRoutes(
  app: FastifyInstance,
  learningRepo: SqliteLearningRepository,
): void {
  // 学习目标
  app.post("/v1/learning/goals", async (req, reply) => {
    const tenant = resolveTenant(req);
    const parsed = createLearningGoalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { topic, level, availableMinutes } = parsed.data;
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey === "string" && idempotencyKey.length > 0) {
      const result = await learningRepo.createLearningGoalIdempotent(tenant, {
        id: id("goal"),
        topic,
        level,
        availableMinutes,
        idempotencyKey,
      });
      return reply.code(result.created ? 201 : 200).send(result.goal);
    }
    const goal = await learningRepo.createLearningGoal(tenant, { id: id("goal"), topic, level, availableMinutes });
    return reply.code(201).send(goal);
  });

  app.get("/v1/learning/goals", async (req) => {
    const includeArchived = (req.query as { includeArchived?: string }).includeArchived === "true";
    return { items: await learningRepo.listLearningGoals(resolveTenant(req), includeArchived) };
  });

  app.get("/v1/learning/goals/:goalId", async (req, reply) => {
    const { goalId } = req.params as { goalId: string };
    const goal = await learningRepo.getLearningGoal(resolveTenant(req), goalId);
    if (!goal) return reply.code(404).send({ error: "goal not found" });
    return goal;
  });

  app.patch("/v1/learning/goals/:goalId", async (req, reply) => {
    const { goalId } = req.params as { goalId: string };
    const parsed = updateLearningGoalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const tenant = resolveTenant(req);
    const existing = await learningRepo.getLearningGoal(tenant, goalId);
    if (!existing || existing.status === "archived") {
      return reply.code(404).send({ error: "goal not found" });
    }
    const goal = await learningRepo.updateLearningGoal(tenant, goalId, parsed.data);
    return goal;
  });

  app.delete("/v1/learning/goals/:goalId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { goalId } = req.params as { goalId: string };
    const existing = await learningRepo.getLearningGoal(tenant, goalId);
    if (!existing || existing.status === "archived") {
      return reply.code(404).send({ error: "goal not found" });
    }
    await learningRepo.updateLearningGoal(tenant, goalId, { status: "archived" });
    return reply.code(204).send();
  });

  // 题目
  app.post("/v1/questions", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as {
      prompt?: string;
      answerSpec?: unknown;
      sourceArtifactId?: string | null;
      knowledgeId?: string | null;
    };
    if (!body.prompt) return reply.code(400).send({ error: "prompt is required" });
    if (body.knowledgeId && !(await learningRepo.getKnowledgeItem(tenant, body.knowledgeId))) {
      return reply.code(400).send({ error: "knowledge item not found" });
    }
    const question = await learningRepo.createQuestion(tenant, {
      id: id("q"),
      prompt: body.prompt,
      answerSpec: body.answerSpec ?? {},
      sourceArtifactId: body.sourceArtifactId,
      knowledgeId: body.knowledgeId,
    });
    return reply.code(201).send(question);
  });

  app.get("/v1/questions/:questionId", async (req, reply) => {
    const { questionId } = req.params as { questionId: string };
    const question = await learningRepo.getQuestion(resolveTenant(req), questionId);
    if (!question) return reply.code(404).send({ error: "question not found" });
    return question;
  });

  app.get("/v1/practice/questions", async (req, reply) => {
    const countParam = (req.query as { count?: string }).count;
    const count = countParam === undefined ? 3 : Number(countParam);
    if (!Number.isInteger(count) || count < 3 || count > 5) {
      return reply.code(400).send({ error: "count must be an integer from 3 to 5" });
    }
    return { items: await learningRepo.listActiveQuestions(resolveTenant(req), count) };
  });

  app.post("/v1/practice/sessions", async (req, reply) => {
    const tenant = resolveTenant(req);
    const countValue = (req.body as { count?: unknown } | undefined)?.count ?? 3;
    if (typeof countValue !== "number" || !Number.isInteger(countValue) || countValue < 3 || countValue > 5) {
      return reply.code(400).send({ error: "count must be an integer from 3 to 5" });
    }
    const activeSession = await learningRepo.getLatestActivePracticeSession(tenant);
    if (activeSession) {
      const payload = await practiceSessionResumePayload(learningRepo, tenant, activeSession);
      if (!payload) return reply.code(409).send({ error: "practice session question is unavailable" });
      return reply.code(200).send(payload);
    }

    const items = await learningRepo.listActiveQuestions(tenant, countValue);
    if (items.length < countValue) {
      return reply.code(409).send({ error: `at least ${countValue} active questions are required` });
    }
    const session = await learningRepo.createPracticeSession(tenant, {
      id: id("practice"),
      questionCount: items.length,
      questionIds: items.map((item) => item.id),
    });
    return reply.code(201).send({ sessionId: session.id, items, startedAt: session.startedAt, answeredQuestionIds: [], nextQuestionIndex: 0 });
  });

  app.get("/v1/practice/sessions/active", async (req, reply) => {
    const tenant = resolveTenant(req);
    const session = await learningRepo.getLatestActivePracticeSession(tenant);
    if (!session) return reply.code(404).send({ error: "practice session not found" });
    const payload = await practiceSessionResumePayload(learningRepo, tenant, session);
    if (!payload) return reply.code(409).send({ error: "practice session question is unavailable" });
    return payload;
  });

  app.get("/v1/practice/sessions/:sessionId/report", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const tenant = resolveTenant(req);
    const session = await learningRepo.getPracticeSession(tenant, sessionId);
    if (!session) return reply.code(404).send({ error: "practice session not found" });
    const attempts = await learningRepo.listAttemptsBySession(tenant, sessionId);
    return practiceReport(sessionId, attempts, session.questionCount);
  });

  app.post("/v1/practice/sessions/:sessionId/complete", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const tenant = resolveTenant(req);
    const session = await learningRepo.completePracticeSession(tenant, sessionId);
    if (!session) return reply.code(404).send({ error: "practice session not found" });
    const attempts = await learningRepo.listAttemptsBySession(tenant, sessionId);
    return practiceReport(sessionId, attempts, session.questionCount);
  });

  // 作答（不可变学习事实）
  app.post("/v1/questions/:questionId/attempts", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { questionId } = req.params as { questionId: string };
    const body = (req.body ?? {}) as {
      sessionId?: string;
      answer?: string;
      evidence?: unknown;
      timeZone?: string;
    };
    if (!body.answer) return reply.code(400).send({ error: "answer is required" });
    if (body.timeZone !== undefined && !validTimeZone(body.timeZone)) {
      return reply.code(400).send({ error: "timeZone must be a valid IANA time zone" });
    }
    const idempotencyKey = req.headers["idempotency-key"];
    const hasIdempotencyKey = typeof idempotencyKey === "string" && idempotencyKey.length > 0;
    const question = await learningRepo.getQuestion(tenant, questionId);
    if (!question) return reply.code(404).send({ error: "question not found" });
    if (body.sessionId?.startsWith("practice_")) {
      const session = await learningRepo.getPracticeSession(tenant, body.sessionId);
      if (!session || session.status !== "active") {
        return reply.code(409).send({ error: "practice session is not active" });
      }
      if (!session.questionIds.includes(questionId)) {
        return reply.code(400).send({ error: "question does not belong to practice session" });
      }
    }
    const judgement = judgeAnswer(question.answerSpec, body.answer);

    const { attempt, created } = hasIdempotencyKey
      ? await learningRepo.recordAttemptIdempotent(tenant, {
          id: id("att"),
          sessionId: body.sessionId ?? "ses_unknown",
          questionId,
          answer: body.answer,
          judgement,
          evidence: body.evidence,
          idempotencyKey,
        })
      : {
          attempt: await learningRepo.recordAttempt(tenant, {
            id: id("att"),
            sessionId: body.sessionId ?? "ses_unknown",
            questionId,
            answer: body.answer,
            judgement,
            evidence: body.evidence,
            idempotencyKey: null,
          }),
          created: true,
        };
    if (!created) return reply.code(200).send({ ...attempt, nextStep: nextStepFor(attempt.judgement as "correct" | "incorrect" | "unverifiable") });
    if (!question.knowledgeId || !["correct", "incorrect"].includes(judgement)) {
      return reply.code(201).send({ ...attempt, nextStep: nextStepFor(judgement) });
    }

    const storedItem = await learningRepo.getKnowledgeItem(tenant, question.knowledgeId);
    if (!storedItem) return reply.code(201).send(attempt);

    const item = {
      id: storedItem.id,
      name: storedItem.concept,
      correctCount: storedItem.correctCount,
      wrongCount: storedItem.wrongCount,
      correctStreak: storedItem.correctStreak,
      mastery: storedItem.mastery,
    };
    const isCorrect = judgement === "correct";
    updateAfterAnswer(item, isCorrect);
    const timeZone = body.timeZone ?? "UTC";
    const review = createReviewItem(item, isCorrect, { timeZone });
    const masteryState = item.mastery >= 0.8 ? "mastered" : "learning";
    await learningRepo.updatePracticeState(tenant, item.id, {
      ...item,
      masteryState,
      masteryBasis: {
        correctCount: item.correctCount,
        wrongCount: item.wrongCount,
        correctStreak: item.correctStreak,
        schedulerVersion: review.schedulerVersion,
      },
    });
    await learningRepo.scheduleReviewItem(tenant, {
      id: id("review"),
      knowledgeId: review.knowledgeId,
      dueAt: review.dueAt.toISOString(),
      intervalDays: review.intervalDays,
      schedulerVersion: review.schedulerVersion,
      timezoneSnapshot: timeZone,
    });
    return reply.code(201).send({ ...attempt, nextStep: nextStepFor(judgement) });
  });

  app.get("/v1/questions/:questionId/attempts", async (req) => {
    const { questionId } = req.params as { questionId: string };
    return { items: await learningRepo.listAttemptsByQuestion(resolveTenant(req), questionId) };
  });

  // 错题本（由不可变作答事实派生，不复制原始答案）
  app.get("/v1/mistakes", async (req, reply) => {
    const { status = "active", reasonCode } = req.query as { status?: string; reasonCode?: string };
    if (!["active", "mastered", "dismissed", "all"].includes(status)) {
      return reply.code(400).send({ error: "status must be active, mastered, dismissed, or all" });
    }
    if (reasonCode !== undefined && !["concept_gap", "calculation", "careless", "misread", "other"].includes(reasonCode)) {
      return reply.code(400).send({ error: "reasonCode is invalid" });
    }
    return {
      items: (await learningRepo.listMistakes(
        resolveTenant(req),
        status as "active" | "mastered" | "dismissed" | "all",
      )).filter((item) => reasonCode === undefined || item.reasonCode === reasonCode),
    };
  });

  app.patch("/v1/mistakes/:questionId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { questionId } = req.params as { questionId: string };
    const parsed = updateMistakeRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const body = parsed.data;
    const mistake = (await learningRepo.listMistakes(tenant, "all"))
      .find((item) => item.questionId === questionId);
    if (!mistake) return reply.code(404).send({ error: "mistake not found" });
    if (body.reasonCode !== undefined) {
      if (body.reasonCode === null) {
        await learningRepo.clearMistakeInsight(tenant, questionId);
      } else {
        await learningRepo.setMistakeInsight(tenant, {
          id: id("mistake_insight"),
          questionId,
          reasonCode: body.reasonCode,
          note: normalizeMistakeNote(body.note),
        });
      }
    }
    const refreshed = (await learningRepo.listMistakes(tenant, "all"))
      .find((item) => item.questionId === questionId) ?? mistake;
    if (body.status === undefined) return refreshed;
    if (body.status === "dismissed" || (body.status === "active" && mistake.status === "dismissed")) {
      await learningRepo.setMistakeDisposition(tenant, {
        id: id("mistake_disposition"),
        questionId,
        status: body.status,
      });
      return { ...refreshed, status: body.status };
    }
    if (!mistake.knowledgeId) {
      return reply.code(409).send({ error: "mistake has no knowledge item" });
    }
    const updated = await learningRepo.updateMastery(
      tenant,
      mistake.knowledgeId,
      body.status === "mastered" ? "mastered" : "learning",
      { source: "user", action: body.status === "mastered" ? "mark_mastered" : "resume_learning" },
    );
    return { ...refreshed, masteryState: updated?.masteryState, status: body.status };
  });

  app.post("/v1/mistakes/repractice", async (req, reply) => {
    const tenant = resolveTenant(req);
    const requested = (req.body as { questionIds?: unknown } | undefined)?.questionIds;
    if (requested !== undefined && (!Array.isArray(requested) || requested.some((value) => typeof value !== "string"))) {
      return reply.code(400).send({ error: "questionIds must be an array of strings" });
    }
    const activeSession = await learningRepo.getLatestActivePracticeSession(tenant);
    if (activeSession) {
      const payload = await practiceSessionResumePayload(learningRepo, tenant, activeSession);
      if (!payload) return reply.code(409).send({ error: "practice session question is unavailable" });
      return reply.code(200).send(payload);
    }
    const activeMistakes = await learningRepo.listMistakes(tenant, "active");
    const available = new Map(activeMistakes.map((item) => [item.questionId, item]));
    const questionIds = (requested as string[] | undefined) ?? activeMistakes.slice(0, 5).map((item) => item.questionId);
    const uniqueQuestionIds = [...new Set(questionIds)];
    if (uniqueQuestionIds.length < 1 || uniqueQuestionIds.length > 5) {
      return reply.code(400).send({ error: "choose from 1 to 5 mistakes" });
    }
    if (uniqueQuestionIds.some((questionId) => !available.has(questionId))) {
      return reply.code(400).send({ error: "questionIds must reference active mistakes" });
    }
    const items = await Promise.all(uniqueQuestionIds.map((questionId) => learningRepo.getQuestion(tenant, questionId)));
    if (items.some((item) => !item)) return reply.code(409).send({ error: "mistake question is unavailable" });
    const session = await learningRepo.createPracticeSession(tenant, {
      id: id("practice"),
      questionCount: uniqueQuestionIds.length,
      questionIds: uniqueQuestionIds,
    });
    return reply.code(201).send({ sessionId: session.id, items });
  });

  // 知识点
  app.get("/v1/knowledge-items/:knowledgeId", async (req, reply) => {
    const { knowledgeId } = req.params as { knowledgeId: string };
    const item = await learningRepo.getKnowledgeItem(resolveTenant(req), knowledgeId);
    if (!item) return reply.code(404).send({ error: "knowledge item not found" });
    return item;
  });

  // 复习项
  app.get("/v1/review-items", async (req) => {
    const dueBefore =
      ((req.query as { dueBefore?: string }).dueBefore ?? new Date().toISOString());
    return { items: await learningRepo.listDueReviewItems(resolveTenant(req), dueBefore) };
  });

  app.get("/v1/review-items/summary", async (req, reply) => {
    const query = req.query as { dueBefore?: string; timeZone?: string };
    const now = new Date();
    const dueBefore = query.dueBefore ?? now.toISOString();
    const timeZone = query.timeZone ?? "UTC";
    if (Number.isNaN(Date.parse(dueBefore))) {
      return reply.code(400).send({ error: "dueBefore must be an ISO date-time" });
    }
    if (!validTimeZone(timeZone)) {
      return reply.code(400).send({ error: "timeZone must be a valid IANA time zone" });
    }
    const items = await learningRepo.listDueReviewItems(resolveTenant(req), dueBefore);
    const { start } = getLocalDayBounds(now, timeZone);
    const overdueCount = items.filter((item) => Date.parse(item.dueAt) < start.getTime()).length;
    return {
      dueCount: items.length,
      overdueCount,
      dueTodayCount: items.length - overdueCount,
      estimatedMinutes: items.length * estimatedMinutesPerReview,
      timeZone,
      items,
    };
  });

  app.get("/v1/review-items/history", async (req, reply) => {
    const rawLimit = (req.query as { limit?: string }).limit;
    const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return reply.code(400).send({ error: "limit must be an integer between 1 and 50" });
    }
    return { items: await learningRepo.listCompletedReviewItems(resolveTenant(req), limit) };
  });

  app.post("/v1/review-items/:reviewId/complete", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { reviewId } = req.params as { reviewId: string };
    const body = (req.body ?? {}) as { isCorrect?: boolean; timeZone?: string };
    if (typeof body.isCorrect !== "boolean") {
      return reply.code(400).send({ error: "isCorrect is required" });
    }
    if (body.timeZone !== undefined && !validTimeZone(body.timeZone)) {
      return reply.code(400).send({ error: "timeZone must be a valid IANA time zone" });
    }
    const reviewItem = await learningRepo.getReviewItem(tenant, reviewId);
    if (!reviewItem) return reply.code(404).send({ error: "review item not found" });
    const replayCompletion = async (completed: typeof reviewItem) => {
      if (completed.status !== "completed" || !completed.nextReviewId) return null;
      if (completed.completionIsCorrect !== body.isCorrect) {
        return reply.code(409).send({ error: "review completion payload does not match" });
      }
      const nextReview = await learningRepo.getReviewItem(tenant, completed.nextReviewId);
      const knowledge = await learningRepo.getKnowledgeItem(tenant, completed.knowledgeId);
      return nextReview && knowledge ? { completed, nextReview, knowledge } : null;
    };
    const replay = await replayCompletion(reviewItem);
    if (replay) return replay;
    if (reviewItem.status !== "active") return reply.code(404).send({ error: "active review item not found" });
    const storedItem = await learningRepo.getKnowledgeItem(tenant, reviewItem.knowledgeId);
    if (!storedItem) return reply.code(404).send({ error: "knowledge item not found" });

    const item = {
      id: storedItem.id,
      name: storedItem.concept,
      correctCount: storedItem.correctCount,
      wrongCount: storedItem.wrongCount,
      correctStreak: storedItem.correctStreak,
      mastery: storedItem.mastery,
    };
    updateAfterAnswer(item, body.isCorrect);
    const timeZone = body.timeZone ?? reviewItem.timezoneSnapshot ?? "UTC";
    const next = createReviewItem(item, body.isCorrect, { timeZone });
    const masteryState = item.mastery >= 0.8 ? "mastered" : "learning";
    const result = await learningRepo.completeReviewAndSchedule(tenant, {
      reviewId,
      knowledgeId: item.id,
      isCorrect: body.isCorrect,
      practiceState: {
        ...item,
        masteryState,
        masteryBasis: {
          correctCount: item.correctCount,
          wrongCount: item.wrongCount,
          correctStreak: item.correctStreak,
          schedulerVersion: next.schedulerVersion,
        },
      },
      nextReview: {
        id: id("review"),
        dueAt: next.dueAt.toISOString(),
        intervalDays: next.intervalDays,
        schedulerVersion: next.schedulerVersion,
        timezoneSnapshot: timeZone,
      },
    });
    if (!result) {
      const concurrentCompletion = await learningRepo.getReviewItem(tenant, reviewId);
      if (concurrentCompletion) {
        const concurrentReplay = await replayCompletion(concurrentCompletion);
        if (concurrentReplay) return concurrentReplay;
      }
      return reply.code(409).send({ error: "review item was already completed" });
    }
    return result;
  });
}
