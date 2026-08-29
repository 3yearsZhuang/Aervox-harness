/** CAP-033 proactive control-plane and local data API schemas. */
import { z } from "zod";
import { PROFILE_SOURCE_IDS } from "./proactive.js";

export const proactiveSourceIdSchema = z.enum(PROFILE_SOURCE_IDS);
export const proactiveSourceGrantStateSchema = z.enum([
  "requested",
  "granted",
  "denied",
  "revoked",
  "expired",
]);
export const proactiveDesiredStateSchema = z.enum(["enabled", "paused", "revoked"]);
export const proactiveClaimStateSchema = z.enum([
  "observed",
  "inferred",
  "user_asserted",
  "confirmed",
  "rejected",
]);
export const proactiveActionStateSchema = z.enum([
  "pending",
  "approved",
  "running",
  "executed",
  "denied",
  "failed",
  "revoked",
]);

export const proactiveSourceGrantInputSchema = z.object({
  id: z.string().min(1).optional(),
  sourceKey: proactiveSourceIdSchema,
  purpose: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  osCapability: z.string().min(1).optional(),
  state: proactiveSourceGrantStateSchema.default("requested"),
  mandatory: z.boolean().default(true),
  grantVersion: z.number().int().positive().default(1),
  metadata: z.unknown().optional(),
  grantedAt: z.string().datetime().nullable().optional(),
  lastVerifiedAt: z.string().datetime().nullable().optional(),
});

export const proactiveAuthorizeRequestSchema = z.object({
  id: z.string().min(1).optional(),
  acknowledged: z.literal(true),
  fullAccessConfirmed: z.literal(true).optional(),
  toolApprovalMode: z.literal("full_access").optional(),
  profileVersion: z.literal("full_profile_v1").default("full_profile_v1"),
  deviceId: z.string().min(1),
  manifest: z.unknown().optional(),
  grantSetHash: z.string().min(1).nullable().optional(),
  sources: z.array(proactiveSourceGrantInputSchema).optional(),
}).refine(
  (value) => value.fullAccessConfirmed === true || value.toolApprovalMode === "full_access",
  { message: "full_access_confirmation_required" },
);

export const proactiveDesiredStateRequestSchema = z.object({
  desiredState: proactiveDesiredStateSchema,
  revisionId: z.string().min(1).optional(),
});

export const proactiveActivationRequestSchema = z.object({
  id: z.string().min(1).optional(),
  revisionId: z.string().min(1),
  deviceId: z.string().min(1),
  epoch: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
  localReady: z.boolean(),
  fullAccessSnapshot: z.boolean(),
  metadata: z.unknown().optional(),
});

export const proactiveCaptureRequestSchema = z.object({
  id: z.string().min(1).optional(),
  revisionId: z.string().min(1),
  sourceGrantId: z.string().min(1),
  sourceKey: proactiveSourceIdSchema,
  contentType: z.string().min(1),
  payloadText: z.string().optional(),
  payload: z.unknown().optional(),
  checksum: z.string().min(1).optional(),
  byteSize: z.number().int().nonnegative().optional(),
  observedAt: z.string().datetime().optional(),
  ingestedAt: z.string().datetime().optional(),
}).refine((value) => value.payloadText !== undefined || value.payload !== undefined, {
  message: "payload or payloadText is required",
});

export const proactiveObservationRequestSchema = z.object({
  id: z.string().min(1).optional(),
  revisionId: z.string().min(1),
  sourceGrantId: z.string().min(1),
  sourceKey: proactiveSourceIdSchema,
  observationType: z.string().min(1),
  subjectKey: z.string().min(1),
  payload: z.unknown().optional(),
  checksum: z.string().min(1),
  algorithmVersion: z.string().min(1).optional(),
  observedAt: z.string().datetime().optional(),
  normalizedAt: z.string().datetime().optional(),
});

export const proactiveClaimRequestSchema = z.object({
  id: z.string().min(1).optional(),
  revisionId: z.string().min(1),
  claimType: z.string().min(1),
  subjectKey: z.string().min(1),
  content: z.string().min(1),
  state: proactiveClaimStateSchema.optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  evidenceCaptureIds: z.array(z.string().min(1)).optional(),
  evidenceRefs: z.array(z.unknown()).optional(),
  sourceGrantIds: z.array(z.string().min(1)).optional(),
});

