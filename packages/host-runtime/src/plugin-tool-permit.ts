import { HostToolForbiddenError, stableSerialize } from "@aervox/core";
import type { PluginToolPermitSnapshot } from "@aervox/repositories";

/** Owned by the trusted runtime handler, never by persisted or model-supplied names. */
export const PLUGIN_METADATA_RUNTIME_REVISION_PREFIX = "plugin-runtime-v1:";
type Declaration = NonNullable<PluginToolPermitSnapshot["tool"]>;

export function pluginToolDeclarationFingerprint(tool: Declaration): string {
  return stableSerialize({ id: tool.id, name: tool.name, description: tool.description, category: tool.category,
    safetyLevel: tool.safetyLevel, replay: tool.replay ?? null, requiredPermissionsJson: tool.requiredPermissionsJson ?? null,
    inputSchemaJson: tool.inputSchemaJson ?? null, builtin: tool.builtin, pluginId: tool.pluginId ?? null,
    gatingConditionsJson: tool.gatingConditionsJson ?? null, priority: tool.priority });
}

/** Pure validation of one coherent observation; no dispatcher or permission store. */
export function createPluginToolPermitValidator(expected: {
  pluginId: string; fingerprint: string; generation?: string; version?: string; checksum?: string;
}): (snapshot: PluginToolPermitSnapshot) => void {
  let initial: NonNullable<PluginToolPermitSnapshot["plugin"]> | undefined;
  const admittedGrants = new Map<number, Set<string>>();
  return snapshot => {
    const current = snapshot.plugin;
    if (!current || current.id !== expected.pluginId || current.enabled !== 1 || current.availability !== "available"
      || !current.lifecycleGeneration || current.lifecycleGeneration !== (expected.generation ?? initial?.lifecycleGeneration ?? current.lifecycleGeneration)) {
      throw new HostToolForbiddenError("plugin_generation_changed");
    }
    if ((expected.version !== undefined && current.version !== expected.version)
      || (expected.checksum !== undefined && current.checksum !== expected.checksum)
      || (initial && (current.version !== initial.version || current.checksum !== initial.checksum))) {
      throw new HostToolForbiddenError("plugin implementation changed");
    }
    const tool = snapshot.tool;
    if (!tool || tool.enabled !== 1 || tool.pluginId !== expected.pluginId || tool.safetyLevel !== "read_only"
      || pluginToolDeclarationFingerprint(tool) !== expected.fingerprint) throw new HostToolForbiddenError("plugin tool declaration changed");
    const permissions = tool.requiredPermissionsJson ?? [];
    if (!Array.isArray(permissions) || snapshot.grants.length > 256) throw new HostToolForbiddenError("plugin tool permission denied");
    for (const [index, item] of permissions.entries()) {
      const permission = typeof item === "string" ? item : item?.permission;
      const scope = typeof item === "string" ? "*" : item?.scope;
      if (typeof permission !== "string" || typeof scope !== "string") throw new HostToolForbiddenError("plugin tool permission denied");
      const grants = snapshot.grants.filter(grant => grant.pluginId === expected.pluginId && grant.permission === permission && grant.scope === scope);
      const admitted = admittedGrants.get(index);
      if (!grants.length || (admitted && !grants.some(grant => admitted.has(grant.id)))) throw new HostToolForbiddenError("plugin tool permission denied");
      if (!admitted) admittedGrants.set(index, new Set(grants.map(grant => grant.id)));
    }
    initial ??= { ...current };
  };
}
