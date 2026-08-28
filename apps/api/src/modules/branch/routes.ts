/**
 * Aervox｜思隅 @aervox/api — 会话地图分支路由（P1 · CAP-014）
 *
 * 覆盖：
 * - 分支创建（术语下钻、文本追问、替代解法）
 * - 分支生命周期（合并回主线、归档、删除）
 * - 会话地图布局（布局数据丢失不影响会话内容）
 * - 分支树查询（递归获取所有子分支）
 */
import type { FastifyInstance } from "fastify";
import type { SqliteConversationRepository } from "@aervox/database";
import { createBranchSchema, updateBranchLayoutSchema } from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";

let seq = 0;
const nextId = (): string => `br_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerBranchRoutes(
  app: FastifyInstance,
  conversationRepo: SqliteConversationRepository,
): void {
  // POST /v1/sessions/:sessionId/branches — 创建分支
  app.post("/v1/sessions/:sessionId/branches", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { sessionId } = req.params as { sessionId: string };
    const parsed = createBranchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const branch = await conversationRepo.createConversationBranch(tenant, {
      id: nextId(),
      parentSessionId: sessionId,
      childSessionId: parsed.data.childSessionId,
      forkAtMessageId: parsed.data.forkAtMessageId,
      title: parsed.data.title,
      branchReason: parsed.data.branchReason,
    });
    return reply.status(201).send(branch);
  });

  // GET /v1/sessions/:sessionId/branches — 列出直接子分支
  app.get("/v1/sessions/:sessionId/branches", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { sessionId } = req.params as { sessionId: string };
    const items = await conversationRepo.listBranchesByParent(tenant, sessionId);
    return reply.send({ items });
  });

  // GET /v1/sessions/:sessionId/branch-tree — 递归获取会话地图
  app.get("/v1/sessions/:sessionId/branch-tree", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { sessionId } = req.params as { sessionId: string };
    const items = await conversationRepo.getBranchTree(tenant, sessionId);
    return reply.send({ items });
  });

  // GET /v1/branches/:branchId — 获取分支详情
  app.get("/v1/branches/:branchId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { branchId } = req.params as { branchId: string };
    const branch = await conversationRepo.getBranch(tenant, branchId);
    if (!branch) {
      return reply.status(404).send({ error: "Branch not found" });
    }
    return reply.send(branch);
  });

  // POST /v1/branches/:branchId/merge — 合并分支回主线
  app.post("/v1/branches/:branchId/merge", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { branchId } = req.params as { branchId: string };
    const merged = await conversationRepo.mergeBranch(tenant, branchId);
    if (!merged) {
      return reply.status(404).send({ error: "Branch not found or not active" });
    }
    return reply.send(merged);
  });

  // POST /v1/branches/:branchId/archive — 归档分支
  app.post("/v1/branches/:branchId/archive", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { branchId } = req.params as { branchId: string };
    const archived = await conversationRepo.archiveBranch(tenant, branchId);
    if (!archived) {
      return reply.status(404).send({ error: "Branch not found or not active" });
    }
    return reply.send(archived);
  });

  // PATCH /v1/branches/:branchId/layout — 更新布局数据
  app.patch("/v1/branches/:branchId/layout", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { branchId } = req.params as { branchId: string };
    const parsed = updateBranchLayoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const updated = await conversationRepo.updateBranchLayout(tenant, branchId, parsed.data.layoutData);
    if (!updated) {
      return reply.status(404).send({ error: "Branch not found" });
    }
    return reply.send(updated);
  });

  // DELETE /v1/branches/:branchId — 软删除分支
  app.delete("/v1/branches/:branchId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { branchId } = req.params as { branchId: string };
    const deleted = await conversationRepo.deleteBranch(tenant, branchId);
    if (!deleted) {
      return reply.status(404).send({ error: "Branch not found" });
    }
    return reply.send(deleted);
  });
}
