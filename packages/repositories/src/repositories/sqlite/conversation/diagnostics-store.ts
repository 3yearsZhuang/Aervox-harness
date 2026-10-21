import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { contextManifests, modelRuns, toolApprovals, toolExecutions, turnAttempts, turns, turnStreamEvents } from "@aervox/schema";
import type { TurnDiagnostics } from "@aervox/contracts";
import type { AervoxDatabase } from "../../../client.js";

// Select only summary columns. Never read prompts, arguments, outputs, errors,
// permission snapshots or token-usage JSON into the HTTP projection.
export async function readTurnDiagnostics(db: AervoxDatabase, turnId: string, attemptId?: string): Promise<TurnDiagnostics | null> {
  const [turn] = await db.select({ id: turns.id, sessionId: turns.sessionId, status: turns.status })
    .from(turns).where(eq(turns.id, turnId)).limit(1);
  if (!turn) return null;
  const attemptRows = await db.select({ id: turnAttempts.id, attempt: turnAttempts.attempt, status: turnAttempts.status,
    startedAt: turnAttempts.startedAt, finishedAt: turnAttempts.finishedAt })
    .from(turnAttempts).where(eq(turnAttempts.turnId, turnId)).orderBy(desc(turnAttempts.attempt)).limit(51);
  const attempts = attemptRows.slice(0, 50);
  const selectedId = attemptId ?? attempts[0]?.id ?? null;
  const [selected] = selectedId ? await db.select({ id: turnAttempts.id }).from(turnAttempts)
    .where(and(eq(turnAttempts.turnId, turnId), eq(turnAttempts.id, selectedId))).limit(1) : [];
  if (selectedId && !selected) return null;
  const result: TurnDiagnostics = {
    turnId, sessionId: turn.sessionId, status: turn.status, observedAt: new Date().toISOString(),
    selectedAttemptId: selectedId, attempts, terminationReason: null, modelRuns: [], tools: [], approvals: [],
    truncated: { attempts: attemptRows.length > 50, modelRuns: false, tools: false, approvals: false },
    unavailable: ["context_pruning", "plugin_timeline", "tool_step_mapping"],
  };
  if (selectedId) {
    const rows = await db.select({ id: modelRuns.id, step: modelRuns.stepId, provider: modelRuns.provider,
      modelId: modelRuns.modelId, status: modelRuns.status, latencyMs: modelRuns.latencyMs,
      contextManifestId: contextManifests.id })
      .from(modelRuns).innerJoin(turnAttempts, eq(modelRuns.attemptId, turnAttempts.id))
      .leftJoin(contextManifests, and(eq(contextManifests.id, modelRuns.contextManifestId), eq(contextManifests.modelRunId, modelRuns.id)))
      .where(and(eq(turnAttempts.turnId, turnId), eq(turnAttempts.id, selectedId)))
      .orderBy(asc(modelRuns.stepId), asc(modelRuns.createdAt), asc(modelRuns.id)).limit(201);
    const tools = await db.select({ invocationId: toolExecutions.invocationId, name: toolExecutions.name,
      status: toolExecutions.status, startedAt: toolExecutions.startedAt, finishedAt: toolExecutions.finishedAt })
      .from(toolExecutions).where(and(eq(toolExecutions.turnId, turnId), eq(toolExecutions.attemptId, selectedId)))
      .orderBy(asc(toolExecutions.startedAt), asc(toolExecutions.id)).limit(201);
    const approvals = await db.select({ id: toolApprovals.id, toolName: toolApprovals.toolName,
      state: toolApprovals.state, decidedAt: toolApprovals.decidedAt })
      .from(toolApprovals).where(and(eq(toolApprovals.turnId, turnId), eq(toolApprovals.attemptId, selectedId)))
      .orderBy(asc(toolApprovals.id)).limit(201);
    const [terminal] = await db.select({
      reason: sql<unknown>`json_extract(${turnStreamEvents.data}, '$.reason')`,
      code: sql<unknown>`json_extract(${turnStreamEvents.data}, '$.code')`,
    }).from(turnStreamEvents).where(and(eq(turnStreamEvents.turnId, turnId), eq(turnStreamEvents.attemptId, selectedId),
      inArray(turnStreamEvents.eventType, ["done", "error"]))).orderBy(desc(turnStreamEvents.sequence)).limit(1);
    const reasons = new Set(["completed", "cancelled", "deadline_exceeded", "pending_approval", "max_steps",
      "tool_timeout", "execution_error", "model_error", "empty_response", "length", "content_filter", "max_same_tool",
      "host_restarted", "lease_expired", "deletion_gate_blocked", "deletion_blocked", "turn_timeout", "lease_lost",
      "tools_disabled", "repeat_tool", "budget_exhausted", "token_budget_exceeded", "token_or_call_budget_exceeded",
      "model_incomplete", "model_length", "model_content_filter", "model_error", "MODEL_UNAVAILABLE"]);
    const reason = terminal?.reason ?? terminal?.code;
    result.terminationReason = typeof reason === "string" && reasons.has(reason) ? reason : null;
    result.modelRuns = rows.slice(0, 200); result.tools = tools.slice(0, 200); result.approvals = approvals.slice(0, 200);
    result.truncated.modelRuns = rows.length > 200; result.truncated.tools = tools.length > 200; result.truncated.approvals = approvals.length > 200;
  }
  // A concurrent session deletion must not make already-read orphan telemetry
  // queryable. A live run is an observational view, not an atomic execution snapshot.
  const [remaining] = await db.select({ id: turns.id }).from(turns).where(eq(turns.id, turnId)).limit(1);
  return remaining ? result : null;
}
