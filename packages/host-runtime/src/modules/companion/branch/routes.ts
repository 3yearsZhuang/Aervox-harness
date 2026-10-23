/**
 * Aervox｜思隅 @aervox/api — 会话地图分支路由（P1 · CAP-014）
 *
 * 覆盖：
 * - 分支创建（术语下钻、文本追问、替代解法）
 * - 分支生命周期（合并回主线、归档、删除）
 * - 会话地图布局（布局数据丢失不影响会话内容）
 * - 分支树查询（有界获取所有可达子分支）
 */
import type { FastifyInstance } from "fastify";
import { BranchTreeLimitError, type ConversationBranchPort } from "@aervox/repositories";
import { branchesApi, type CreateBranchRequest } from "@aervox/contracts";
import { resolveLocalContext } from "../../../shared/local-context.js";
import { registerContractRoute } from "../../../shared/contract-route.js";
import { withRequestSignal } from "../../../shared/request-signal.js";
import { readIdempotencyKey } from "../../../shared/idempotency-key.js";

export function registerBranchRoutes(
  app: FastifyInstance,
  conversationRepo: ConversationBranchPort,
): void {
  // POST /v1/sessions/:sessionId/branches — 创建分支
  registerContractRoute(app, branchesApi.create, async (req, reply) => {
    const ctx = resolveLocalContext(req);
    const { sessionId } = req.params as { sessionId: string };
    const input = req.body as CreateBranchRequest;

    if (input.childSessionId === sessionId) return reply.status(400).send({ error: "branch_requires_distinct_sessions" });
    try {
      const branch = await conversationRepo.createExplorationBranch(ctx, {
        idempotencyKey: readIdempotencyKey(req.headers["idempotency-key"]), parentSessionId: sessionId,
        childSessionId: input.childSessionId, forkAtMessageId: input.forkAtMessageId,
        title: input.title, branchReason: input.branchReason,
      });
      if (!branch) return reply.status(404).send({ error: "Parent session not found" });
      return branch;
    } catch (error) {
      if (error instanceof Error && ["conversation_branch_idempotency_conflict", "conversation_branch_result_unavailable"].includes(error.message)) {
        return reply.status(409).send({ error: error.message });
      }
      if (error instanceof Error && error.message.startsWith("conversation_execution_policy_")) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  });

  // GET /v1/sessions/:sessionId/branches — 列出直接子分支
  registerContractRoute(app, branchesApi.list, async (req) => {
    const ctx = resolveLocalContext(req);
    const { sessionId } = req.params as { sessionId: string };
    const items = await conversationRepo.listBranchesByParent(ctx, sessionId);
    return { items };
  });

  // GET /v1/sessions/:sessionId/branch-tree — 有界读取会话地图
  registerContractRoute(app, branchesApi.tree, async (req, reply) => {
    const ctx = resolveLocalContext(req);
    const { sessionId } = req.params as { sessionId: string };
    try {
      const items = await withRequestSignal(req, reply, signal => conversationRepo.getBranchTree(ctx, sessionId, { signal }));
      return { items };
    } catch (error) {
      if (error instanceof BranchTreeLimitError) {
        return reply.status(422).send({ code: "branch_tree_limit_exceeded", error: "branch_tree_limit_exceeded" });
      }
      throw error;
    }
  });

  // GET /v1/branches/:branchId — 获取分支详情
  registerContractRoute(app, branchesApi.get, async (req, reply) => {
    const ctx = resolveLocalContext(req);
    const { branchId } = req.params as { branchId: string };
    const branch = await conversationRepo.getBranch(ctx, branchId);
    if (!branch) {
      return reply.status(404).send({ error: "Branch not found" });
    }
    return branch;
  });

  // POST /v1/branches/:branchId/merge — 合并分支回主线
  registerContractRoute(app, branchesApi.merge, async (req, reply) => {
    const ctx = resolveLocalContext(req);
    const { branchId } = req.params as { branchId: string };
    const merged = await conversationRepo.mergeBranch(ctx, branchId);
    if (!merged) {
      return reply.status(404).send({ error: "Branch not found or not active" });
    }
    return merged;
  });

  // POST /v1/branches/:branchId/archive — 归档分支
  registerContractRoute(app, branchesApi.archive, async (req, reply) => {
    const ctx = resolveLocalContext(req);
    const { branchId } = req.params as { branchId: string };
    const archived = await conversationRepo.archiveBranch(ctx, branchId);
    if (!archived) {
      return reply.status(404).send({ error: "Branch not found or not active" });
    }
    return archived;
  });

  // PATCH /v1/branches/:branchId/layout — 更新布局数据
  registerContractRoute(app, branchesApi.updateLayout, async (req, reply) => {
    const ctx = resolveLocalContext(req);
    const { branchId } = req.params as { branchId: string };
    const input = req.body as { layoutData: unknown };
    const updated = await conversationRepo.updateBranchLayout(ctx, branchId, input.layoutData);
    if (!updated) {
      return reply.status(404).send({ error: "Branch not found" });
    }
    return updated;
  });

  // DELETE /v1/branches/:branchId — 软删除分支
  registerContractRoute(app, branchesApi.delete, async (req, reply) => {
    const ctx = resolveLocalContext(req);
    const { branchId } = req.params as { branchId: string };
    const deleted = await conversationRepo.deleteBranch(ctx, branchId);
    if (!deleted) {
      return reply.status(404).send({ error: "Branch not found" });
    }
    return deleted;
  });
}
