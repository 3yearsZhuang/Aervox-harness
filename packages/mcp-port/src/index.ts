/** MCP tool discovery and server-side policy intersection. */
import { createHash } from "node:crypto";

export type McpTool = {
  id: string;
  serverId: string;
  name: string;
  description?: string;
  inputSchema: unknown;
  scopes: string[];
  healthy: boolean;
  authorized: boolean;
  revoked: boolean;
  killSwitch: boolean;
};

export type McpPolicyInput = {
  allowedMcpToolIds?: readonly string[];
  tools: readonly McpTool[];
  consentedToolIds?: ReadonlySet<string>;
  workspaceAllowedToolIds?: ReadonlySet<string>;
  safetyAllowedToolIds?: ReadonlySet<string>;
};

export type McpPolicyResult = {
  tools: McpTool[];
  excluded: Array<{ id: string; reason: string }>;
};

export type McpInvocationAudit = {
  toolId: string;
  personaRevisionId?: string;
  authorizationSnapshot: string;
  parametersChecksum: string;
  idempotencyKey: string;
  status: "requested" | "completed" | "failed" | "denied";
  occurredAt: string;
};

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function toolParametersChecksum(parameters: unknown): string {
  return createHash("sha256").update(stableJson(parameters)).digest("hex");
}

export function selectMcpTools(input: McpPolicyInput): McpPolicyResult {
  const allowed = input.allowedMcpToolIds === undefined
    ? undefined
    : new Set(input.allowedMcpToolIds);
  const result: McpTool[] = [];
  const excluded: Array<{ id: string; reason: string }> = [];

  for (const tool of input.tools) {
    if (allowed && !allowed.has(tool.id)) {
      excluded.push({ id: tool.id, reason: "persona_allowlist" });
      continue;
    }
    if (!tool.authorized) {
      excluded.push({ id: tool.id, reason: "not_authorized" });
      continue;
    }
    if (tool.revoked) {
      excluded.push({ id: tool.id, reason: "revoked" });
      continue;
    }
    if (tool.killSwitch) {
      excluded.push({ id: tool.id, reason: "kill_switch" });
      continue;
    }
    if (!tool.healthy) {
      excluded.push({ id: tool.id, reason: "unhealthy" });
      continue;
    }
    if (input.consentedToolIds && !input.consentedToolIds.has(tool.id)) {
      excluded.push({ id: tool.id, reason: "consent" });
      continue;
    }
    if (input.workspaceAllowedToolIds && !input.workspaceAllowedToolIds.has(tool.id)) {
      excluded.push({ id: tool.id, reason: "workspace_policy" });
      continue;
    }
    if (input.safetyAllowedToolIds && !input.safetyAllowedToolIds.has(tool.id)) {
      excluded.push({ id: tool.id, reason: "safety_policy" });
      continue;
    }
    result.push(tool);
  }
  return { tools: result, excluded };
}

export function createMcpInvocationAudit(input: {
  toolId: string;
  personaRevisionId?: string;
  authorizationSnapshot: unknown;
  parameters: unknown;
  idempotencyKey: string;
  status?: McpInvocationAudit["status"];
}): McpInvocationAudit {
  return {
    toolId: input.toolId,
    ...(input.personaRevisionId ? { personaRevisionId: input.personaRevisionId } : {}),
    authorizationSnapshot: JSON.stringify(input.authorizationSnapshot),
    parametersChecksum: toolParametersChecksum(input.parameters),
    idempotencyKey: input.idempotencyKey,
    status: input.status ?? "requested",
    occurredAt: new Date().toISOString(),
  };
}

export class InMemoryMcpRegistry {
  readonly #tools = new Map<string, McpTool>();

  constructor(tools: readonly McpTool[] = []) {
    for (const tool of tools) this.#tools.set(tool.id, tool);
  }

  list(): McpTool[] {
    return [...this.#tools.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  upsert(tool: McpTool): McpTool {
    this.#tools.set(tool.id, tool);
    return tool;
  }

  setRevoked(id: string, revoked: boolean): McpTool | undefined {
    const tool = this.#tools.get(id);
    if (!tool) return undefined;
    const updated = { ...tool, revoked };
    this.#tools.set(id, updated);
    return updated;
  }

  setKillSwitch(id: string, killSwitch: boolean): McpTool | undefined {
    const tool = this.#tools.get(id);
    if (!tool) return undefined;
    const updated = { ...tool, killSwitch };
    this.#tools.set(id, updated);
    return updated;
  }
}
