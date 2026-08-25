/**
 * Aervox｜思隅 @aervox/api — 会话地图分支路由（P1 · CAP-014）
 */
import type { FastifyInstance } from "fastify";
import type { SqliteConversationRepository } from "@aervox/database";
import { resolveTenant } from "../../shared/tenant.js";

let seq = 0;
const id = (): string => `br_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerBranchRoutes(
  app: FastifyInstance,
  conversationRepo: SqliteConversationRepository,
): void {
  app.post("/v1/sessions/:sessionId/branches", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { sessionId } = req.params as { sessionId: string };
    const body = (req.body ?? {}) as { childSessionId?: string; forkAtMessageId?: string };
    if (!body.childSessionId) {
      return reply.code(400).send({ error: "childSessionId is required" });
    }
    const branch = await conversationRepo.createConversationBranch(tenant, {
      id: id(),
      parentSessionId: sessionId,
      childSessionId: body.childSessionId,
      forkAtMessageId: body.forkAtMessageId,
    });
    return reply.code(201).send(branch);
  });

  app.get("/v1/sessions/:sessionId/branches", async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    return { items: await conversationRepo.listBranchesByParent(resolveTenant(req), sessionId) };
  });
}
