/**
 * Aervox｜思隅 @aervox/api — 反馈域路由
 */
import type { FastifyInstance } from "fastify";
import type { SqliteFeedbackRepository } from "@aervox/database";
import { resolveTenant } from "../../shared/tenant.js";

let seq = 0;
const id = (): string => `fb_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerFeedbackRoutes(
  app: FastifyInstance,
  feedbackRepo: SqliteFeedbackRepository,
): void {
  app.post("/v1/feedback", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as {
      actorId?: string;
      subjectType?: string;
      subjectId?: string;
      type?: string;
      note?: string;
    };
    if (!body.subjectType || !body.subjectId || !body.type) {
      return reply.code(400).send({ error: "subjectType, subjectId and type are required" });
    }
    const created = await feedbackRepo.createFeedback(tenant, {
      id: id(),
      actorId: body.actorId ?? tenant.actorId ?? tenant.subjectUserId,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      type: body.type,
      note: body.note,
    });
    return reply.code(201).send(created);
  });

  app.get("/v1/feedback", async (req) => {
    const q = req.query as { subjectType?: string; subjectId?: string };
    return {
      items: await feedbackRepo.listFeedback(resolveTenant(req), q.subjectType, q.subjectId),
    };
  });
}