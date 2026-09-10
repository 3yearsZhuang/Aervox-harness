/**
 * Aervox local single-user context.
 *
 * `workspaceId` and `subjectUserId` are retained temporarily as migration
 * identifiers for the legacy schema. They are not an authorization boundary
 * after CR-030; the durable boundary is the local OS account and API host.
 */
import { TenantAccessViolationError } from "./errors.js";

export interface LocalContext {
  readonly workspaceId: string;
  readonly subjectUserId: string;
  readonly actorId?: string;
}

export function assertLocalContext(context: LocalContext): void {
  if (!context || typeof context !== "object") {
    throw new Error("LocalContext is required for local data access");
  }
  if (!context.workspaceId || context.workspaceId.trim() === "") {
    throw new Error("LocalContext.workspaceId must be a non-empty string");
  }
  if (!context.subjectUserId || context.subjectUserId.trim() === "") {
    throw new Error("LocalContext.subjectUserId must be a non-empty string");
  }
}

export function assertEntityBelongsToLocalContext(
  context: LocalContext,
  entity: { workspaceId: string; subjectUserId: string },
): void {
  assertLocalContext(context);
  if (entity.workspaceId !== context.workspaceId || entity.subjectUserId !== context.subjectUserId) {
    throw new TenantAccessViolationError(
      `Local context mismatch: entity (${entity.workspaceId}, ${entity.subjectUserId}) does not match active local context`,
    );
  }
}