export const proactiveActionRequestSchema = z.object({
  id: z.string().min(1).optional(),
  revisionId: z.string().min(1),
  activationLeaseId: z.string().min(1).nullable().optional(),
  actionType: z.string().min(1),
  target: z.string().min(1),
  request: z.unknown().optional(),
  authorizationScope: z.string().min(1),
  actionGrantRevision: z.string().min(1),
  reversible: z.boolean().default(true),
  external: z.boolean().default(false),
});

export const proactiveExportRequestSchema = z.object({ includeRaw: z.boolean().default(false) });

export const proactiveStatusResponseSchema = z.object({
  version: z.literal("full_profile_v1"),
  processingBoundary: z.literal("local_only"),
  exportAvailable: z.literal(true),
  desiredState: z.enum(["none", "enabled", "paused", "revoking", "revoked"]),
  effectiveState: z.enum(["inactive", "configuring", "active", "limited", "suspended", "revoking"]),
  reason: z.string(),
  revision: z.unknown().nullable(),
  sources: z.array(z.unknown()),
  activationLease: z.unknown().nullable(),
  mandatorySources: z.object({
    total: z.number().int().nonnegative(),
    granted: z.number().int().nonnegative(),
    missing: z.array(z.string()),
  }),
  expiredUndistilledCaptures: z.number().int().nonnegative(),
});

export const proactiveExportResponseSchema = z.object({
  manifest: z.object({
    schemaVersion: z.string(),
    exportedAt: z.string().datetime(),
    processingBoundary: z.literal("local_only"),
    includeRaw: z.boolean(),
    checksum: z.string(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
  }),
  data: z.unknown(),
});

const proactiveRecordListSchema = z.array(z.record(z.string(), z.unknown()));

export const proactiveConnectionResponseSchema = z.object({
  id: z.string(),
  provider: z.string(),
  displayName: z.string(),
  endpoint: z.string().nullable().optional(),
  authType: z.string(),
  scopes: z.array(z.string()),
  settings: z.record(z.string(), z.unknown()),
  state: z.string(),
  lastSyncAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  hasCredential: z.boolean(),
});

export const proactiveIntelligenceDashboardSchema = z.object({
  timeline: proactiveRecordListSchema,
  projects: proactiveRecordListSchema,
  commitments: proactiveRecordListSchema,
  workflows: proactiveRecordListSchema,
  triggers: proactiveRecordListSchema,
  verifications: proactiveRecordListSchema,
  conflicts: proactiveRecordListSchema,
  preparations: proactiveRecordListSchema,
  attention: proactiveRecordListSchema,
  drift: proactiveRecordListSchema,
  relationships: proactiveRecordListSchema,
  scenes: proactiveRecordListSchema,
  reviews: proactiveRecordListSchema,
  connections: z.array(proactiveConnectionResponseSchema),
  homeEntities: proactiveRecordListSchema,
  health: proactiveRecordListSchema,
});

export const homeAssistantEntityAuthorizationSchema = z.object({
  entityId: z.string().min(3),
  enabled: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  allowedOps: z.array(z.string().regex(/^[a-z0-9_.]+$/)).optional(),
});

export const homeAssistantConnectionRequestSchema = z.object({
  id: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  endpoint: z.url(),
  accessToken: z.string().min(8),
  subscriptionEnabled: z.boolean().default(true),
  entities: z.array(homeAssistantEntityAuthorizationSchema).optional(),
});

export const homeAssistantEntityPatchSchema = homeAssistantEntityAuthorizationSchema.omit({entityId: true});

export const homeAssistantCallServiceSchema = z.object({
  entityId: z.string().min(3),
  service: z.string().regex(/^[a-z0-9_]+$/),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const xiaomiHealthConnectionRequestSchema = z.object({
  id: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  apiBaseUrl: z.url(),
  accessToken: z.string().min(8),
  refreshToken: z.string().min(1).optional(),
  tokenEndpoint: z.url().optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  dailyPath: z.string().min(1).optional(),
  scopes: z.array(z.string()).optional(),
  localDate: z.iso.date().optional(),
});

export const proactiveSyncDateSchema = z.object({localDate: z.iso.date().optional()});
