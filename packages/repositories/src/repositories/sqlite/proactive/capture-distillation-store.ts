/** A complete capture result, its marker and metadata receipt share one writer commit. */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { proactiveAuditEvents, proactiveCaptures, proactiveObservations, proactiveProfileClaims,
  proactiveProfileRevisions, proactiveSourceGrants } from "@aervox/schema";
import type { AervoxDatabase } from "../../../client.js";
import { DomainConflictError } from "../../../errors.js";
import type { ProactiveVaultCipher } from "../../../proactive-vault-crypto.js";
import type { CaptureDistillationInput, CaptureDistillationReceipt } from "../../types/index.js";
import { encrypt } from "./crypto.js";

type DistillationWriter = Parameters<Parameters<AervoxDatabase["transaction"]>[0]>[0];

/** Publication and legacy completion/failure use the same current-source qualification. */
export async function findEligibleCaptureDistillation(tx: DistillationWriter, captureId: string) {
  const [capture] = await tx.select().from(proactiveCaptures).where(eq(proactiveCaptures.id, captureId));
  if (!capture || capture.deletedAt || !["pending", "failed", "blocked", "distilled"].includes(capture.distillationStatus)
    || capture.processingBoundary !== "local_only") return null;
  const [revision] = await tx.select({ status: proactiveProfileRevisions.status, desiredState: proactiveProfileRevisions.desiredState,
    processingBoundary: proactiveProfileRevisions.processingBoundary })
    .from(proactiveProfileRevisions).where(eq(proactiveProfileRevisions.id, capture.revisionId));
  const [source] = await tx.select().from(proactiveSourceGrants).where(and(eq(proactiveSourceGrants.id, capture.sourceGrantId),
    eq(proactiveSourceGrants.revisionId, capture.revisionId), eq(proactiveSourceGrants.sourceKey, capture.sourceKey)));
  if (revision?.status !== "active" || revision.desiredState !== "enabled" || revision.processingBoundary !== "local_only"
    || source?.state !== "granted" || source.processingBoundary !== "local_only") return null;
  return capture;
}

export const captureDistillationReceiptId = (captureId: string): string =>
  `capture_distillation_${createHash("sha256").update(captureId).digest("hex")}`;

/** Processor exception text can contain source content; only fixed metadata codes are durable. */
export function captureDistillationFailureCode(reason: string | undefined): string {
  return ["capture_distillation_invalid_draft", "capture_distillation_source_unavailable",
    "capture_distillation_receipt_unavailable", "capture_distillation_intent_mismatch",
    "capture_distillation_result_unavailable"].includes(reason ?? "")
    ? reason! : "capture_distillation_failed";
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  }
  throw new DomainConflictError("capture_distillation_invalid_draft");
}

function snapshot(input: CaptureDistillationInput): CaptureDistillationInput {
  if (![input.captureId, input.revisionId, input.sourceGrantId, input.sourceKey, input.checksum, input.processorId]
    .every(value => typeof value === "string" && value.trim().length > 0)
    || !Array.isArray(input.outputs) || input.outputs.length < 1 || input.outputs.length > 100) {
    throw new DomainConflictError("capture_distillation_invalid_draft");
  }
  for (const output of input.outputs) {
    if (!output || ![output.claimType, output.subjectKey, output.content].every(value => typeof value === "string" && value.trim().length > 0)
      || !Number.isFinite(output.confidence) || !Array.isArray(output.evidenceRefs)
      || (output.structured !== undefined && (!output.structured || Array.isArray(output.structured) || typeof output.structured !== "object"))
      || (output.observationOnly !== undefined && typeof output.observationOnly !== "boolean")) {
      throw new DomainConflictError("capture_distillation_invalid_draft");
    }
  }
  try {
    const encoded = JSON.stringify(canonical({ captureId: input.captureId, revisionId: input.revisionId, sourceGrantId: input.sourceGrantId,
      sourceKey: input.sourceKey, checksum: input.checksum, processorId: input.processorId, outputs: input.outputs.map(output => ({
      claimType: output.claimType, subjectKey: output.subjectKey, content: output.content,
      confidence: Math.max(0, Math.min(100, Math.floor(output.confidence))), evidenceRefs: output.evidenceRefs,
      structured: output.structured ?? {}, observationOnly: output.observationOnly ?? false,
    })) }));
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error("draft_limit");
    return JSON.parse(encoded) as CaptureDistillationInput;
  } catch { throw new DomainConflictError("capture_distillation_invalid_draft"); }
}

