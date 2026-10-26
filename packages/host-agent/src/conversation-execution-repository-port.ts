import type { AgentStreamEventInput, ExecutionStorePort, ToolExecutionRecord } from "@aervox/core/browser";

type StoreInput<Key extends keyof ExecutionStorePort> = NonNullable<ExecutionStorePort[Key]> extends
  (input: infer Input) => unknown ? Input : never;

/** Persisted event envelope projected by the execution adapter; no driver types. */
export interface ConversationStreamEventRow {
  id: string;
  turnId: string;
  sequence: number;
  eventType: string;
  payloadVersion: number;
  data: unknown;
  occurredAt: string;
  attemptId?: string | null;
  safetyDecision?: string | null;
}

/** Only a trusted host can classify its own repository error identity.
 * With no classifier, all errors propagate unchanged. Never classify by name.
 */
export interface ConversationExecutionStoreOptions {
  isFencingMismatchError?: (error: unknown) => error is Error;
}

/** Durable command authority supplied by the host, not implemented by the
 * neutral adapter. Atomic methods must preserve the repository's transaction,
 * deletion/source checks, fencing, idempotency and failure behavior; they cannot
 * be reconstructed as separate bridge writes. Context is the host's existing
 * access context, never a new tenant or persistence partition.
 */
export interface ConversationExecutionRepositoryPort<Context> {
  claimTurnAttempt(ctx: Context, input: StoreInput<"claimTurnAttempt"> & { leaseId: string }):
    Promise<{ ok: boolean; fencingToken: number; leaseId: string; leaseExpiresAt: string }>;
  renewTurnAttemptLease(ctx: Context, input: StoreInput<"renewAttemptLease">): Promise<boolean>;
  getTurn(ctx: Context, turnId: string): Promise<{ lastSequence: number } | null>;
  getStreamEventHighWater(ctx: Context, turnId: string): Promise<number>;
  appendStreamEvent(ctx: Context, input: {
    id: string; turnId: string; sequence: number; eventType: string; data: unknown; occurredAt: string;
    attemptId?: string; safetyDecision?: AgentStreamEventInput["safetyDecision"]; expectedFencingToken?: number;
  }): Promise<ConversationStreamEventRow>;
  getStreamEvents(ctx: Context, turnId: string, afterSequence: number): Promise<ConversationStreamEventRow[]>;
  finalizeTurnAttempt(ctx: Context, input: StoreInput<"finalizeAttempt">): Promise<{ id: string } | null>;
  recordToolOutcomeAtomically(ctx: Context, input: StoreInput<"recordToolOutcome">): Promise<boolean>;
  finalizeAttemptWithEventAtomically(ctx: Context, input: Omit<StoreInput<"finalizeAttemptWithEvent">, "safetyDecision"> & {
    safetyDecision: string | null;
  }): Promise<boolean>;
  recordSafeSegmentAtomically(ctx: Context, input: StoreInput<"recordSafeSegment">): Promise<boolean>;
  recordSafeSegmentsAtomically(ctx: Context, inputs: StoreInput<"recordSafeSegments">): Promise<boolean>;
  listCommittedSegments(ctx: Context, turnId: string):
    Promise<Array<{ id: string; sequence: number; text: string; streamEventId: string | null }>>;
  requestCancelTurnAttempt(ctx: Context, input: StoreInput<"requestCancelAttempt">):
    Promise<{ ok: boolean; reason?: "not_found" | "already_finalized" }>;
  getTurnAttemptStatus(ctx: Context, input: { turnId: string; attemptId: string }): Promise<string | null>;
  recordToolExecution(ctx: Context, input: Omit<ToolExecutionRecord, "error"> & { error: string | null }): Promise<unknown>;
  reserveToolExecution(ctx: Context, input: StoreInput<"reserveToolExecution">): Promise<{ ok: boolean; alreadyReserved: boolean }>;
  updateToolExecutionResult(ctx: Context, input: StoreInput<"updateToolExecutionResult">): Promise<{ ok: boolean }>;
}
