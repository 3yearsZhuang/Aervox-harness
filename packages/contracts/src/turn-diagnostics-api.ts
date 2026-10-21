import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import type { ApiEndpoint } from "./http-api.js";

extendZodWithOpenApi(z);
const id = z.string().min(1).max(256);
const status = z.string().min(1).max(64);
export const turnDiagnosticsSchema = z.object({
  turnId: id, sessionId: id, status,
  observedAt: z.string(), selectedAttemptId: id.nullable(),
  attempts: z.array(z.object({
    id, attempt: z.number().int(), status, startedAt: z.string(), finishedAt: z.string().nullable(),
  })),
  terminationReason: z.string().nullable(),
  modelRuns: z.array(z.object({
    id, step: z.number().int().nullable(), provider: z.string(), modelId: z.string(), status,
    latencyMs: z.number().nullable(), contextManifestId: id.nullable(),
  })),
  tools: z.array(z.object({
    invocationId: id, name: z.string(), status, startedAt: z.string(), finishedAt: z.string(),
  })),
  approvals: z.array(z.object({ id, toolName: z.string(), state: status, decidedAt: z.string().nullable() })),
  truncated: z.object({ attempts: z.boolean(), modelRuns: z.boolean(), tools: z.boolean(), approvals: z.boolean() }),
  unavailable: z.array(z.enum(["context_pruning", "plugin_timeline", "tool_step_mapping"])),
}).openapi("TurnDiagnostics");

export type TurnDiagnostics = z.infer<typeof turnDiagnosticsSchema>;
export const turnDiagnosticsApi = {
  get: {
    method: "get", path: "/v1/turns/{turnId}/diagnostics", operationId: "getTurnDiagnostics",
    summary: "读取按 Attempt 隔离的持久运行诊断摘要（不包含正文、参数和输出）", tags: ["Conversation"],
    params: z.object({ turnId: id }), query: z.object({ attemptId: id.optional() }).strict(),
    response: turnDiagnosticsSchema,
    errors: { 400: "VALIDATION_FAILED", 404: "TURN_OR_ATTEMPT_NOT_FOUND" },
  },
} as const satisfies Record<string, ApiEndpoint>;
