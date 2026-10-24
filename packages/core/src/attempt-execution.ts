import { ControlContext } from "./control-context.js";
import { LeaseHeartbeat } from "./lease-heartbeat.js";
import { LeaseLostError } from "./errors.js";
import { createTurnTerminator } from "./turn-terminator.js";
import type { DeletionGatePort, ExecutionStorePort } from "./ports.js";

export interface AttemptIdentity { turnId: string; attemptId: string; sessionId: string }
export interface AttemptExecutionOptions {
  execution: ExecutionStorePort;
  controlContext?: ControlContext;
  deletionGate?: DeletionGatePort;
  expectedFencingToken?: number;
  maxTurnDurationMs?: number;
  leaseTtlMs?: number;
  leaseHeartbeatIntervalMs?: number;
  startedAt?: number;
  stepsTaken?: () => number;
  beforeComplete?: (signal?: AbortSignal) => Promise<void>;
}

/** The lease and cancellation scope is shared by native and external loop drivers. */
export async function claimAttemptExecution(input: AttemptIdentity, options: AttemptExecutionOptions) {
  const { execution, deletionGate } = options;
  const control = options.controlContext?.deriveSubtask() ?? new ControlContext();
  const claim = await execution.claimTurnAttempt({ ...input, expectedFencingToken: options.expectedFencingToken ?? 0 })
    .catch(error => { control.dispose(); throw error; });
  if (!claim.ok) { control.dispose(); return { ok: false as const, reason: claim.reason }; }
  const startedAt = options.startedAt ?? Date.now();
  const maxTurnDurationMs = options.maxTurnDurationMs ?? 0;
  const ttlMs = options.leaseTtlMs ?? 60_000;
  const intervalMs = options.leaseHeartbeatIntervalMs ?? Math.floor(ttlMs / 2);
  const heartbeat = claim.leaseId && intervalMs > 0 ? new LeaseHeartbeat({
    intervalMs,
    renew: () => execution.renewAttemptLease({ attemptId: input.attemptId, leaseId: claim.leaseId!, expectedFencingToken: claim.fencingToken, ttlMs }),
  }) : undefined;
  let interruption: string | undefined;
  let failure: unknown;
  let monitoring = true;
  let checking = false;
  const checkFailure = () => { heartbeat?.throwIfLost(); if (failure) throw failure; };
  const terminator = createTurnTerminator({
    ...input, execution, control, deletionGate, claimFencingToken: claim.fencingToken,
    startedAt, maxTurnDurationMs,
    get stepsTaken() { return options.stepsTaken?.() ?? 0; },
    interruptionReason: () => interruption, checkFailure, beforeComplete: options.beforeComplete,
  });
  const removeLost = heartbeat?.onLost(() => control.abort(new LeaseLostError()));
  heartbeat?.start();
  const monitor = setInterval(() => {
    if (!monitoring || checking || control.isAborted()) return;
    checking = true;
    void (async () => {
      if (await execution.isCancelRequested(input)) interruption = "cancelled";
      else if (deletionGate && await deletionGate.isBlocked(input)) interruption = "deletion_blocked";
      else if (maxTurnDurationMs > 0 && Date.now() - startedAt >= maxTurnDurationMs) interruption = "turn_timeout";
      if (monitoring && interruption) control.abort(new Error(interruption));
    })().catch(error => { if (monitoring) { failure = error; control.abort(error); } }).finally(() => { checking = false; });
  }, 50);
  return {
    ok: true as const, claim, control, terminator, heartbeat,
    get interruption() { return interruption; },
    get failure() { return failure; },
    get leaseLost() { return heartbeat?.lost ?? false; },
    checkFailure,
    stopMonitoring() { monitoring = false; clearInterval(monitor); removeLost?.(); heartbeat?.stop(); },
    dispose() { monitoring = false; clearInterval(monitor); removeLost?.(); heartbeat?.stop(); control.dispose(); },
  };
}