export async function publishCaptureDistillation(
  db: AervoxDatabase, cipher: ProactiveVaultCipher | undefined, submitted: CaptureDistillationInput,
): Promise<CaptureDistillationReceipt> {
  // Snapshot before awaiting any DB operation; caller mutation cannot change an admitted batch.
  const input = snapshot(submitted);
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const receiptId = captureDistillationReceiptId(input.captureId);
  const memoryIds = input.outputs.map((output, index) => `${output.observationOnly ? "pobs" : "pclaim"}_${input.captureId}_${index + 1}`);
  return db.transaction(async tx => {
    const capture = await findEligibleCaptureDistillation(tx, input.captureId);
    if (!capture || capture.revisionId !== input.revisionId
      || capture.sourceGrantId !== input.sourceGrantId || capture.sourceKey !== input.sourceKey || capture.checksum !== input.checksum) {
      throw new DomainConflictError("capture_distillation_source_unavailable");
    }
    const [event] = await tx.select().from(proactiveAuditEvents).where(eq(proactiveAuditEvents.id, receiptId));
    if (event) {
      let receipt: { version?: number; digest?: string; memoryIds?: string[]; processorId?: string; outputCount?: number };
      try {
        const parsed: unknown = JSON.parse(event.payloadJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid receipt");
        receipt = parsed;
      } catch { throw new DomainConflictError("capture_distillation_receipt_unavailable"); }
      if (event.eventType !== "capture.distilled" || event.resourceType !== "capture" || event.resourceId !== capture.id
        || event.revisionId !== capture.revisionId || event.processingBoundary !== "local_only" || receipt.version !== 1
        || capture.distillationStatus !== "distilled" || JSON.stringify(receipt.memoryIds) !== capture.distilledMemoryIdsJson) {
        throw new DomainConflictError("capture_distillation_receipt_unavailable");
      }
      if (receipt.digest !== digest || receipt.processorId !== input.processorId || receipt.outputCount !== input.outputs.length
        || JSON.stringify(receipt.memoryIds) !== JSON.stringify(memoryIds)) throw new DomainConflictError("capture_distillation_intent_mismatch");
      return { captureId: capture.id, processorId: input.processorId, checksum: input.checksum,
        outputCount: input.outputs.length, memoryIds, created: false };
    }
    // Old independently written facts cannot establish which outputs a processor intended.
    const [oldClaim] = await tx.select({ id: proactiveProfileClaims.id }).from(proactiveProfileClaims)
      .where(sql`EXISTS (SELECT 1 FROM json_each(${proactiveProfileClaims.evidenceCaptureIdsJson}) WHERE value = ${capture.id})`).limit(1);
    const prefix = `pobs_${capture.id}_`;
    const [oldObservation] = await tx.select({ id: proactiveObservations.id }).from(proactiveObservations)
      .where(sql`substr(${proactiveObservations.id}, 1, ${prefix.length}) = ${prefix}
        AND substr(${proactiveObservations.id}, ${prefix.length + 1}) <> ''
        AND substr(${proactiveObservations.id}, ${prefix.length + 1}) NOT GLOB '*[^0-9]*'`).limit(1);
    if (oldClaim || oldObservation || capture.distillationStatus === "distilled" || capture.distilledMemoryIdsJson !== "[]") {
      throw new DomainConflictError("capture_distillation_receipt_unavailable");
    }
    const now = new Date().toISOString();
    for (const [index, output] of input.outputs.entries()) {
      const observationId = `pobs_${capture.id}_${index + 1}`;
      const payload = { ...output.structured, captureId: capture.id, content: output.content,
        confidence: output.confidence, evidenceRefs: output.evidenceRefs };
      await tx.insert(proactiveObservations).values({ id: observationId, revisionId: capture.revisionId,
        sourceGrantId: capture.sourceGrantId, sourceKey: capture.sourceKey, observationType: output.claimType,
        subjectKey: encrypt(output.subjectKey, "observation", observationId, cipher)!,
        payloadJson: encrypt(JSON.stringify(payload), "observation", observationId, cipher)!, checksum: capture.checksum,
        algorithmVersion: input.processorId, processingBoundary: "local_only", observedAt: capture.observedAt,
        normalizedAt: now, createdAt: now, updatedAt: now });
      await tx.insert(proactiveAuditEvents).values({ id: `${observationId}_audit_normalized`, revisionId: capture.revisionId,
        eventType: "observation.normalized", actorId: "local-observation-adapter", resourceType: "observation", resourceId: observationId,
        payloadJson: JSON.stringify({ sourceKey: capture.sourceKey, checksum: capture.checksum, algorithmVersion: input.processorId }),
        processingBoundary: "local_only", occurredAt: now, createdAt: now });
      if (!output.observationOnly) {
        const claimId = `pclaim_${capture.id}_${index + 1}`;
        await tx.insert(proactiveProfileClaims).values({ id: claimId, revisionId: capture.revisionId, claimType: output.claimType,
          subjectKey: encrypt(output.subjectKey, "claim", claimId, cipher)!, content: encrypt(output.content, "claim", claimId, cipher)!,
          state: "inferred", confidence: output.confidence, algorithmVersion: input.processorId, processingBoundary: "local_only",
          evidenceCaptureIdsJson: JSON.stringify([capture.id]), sourceGrantIdsJson: JSON.stringify([capture.sourceGrantId]),
          evidenceRefsJson: encrypt(JSON.stringify([...output.evidenceRefs, { observationId, algorithmVersion: input.processorId }]), "claim", claimId, cipher)!,
          createdAt: now, updatedAt: now });
      }
    }
    await tx.update(proactiveCaptures).set({ distillationStatus: "distilled", distilledAt: now,
      distilledMemoryIdsJson: JSON.stringify(memoryIds), lastDistillationError: null, retentionBlockedAt: null, updatedAt: now })
      .where(eq(proactiveCaptures.id, capture.id));
    await tx.insert(proactiveAuditEvents).values({ id: receiptId, revisionId: capture.revisionId, eventType: "capture.distilled",
      actorId: "local-memory-pipeline", resourceType: "capture", resourceId: capture.id,
      payloadJson: JSON.stringify({ version: 1, digest, processorId: input.processorId, outputCount: input.outputs.length, memoryIds }),
      processingBoundary: "local_only", occurredAt: now, createdAt: now });
    return { captureId: capture.id, processorId: input.processorId, checksum: input.checksum,
      outputCount: input.outputs.length, memoryIds, created: true };
  }, { behavior: "immediate" });
}
