/**
 * Aervox｜思隅 @aervox/api — 思维宇宙知识关系路由（P1 · CAP-015）
 *
 * 覆盖：
 * - 知识关系创建（来源、关系类型、置信度）
 * - 纠正关系（corrected 状态停止用于讲解和推荐）
 * - 合并、拆分、删除关系
 * - 知识图谱查询（仅 active 关系）
 */
import type { FastifyInstance } from "fastify";
import type { SqliteLearningRepository } from "@aervox/database";
import {
  createKnowledgeRelationSchema,
  correctRelationSchema,
  mergeRelationsSchema,
} from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";

let seq = 0;
const nextId = (): string => `kr_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  learningRepo: SqliteLearningRepository,
): void {
  // GET /v1/knowledge-relations — 查询知识关系（含历史）
  app.get("/v1/knowledge-relations", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { knowledgeId, activeOnly } = req.query as {
      knowledgeId?: string;
      activeOnly?: string;
    };
    if (!knowledgeId) {
      return reply.send({ items: [] });
    }

    // activeOnly=true 时仅返回 active 关系（用于讲解和推荐）
    if (activeOnly === "true") {
      const items = await learningRepo.getActiveKnowledgeGraph(tenant, knowledgeId);
      return reply.send({ items });
    }

    const items = await learningRepo.listKnowledgeRelations(tenant, knowledgeId);
    return reply.send({ items });
  });

  // POST /v1/knowledge-relations — 创建知识关系
  app.post("/v1/knowledge-relations", async (req, reply) => {
    const tenant = resolveTenant(req);
    const parsed = createKnowledgeRelationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const relation = await learningRepo.createKnowledgeRelation(tenant, {
      id: nextId(),
      fromKnowledgeId: parsed.data.fromKnowledgeId,
      toKnowledgeId: parsed.data.toKnowledgeId,
      relationType: parsed.data.relationType,
      source: parsed.data.source,
      confidence: parsed.data.confidence,
    });
    return reply.status(201).send(relation);
  });

  // GET /v1/knowledge-relations/:id — 获取关系详情
  app.get("/v1/knowledge-relations/:relationId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { relationId } = req.params as { relationId: string };
    const relation = await learningRepo.getKnowledgeRelation(tenant, relationId);
    if (!relation) {
      return reply.status(404).send({ error: "Relation not found" });
    }
    return reply.send(relation);
  });

  // POST /v1/knowledge-relations/:id/correct — 纠正关系
  app.post("/v1/knowledge-relations/:relationId/correct", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { relationId } = req.params as { relationId: string };
    const parsed = correctRelationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const corrected = await learningRepo.correctKnowledgeRelation(tenant, relationId, parsed.data.reason);
    if (!corrected) {
      return reply.status(404).send({ error: "Relation not found or not active" });
    }
    return reply.send(corrected);
  });

  // POST /v1/knowledge-relations/:id/merge — 合并关系
  app.post("/v1/knowledge-relations/:relationId/merge", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { relationId } = req.params as { relationId: string };
    const parsed = mergeRelationsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const merged = await learningRepo.mergeKnowledgeRelations(
      tenant,
      relationId,
      parsed.data.targetRelationId,
    );
    if (!merged) {
      return reply.status(404).send({ error: "Source relation not found or not active" });
    }
    return reply.send(merged);
  });

  // POST /v1/knowledge-relations/:id/split — 拆分关系
  app.post("/v1/knowledge-relations/:relationId/split", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { relationId } = req.params as { relationId: string };
    const parsed = correctRelationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const split = await learningRepo.splitKnowledgeRelation(tenant, relationId, parsed.data.reason);
    if (!split) {
      return reply.status(404).send({ error: "Relation not found or not active" });
    }
    return reply.send(split);
  });

  // DELETE /v1/knowledge-relations/:id — 软删除关系
  app.delete("/v1/knowledge-relations/:relationId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { relationId } = req.params as { relationId: string };
    const deleted = await learningRepo.deleteKnowledgeRelation(tenant, relationId);
    if (!deleted) {
      return reply.status(404).send({ error: "Relation not found" });
    }
    return reply.send(deleted);
  });
}
