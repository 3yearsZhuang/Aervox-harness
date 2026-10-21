import { z } from "zod";
import type { ApiEndpoint } from "./http-api.js";
import {
  addressFormSchema, proactivenessSchema, reminderCadenceSchema, toneSchema,
  savePersonaPreferencesSchema, updatePersonaPreferencesSchema,
} from "./schemas.js";

/** The local API returns no workspace/user identity fields. */
export const storedPreferencesSchema = z.object({
  id: z.string().min(1),
  tone: toneSchema,
  proactiveness: proactivenessSchema,
  addressForm: addressFormSchema,
  reminderCadence: reminderCadenceSchema,
  version: z.number().int().positive(),
  skipped: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** An unconfigured read remains a transient default, without inventing a stored row. */
export const preferencesResponseSchema = z.union([
  storedPreferencesSchema,
  z.object({
    id: z.null(),
    tone: z.literal("neutral"),
    proactiveness: z.literal("medium"),
    addressForm: z.literal("none"),
    reminderCadence: z.literal("moderate"),
    version: z.literal(0),
    skipped: z.literal(false),
  }),
]);

export const preferencesApi = {
  get: {
    method: "get", path: "/v1/preferences", operationId: "getPreferences",
    summary: "读取本地偏好或中性默认值", tags: ["Preferences"], response: preferencesResponseSchema,
  },
  save: {
    method: "post", path: "/v1/preferences", operationId: "savePreferences",
    summary: "填写或跳过偏好问卷", tags: ["Preferences"],
    body: savePersonaPreferencesSchema, response: storedPreferencesSchema, status: 201,
    validationErrorMessage: "Validation failed", errors: { 400: "Validation failed" },
  },
  update: {
    method: "patch", path: "/v1/preferences", operationId: "updatePreferences",
    summary: "更新本地偏好", tags: ["Preferences"],
    body: updatePersonaPreferencesSchema, response: storedPreferencesSchema,
    validationErrorMessage: "Validation failed", errors: { 400: "Validation failed" },
  },
  reset: {
    method: "post", path: "/v1/preferences/reset", operationId: "resetPreferences",
    summary: "重置为中性偏好", tags: ["Preferences"], response: storedPreferencesSchema,
  },
} as const satisfies Record<string, ApiEndpoint>;

export type PreferencesResponse = z.output<typeof preferencesResponseSchema>;
export type SavePreferencesRequest = z.input<typeof savePersonaPreferencesSchema>;
export type UpdatePreferencesRequest = z.input<typeof updatePersonaPreferencesSchema>;
