/**
 * CAP-033 FullProfileActionGrant runtime gate.
 *
 * The model cannot grant itself permissions. Every proactive tool action is admitted only when
 * the current local profile revision, activation lease and all matching action scopes are active.
 */
import type {
  IProactiveProfileRepository,
  ProactiveActionModel,
  TenantContext,
} from "@aervox/database";

export const PROACTIVE_ACTION_DECIDER_PREFIX = "permission:proactive_action:";

export type ProactiveActionScope =
  | "action.local"
  | "action.external"
  | "action.privileged"
  | "action.irreversible";

export interface ProactiveToolActionDescriptor {
  turnId: string;
  attemptId: string;
  invocationId: string;
  toolId: string;
  toolName: string;
  category?: string | null;
  safetyLevel: string;
  requiredPermissions?: unknown;
  arguments: unknown;
  irreversible?: boolean;
}

export type ProactiveActionAuthorization =
  | {
      authorized: true;
      action: ProactiveActionModel;
      scopes: ProactiveActionScope[];
      decidedBy: string;
    }
  | { authorized: false; reason: string; scopes: ProactiveActionScope[] };

function stringPermissions(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function resolveProactiveActionScopes(
  descriptor: Pick<
    ProactiveToolActionDescriptor,
    "category" | "safetyLevel" | "requiredPermissions" | "irreversible"
  >,
): ProactiveActionScope[] {
  const permissions = new Set(stringPermissions(descriptor.requiredPermissions));
  const scopes = new Set<ProactiveActionScope>(["action.local"]);
  if (descriptor.category === "external" || permissions.has("action.external")) {
    scopes.add("action.external");
  }
  if (descriptor.safetyLevel === "privileged" || permissions.has("action.privileged")) {
    scopes.add("action.privileged");
  }
  if (descriptor.irreversible === true || permissions.has("action.irreversible")) {
    scopes.add("action.irreversible");
  }
  return [...scopes];
}

let sequence = 0;
const nextActionId = (invocationId: string): string => {
  sequence += 1;
  const safeInvocation = invocationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-48);
  return `pro_action_${safeInvocation}_${Date.now().toString(36)}_${sequence.toString(36)}`;
};

export class ProactiveActionAuthorizer {
  constructor(private readonly repository: IProactiveProfileRepository) {}

  async authorize(
    tenant: TenantContext,
    descriptor: ProactiveToolActionDescriptor,
  ): Promise<ProactiveActionAuthorization> {
    const scopes = resolveProactiveActionScopes(descriptor);
    const status = await this.repository.getEffectiveStatus(tenant);
    if (status.effectiveState !== "active" || !status.revision || !status.activationLease) {
      return { authorized: false, reason: `proactive_mode_${status.reason}`, scopes };
    }
    const grants = new Map(status.sources.map((grant) => [grant.sourceKey, grant]));
    const missing = scopes.filter((scope) => grants.get(scope)?.state !== "granted");
    if (missing.length > 0) {
      return { authorized: false, reason: `proactive_action_grant_missing:${missing.join(",")}`, scopes };
    }

    const actionGrantRevision = scopes
      .map((scope) => {
        const grant = grants.get(scope)!;
        return `${scope}@${grant.grantVersion}`;
      })
      .join("+");
    const action = await this.repository.createAction(tenant, {
      id: nextActionId(descriptor.invocationId),
      revisionId: status.revision.id,
      activationLeaseId: status.activationLease.id,
      actionType: descriptor.toolName,
      target: descriptor.toolId,
      request: {
        turnId: descriptor.turnId,
        attemptId: descriptor.attemptId,
        invocationId: descriptor.invocationId,
        arguments: descriptor.arguments,
      },
      authorizationScope: scopes.join(","),
      actionGrantRevision,
      requestedBy: `agent:${descriptor.attemptId}`,
      reversible: !scopes.includes("action.irreversible"),
      external: scopes.includes("action.external"),
    });
    const decidedBy = `${PROACTIVE_ACTION_DECIDER_PREFIX}${status.revision.id}`;
    const approved = await this.repository.updateAction(tenant, action.id, {
      state: "approved",
      actorId: decidedBy,
    });
    if (!approved) return { authorized: false, reason: "proactive_action_approval_not_recorded", scopes };
    return { authorized: true, action: approved, scopes, decidedBy };
  }

  async markRunning(tenant: TenantContext, actionId: string): Promise<void> {
    await this.repository.updateAction(tenant, actionId, {
      state: "running",
      actorId: "proactive-action-runtime",
    });
  }

  async markExecuted(tenant: TenantContext, actionId: string, outcome: unknown): Promise<void> {
    await this.repository.updateAction(tenant, actionId, {
      state: "executed",
      actorId: "proactive-action-runtime",
      outcome,
    });
  }

  async markFailed(tenant: TenantContext, actionId: string, error: string): Promise<void> {
    await this.repository.updateAction(tenant, actionId, {
      state: "failed",
      actorId: "proactive-action-runtime",
      error: error.slice(0, 500),
    });
  }
}
