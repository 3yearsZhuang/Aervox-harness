import { z } from "zod";
import type { ApiEndpoint } from "./http-api.js";
import { idempotencyHeadersSchema } from "./http-api.js";
import { createBranchSchema, updateBranchLayoutSchema } from "./schemas.js";

/** Preserve the persisted branch row, including historical strings and opaque layout metadata. */
export const conversationBranchResponseSchema = z.object({
  id: z.string().min(1),
  parentSessionId: z.string().min(1),
  childSessionId: z.string().min(1),
  forkAtMessageId: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  branchReason: z.string().nullable().optional(),
  status: z.string(),
  mergedAt: z.string().nullable().optional(),
  layoutData: z.unknown().optional(),
  deletedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const branchListResponseSchema = z.object({ items: z.array(conversationBranchResponseSchema) });
const sessionParamsSchema = z.object({ sessionId: z.string().min(1) });
const branchParamsSchema = z.object({ branchId: z.string().min(1) });

export const branchesApi = {
  create: {
    method: "post", path: "/v1/sessions/{sessionId}/branches", operationId: "post_v1_sessions_sessionId_branches",
    summary: "创建会话分支", tags: ["Branches"], params: sessionParamsSchema,
    body: createBranchSchema, bodyRequired: true, response: conversationBranchResponseSchema, status: 201,
    openapi: { headers: idempotencyHeadersSchema },
    validationErrorMessage: "Validation failed",
    errors: { 400: "Invalid branch request or execution policy mismatch", 404: "Parent session not found", 409: "Idempotency key reused with different branch input" },
  },
  list: {
    method: "get", path: "/v1/sessions/{sessionId}/branches", operationId: "get_v1_sessions_sessionId_branches",
    summary: "列出会话直接子分支", tags: ["Branches"], params: sessionParamsSchema,
    response: branchListResponseSchema, errors: { 400: "Invalid params" },
  },
  tree: {
    method: "get", path: "/v1/sessions/{sessionId}/branch-tree", operationId: "get_v1_sessions_sessionId_branch_tree",
    summary: "读取有界会话分支地图", tags: ["Branches"], params: sessionParamsSchema,
    response: branchListResponseSchema, errors: { 400: "Invalid params", 422: "branch_tree_limit_exceeded" },
  },
  get: {
    method: "get", path: "/v1/branches/{branchId}", operationId: "get_v1_branches_branchId",
    summary: "读取会话分支", tags: ["Branches"], params: branchParamsSchema,
    response: conversationBranchResponseSchema, errors: { 400: "Invalid params", 404: "Branch not found" },
  },
  merge: {
    method: "post", path: "/v1/branches/{branchId}/merge", operationId: "post_v1_branches_branchId_merge",
    summary: "将活动分支标记为已合并", tags: ["Branches"], params: branchParamsSchema,
    response: conversationBranchResponseSchema, errors: { 400: "Invalid params", 404: "Branch not found or not active" },
  },
  archive: {
    method: "post", path: "/v1/branches/{branchId}/archive", operationId: "post_v1_branches_branchId_archive",
    summary: "归档活动会话分支", tags: ["Branches"], params: branchParamsSchema,
    response: conversationBranchResponseSchema, errors: { 400: "Invalid params", 404: "Branch not found or not active" },
  },
  updateLayout: {
    method: "patch", path: "/v1/branches/{branchId}/layout", operationId: "patch_v1_branches_branchId_layout",
    summary: "更新不透明会话地图布局", tags: ["Branches"], params: branchParamsSchema,
    body: updateBranchLayoutSchema, bodyRequired: true, response: conversationBranchResponseSchema,
    validationErrorMessage: "Validation failed", errors: { 400: "Invalid layout request", 404: "Branch not found" },
  },
  delete: {
    method: "delete", path: "/v1/branches/{branchId}", operationId: "delete_v1_branches_branchId",
    summary: "软删除会话分支并返回删除记录", tags: ["Branches"], params: branchParamsSchema,
    response: conversationBranchResponseSchema, errors: { 400: "Invalid params", 404: "Branch not found" },
  },
} as const satisfies Record<string, ApiEndpoint>;

export type ConversationBranchResponse = z.output<typeof conversationBranchResponseSchema>;
export type CreateBranchRequest = z.input<typeof createBranchSchema>;
