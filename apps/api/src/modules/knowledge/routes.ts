/**
 * Aervox｜思隅 @aervox/api — 思维宇宙知识关系路由（P1 · CAP-015）
 */
import type { FastifyInstance } from "fastify";
import type { SqliteLearningRepository } from "@aervox/database";
import { resolveTenant } from "../../shared/tenant.js";

let seq = 0;
const id = (): string => `kr_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  learningRepo: SqliteLearningRepository,
): void {
  app.get("/v1/knowledge-relations", async (req) => {
    const { knowledgeId } = req.query as { knowledgeId?: string };
    if (!knowledgeId) return { items: [] };
    return { items: await learningRepo.listKnowledgeRelations(resolveTenant(req), knowledgeId) };
  });

  app.post("/v1/knowledge-relations", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as {
      fromKnowledgeId?: string;
      toKnowledgeId?: string;
      relationType?: string;
      source?: string;
      confidence?: number;
    };
    if (!body.fromKnowledgeId || !body.toKnowledgeId || !body.relationType) {
      return reply.code(400).send({ error: "fromKnowledgeId, toKnowledgeId and relationType are required" });
    }
    const relation = await learningRepo.createKnowledgeRelation(tenant, {
      id: id(),
      fromKnowledgeId: body.fromKnowledgeId,
      toKnowledgeId: body.toKnowledgeId,
      relationType: body.relationType,
      source: body.source,
      confidence: body.confidence,
    });
    return reply.code(201).send(relation);
  });
}
