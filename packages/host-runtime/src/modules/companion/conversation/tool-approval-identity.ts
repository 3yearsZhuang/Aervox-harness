import { stableSerialize } from "@aervox/core";

/** Persisted by the host from the same binding used for dispatch; never supplied by the model or HTTP caller. */
export interface ToolApprovalIdentity {
  kind: "contribution" | "runtime";
  id: string;
  owner: string;
  generation: string | null;
  revision: string;
  safetyLevel: string;
}
const prefix = "binding-v1:";
export function encodeToolApprovalIdentity(identity: ToolApprovalIdentity): string {
  return `${prefix}${stableSerialize(identity)}`;
}
export function readToolApprovalIdentity(version: string | null | undefined): ToolApprovalIdentity | undefined {
  if (!version?.startsWith(prefix)) return undefined;
  try {
    const value = JSON.parse(version.slice(prefix.length)) as Partial<ToolApprovalIdentity>;
    if ((value.kind !== "contribution" && value.kind !== "runtime")
      || typeof value.id !== "string" || !value.id || typeof value.owner !== "string" || !value.owner
      || (value.generation !== null && typeof value.generation !== "string")
      || typeof value.revision !== "string" || !value.revision || typeof value.safetyLevel !== "string") return undefined;
    return value as ToolApprovalIdentity;
  } catch { return undefined; }
}
