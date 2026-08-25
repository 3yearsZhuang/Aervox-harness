/**
 * Aervox｜思隅 @aervox/api — 学习/练习/复习域路由
 *
 * 面向用户侧：学习目标 / 题目 / 作答 / 知识点 / 复习项。
 */
import type { FastifyInstance } from "fastify";
import type { RepoContainer } from "../container.js";
import { resolveTenant } from "../tenant.js";
import { createReviewItem, updateAfterAnswer } from "@aervox/practice-review";

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerLearningRoutes(app: FastifyInstance, c: RepoContainer): void {
  // 学习目标
  app.post("/v1/learning/goals", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as { topic?: string; level?: string; availableMinutes?: number };
    if (!body.topic) return reply.code(400).send({ error: "topic is required" });
    const goal = await c.learning.createLearningGoal(tenant, {
      id: id("goal"),
      topic: body.topic,
      level: body.level,
      availableMinutes: body.availableMinutes,
    });
    return reply.code(201).send(goal);
  });

  app.get("/v1/learning/goals", async (req) => {
    return { items: await c.learning.listLearningGoals(resolveTenant(req)) };
  });

  app.get("/v1/learning/goals/:goalId", async (req, reply) => {
    const { goalId } = req.params as { goalId: string };
    const goal = await c.learning.getLearningGoal(resolveTenant(req), goalId);
    if (!goal) return reply.code(404).send({ error: "goal not found" });
    return goal;
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
    if (body.knowledgeId && !(await c.learning.getKnowledgeItem(tenant, body.knowledgeId))) {
      return reply.code(400).send({ error: "knowledge item not found" });
    }
    const question = await c.learning.createQuestion(tenant, {
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
    const question = await c.learning.getQuestion(resolveTenant(req), questionId);
    if (!question) return reply.code(404).send({ error: "question not found" });
    return question;
  });

  // 作答（不可变学习事实）
  app.post("/v1/questions/:questionId/attempts", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { questionId } = req.params as { questionId: string };
    const body = (req.body ?? {}) as {
      sessionId?: string;
      answer?: string;
      judgement?: string;
      evidence?: unknown;
    };
    if (!body.answer || !body.judgement) {
      return reply.code(400).send({ error: "answer and judgement are required" });
    }
    if (!(["correct", "incorrect", "partial", "unverifiable"] as const).includes(body.judgement as never)) {
      return reply.code(400).send({ error: "invalid judgement" });
    }
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey === "string") {
      const previous = await c.learning.getAttemptByIdempotencyKey(tenant, idempotencyKey);
      if (previous) return reply.code(200).send(previous);
    }
    const question = await c.learning.getQuestion(tenant, questionId);
    if (!question) return reply.code(404).send({ error: "question not found" });

    const attempt = await c.learning.recordAttempt(tenant, {
      id: id("att"),
      sessionId: body.sessionId ?? "ses_unknown",
      questionId,
      answer: body.answer,
      judgement: body.judgement,
      evidence: body.evidence,
      idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : null,
    });
    if (!question.knowledgeId || !["correct", "incorrect"].includes(body.judgement)) {
      return reply.code(201).send(attempt);
    }

    const storedItem = await c.learning.getKnowledgeItem(tenant, question.knowledgeId);
    if (!storedItem) return reply.code(201).send(attempt);

    const item = {
      id: storedItem.id,
      name: storedItem.concept,
      correctCount: storedItem.correctCount,
      wrongCount: storedItem.wrongCount,
      correctStreak: storedItem.correctStreak,
      mastery: storedItem.mastery,
    };
    const isCorrect = body.judgement === "correct";
    updateAfterAnswer(item, isCorrect);
    const review = createReviewItem(item, isCorrect);
    const masteryState = item.mastery >= 0.8 ? "mastered" : "learning";
    await c.learning.updatePracticeState(tenant, item.id, {
      ...item,
      masteryState,
      masteryBasis: {
        correctCount: item.correctCount,
        wrongCount: item.wrongCount,
        correctStreak: item.correctStreak,
        schedulerVersion: review.schedulerVersion,
      },
    });
    await c.learning.scheduleReviewItem(tenant, {
      id: id("review"),
      knowledgeId: review.knowledgeId,
      dueAt: review.dueAt.toISOString(),
      intervalDays: review.intervalDays,
    });
    return reply.code(201).send(attempt);
  });

  app.get("/v1/questions/:questionId/attempts", async (req) => {
    const { questionId } = req.params as { questionId: string };
    return { items: await c.learning.listAttemptsByQuestion(resolveTenant(req), questionId) };
  });

  // 知识点
  app.get("/v1/knowledge-items/:knowledgeId", async (req, reply) => {
    const { knowledgeId } = req.params as { knowledgeId: string };
    const item = await c.learning.getKnowledgeItem(resolveTenant(req), knowledgeId);
    if (!item) return reply.code(404).send({ error: "knowledge item not found" });
    return item;
  });

  // 复习项
  app.get("/v1/review-items", async (req) => {
    const dueBefore =
      ((req.query as { dueBefore?: string }).dueBefore ?? new Date().toISOString());
    return { items: await c.learning.listDueReviewItems(resolveTenant(req), dueBefore) };
  });

  app.post("/v1/review-items/:reviewId/complete", async (req, reply) => {
    const { reviewId } = req.params as { reviewId: string };
    const item = await c.learning.completeReviewItem(resolveTenant(req), reviewId);
    if (!item) return reply.code(404).send({ error: "review item not found" });
    return item;
  });
}
