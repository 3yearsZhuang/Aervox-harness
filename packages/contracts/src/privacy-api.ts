import { z } from "zod";
import type { ApiEndpoint } from "./http-api.js";
import { createDeletionRequestSchema } from "./privacy-schemas.js";

/** The authenticated host supplies the audit actor; unknown legacy fields are ignored. */
export const grantConsentRequestSchema = z.object({
  purpose: z.string().min(1),
  scope: z.string().min(1),
  policyVersion: z.string().min(1),
});

export const consentQuerySchema = z.object({
  purpose: z.string().optional(),
  scope: z.string().optional(),
});

export const consentGrantSchema = z.object({
  id: z.string().min(1),
  actorId: z.string(),
  purpose: z.string().min(1),
  scope: z.string().min(1),
  policyVersion: z.string().min(1),
  grantedAt: z.string(),
  revokedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});

export const activeConsentResponseSchema = z.union([
  z.object({ purpose: z.string().min(1), scope: z.string().min(1), active: z.boolean() }),
  z.object({ active: z.literal(false) }).strict(),
]);

export const deletionRequestResponseSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  idempotencyKey: z.string().min(1),
  requestedAt: z.string(),
  effectiveAt: z.string().nullable().optional(),
  status: z.string().min(1),
  attemptCount: z.number().int().nonnegative(),
  lastError: z.string().nullable().optional(),
  ownerModule: z.string().min(1),
  lastVerifiedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const privacyApi = {
  grantConsent: {
    method: "post", path: "/v1/consent", operationId: "grantConsent",
    summary: "创建本地用途授权", tags: ["Privacy"], body: grantConsentRequestSchema, bodyRequired: true,
    response: consentGrantSchema, status: 201,
    validationErrorMessage: "purpose, scope and policyVersion are required",
    errors: { 400: "Invalid consent grant" },
  },
  revokeConsent: {
    method: "post", path: "/v1/consent/{grantId}/revoke", operationId: "revokeConsent",
    summary: "撤销本地用途授权", tags: ["Privacy"],
    params: z.object({ grantId: z.string().min(1) }), response: consentGrantSchema,
    errors: { 400: "Invalid grant id", 404: "consent grant not found" },
  },
  activeConsent: {
    method: "get", path: "/v1/consent", operationId: "getActiveConsent",
    summary: "查询本地用途授权，缺少用途或范围时返回未授权", tags: ["Privacy"],
    query: consentQuerySchema, response: activeConsentResponseSchema,
    errors: { 400: "Invalid consent query" },
  },
  createDeletion: {
    method: "post", path: "/v1/deletions", operationId: "createDeletionRequest",
    summary: "受理幂等删除请求及显式目标，不代表删除完成", tags: ["Privacy"],
    body: createDeletionRequestSchema, bodyRequired: true, response: deletionRequestResponseSchema, status: 202,
    validationErrorMessage: "invalid deletion request",
    errors: { 400: "Invalid deletion request or conflicting ownerModule", 409: "Deletion idempotency key belongs to a different intent" },
  },
} as const satisfies Record<string, ApiEndpoint>;

export type GrantConsentRequest = z.input<typeof grantConsentRequestSchema>;
export type ConsentQuery = z.input<typeof consentQuerySchema>;
export type CreateDeletionRequest = z.input<typeof createDeletionRequestSchema>;
