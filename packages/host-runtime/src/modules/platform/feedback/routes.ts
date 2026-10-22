/**
 * Aervox｜思隅 @aervox/api — 反馈域路由
 */
import type { FastifyInstance } from "fastify";
import type { SqliteFeedbackRepository } from "@aervox/repositories";
import { feedbackApi, type CreateFeedbackRequest } from "@aervox/contracts";
import { resolveLocalContext } from "../../../shared/local-context.js";
import { registerContractRoute } from "../../../shared/contract-route.js";

let seq = 0;
const id = (): string => `fb_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerFeedbackRoutes(
  app: FastifyInstance,
  feedbackRepo: SqliteFeedbackRepository,
): void {
  registerContractRoute(app, feedbackApi.create, async (req) => {
    const ctx = resolveLocalContext(req);
    const body = req.body as CreateFeedbackRequest;
    return feedbackRepo.createFeedback(ctx, {
      id: id(),
      actorId: ctx.actorId ?? ctx.subjectUserId,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      type: body.type,
      note: body.note,
    });
  });

  registerContractRoute(app, feedbackApi.list, async (req) => {
    const q = req.query as { subjectType?: string; subjectId?: string };
    return {
      items: await feedbackRepo.listFeedback(resolveLocalContext(req), q.subjectType, q.subjectId),
    };
  });
}
