/**
 * Aervox｜思隅 @aervox/api — 记忆投影节点路由（P1）
 *
 * 记忆树投影独立化后，投影节点面向用户侧可读/可建。
 */
import type { FastifyInstance } from "fastify";
import { createMemoryNodeRequestSchema } from "@aervox/contracts";
import type { SqliteMemoryRepository } from "@aervox/repositories";
import { resolveLocalContext } from "../../../shared/local-context.js";

let seq = 0;
const id = (): string => `node_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerMemoryRoutes(
  app: FastifyInstance,
  memoryRepo: SqliteMemoryRepository,
): void {
  app.get("/v1/memory/nodes", async (req) => {
    return { items: await memoryRepo.listNodesByTenant(resolveLocalContext(req)) };
  });

  app.post("/v1/memory/nodes", async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const parsed = createMemoryNodeRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "VALIDATION_FAILED", message: "Invalid memory node", details: parsed.error.issues });
    const body = parsed.data;
    const node = await memoryRepo.createNode(tenant, {
      id: id(),
      label: body.label,
      nodeType: body.nodeType,
      canonicalParentId: body.canonicalParentId,
      confidence: body.confidence,
    });
    return reply.code(201).send(node);
  });
}
