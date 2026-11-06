import { createHash } from "node:crypto";
import { awaitWithSignal, HostToolForbiddenError, HostToolError, stableSerialize } from "@aervox/core";
import type { PluginApiRegistry } from "@aervox/contracts";
import type { ServerPluginRegistration } from "@aervox/host-plugin-api";
import type { IExtensionRepository, PluginToolPermitReaderPort } from "@aervox/repositories";
import type { PluginHostServicesFactory } from "./plugin-assembly.js";
import type { ToolRuntimePort } from "./modules/ecosystem/tools/index.js";
import { preparePluginToolContributions, createPluginToolScope } from "./plugin-tool-bindings.js";
import { createPluginToolPermitValidator, pluginToolDeclarationFingerprint, PLUGIN_METADATA_RUNTIME_REVISION_PREFIX } from "./plugin-tool-permit.js";

/** Bind trusted code to existing declarations; the Core runtime remains the only dispatcher. */
export function createRuntimeToolSink(deps: {
  runtime: ToolRuntimePort;
  plugins: Pick<IExtensionRepository, "getPlugin"> & PluginToolPermitReaderPort;
  services: PluginHostServicesFactory;
  api: PluginApiRegistry;
}) {
  const local = { workspaceId: "local", subjectUserId: "local" } as const;
  return async (pluginId: string, create: NonNullable<ServerPluginRegistration["runtimeToolContributions"]>, version: string | undefined): Promise<() => void> => {
    const installed = await deps.plugins.getPlugin(pluginId);
    if (!version || !installed || installed.version !== version
      || (installed.availability ?? "available") !== "available" || !installed.lifecycleGeneration) {
      throw new Error("plugin_runtime_identity_unavailable");
    }
    // Code is bound to this installation's content, not to arbitrary future packages
    // with the same name. Enabled toggles may create a new lifecycle for new calls.
    const checkCodeIdentity = async (signal?: AbortSignal) => {
      const current = await awaitWithSignal(deps.plugins.getPlugin(pluginId), signal);
      if (!current || (current.availability ?? "available") !== "available"
        || current.version !== installed.version || current.checksum !== installed.checksum) {
        throw new HostToolForbiddenError("plugin implementation changed");
      }
    };
    const factory = create;
    const prepared = await preparePluginToolContributions(factory(deps.services(local)), { checkActive: checkCodeIdentity });
    // Validate the complete batch before replacing any live handler or projection.
    const bindings = await Promise.all(prepared.flatMap(contribution => contribution.provider.tools.map(async spec => {
      const id = `${pluginId}.${spec.name}`;
      const snapshot = await deps.plugins.readPluginToolPermit(local, pluginId, id);
      const declaration = snapshot.tool;
      if (!snapshot.plugin || snapshot.plugin.version !== version || snapshot.plugin.checksum !== installed.checksum) {
        throw new Error("plugin_runtime_identity_unavailable");
      }
      if (spec.readOnly !== true || spec.budget !== undefined || (spec.safetyLevel !== undefined && spec.safetyLevel !== "read_only")
        || !declaration || declaration.pluginId !== pluginId || declaration.name !== spec.name
        || declaration.description !== spec.description || stableSerialize(declaration.inputSchemaJson) !== stableSerialize(spec.parameters)
        || declaration.safetyLevel !== "read_only") throw new Error("plugin_runtime_declaration_mismatch");
      const permissions = declaration.requiredPermissionsJson ?? [];
      if (!Array.isArray(permissions) || permissions.some(item => typeof item !== "string"
        && (typeof item?.permission !== "string" || typeof item?.scope !== "string"))) {
        throw new Error("plugin_runtime_permissions_invalid");
      }
      const declarationKey = stableSerialize(spec);
      const fingerprint = pluginToolDeclarationFingerprint(declaration);
      const revision = createHash("sha256").update(stableSerialize([pluginId, installed.version, installed.checksum,
        contribution.id, declarationKey, contribution.projectionRevision, fingerprint])).digest("hex");
      return { contribution, spec, id, declarationKey, fingerprint, revision };
    })));
    const cleanups: Array<() => void> = [];
    const release = () => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); };
    try {
      const projections = prepared.flatMap(contribution => contribution.resultProjection
        ? contribution.provider.tools.map(tool => ({ name: tool.name, schema: contribution.resultProjection! })) : []);
      const releaseProjections = deps.api.registerToolResultProjections(pluginId, projections);
      if (!releaseProjections) throw new Error("plugin_runtime_projection_conflict");
      cleanups.push(releaseProjections);
      for (const { contribution, spec, id, declarationKey, fingerprint, revision } of bindings) {
        cleanups.push(deps.runtime.registerHandler(id, {
          approvalRevision: `${PLUGIN_METADATA_RUNTIME_REVISION_PREFIX}${revision}`,
          async call(ctx, args, context) {
            const firstSnapshot = await awaitWithSignal(deps.plugins.readPluginToolPermit(ctx, pluginId, id), context.signal);
            const record = firstSnapshot.plugin;
            if (!record?.lifecycleGeneration) throw new HostToolForbiddenError("plugin lifecycle unavailable");
            const scope = createPluginToolScope(deps.plugins, pluginId, record.lifecycleGeneration, context.signal);
            const validateSnapshot = createPluginToolPermitValidator({ pluginId, fingerprint, generation: record.lifecycleGeneration,
              version: installed.version, checksum: installed.checksum });
            const checkActive = async () => {
              validateSnapshot(await awaitWithSignal(deps.plugins.readPluginToolPermit(ctx, pluginId, id), scope.signal));
              scope.signal?.throwIfAborted();
            };
            try {
              validateSnapshot(firstSnapshot);
              await checkActive();
              const candidates = await preparePluginToolContributions(factory(deps.services(ctx, {
                signal: scope.signal, pluginGeneration: scope.pluginGeneration, checkActive,
              })), { signal: scope.signal, checkActive });
              const current = candidates.find(candidate => candidate.id === contribution.id);
              const actual = current?.provider.tools.find(tool => tool.name === spec.name);
              if (!current || !actual || stableSerialize(actual) !== declarationKey
                || current.projectionRevision !== contribution.projectionRevision) {
                throw new HostToolForbiddenError("plugin tool declaration changed");
              }
              const result = await awaitWithSignal(current.provider.execute({ name: spec.name, arguments: args,
                // Direct metadata reads have no Turn. Empty identifiers preserve that
                // absence; this bridge only accepts read-only tools and writes no ledger.
                turnId: context.controlContext?.turnId ?? "", attemptId: context.controlContext?.attemptId ?? "",
                invocationId: context.controlContext?.executionId ?? "", signal: scope.signal,
              }), scope.signal);
              if (!result.ok) throw new HostToolError("plugin catalog unavailable", 503, "PLUGIN_CATALOG_UNAVAILABLE");
              const projection = contribution.resultProjection?.safeParse(result.output);
              if (contribution.resultProjection && !projection?.success) {
                throw new HostToolError("invalid plugin catalog result", 503, "PLUGIN_CATALOG_INVALID");
              }
              // Final admission is one SQL snapshot. No asynchronous dependency is
              // read after it; delivery still has an explicitly documented observation window.
              await checkActive();
              scope.signal?.throwIfAborted(); context.signal.throwIfAborted(); context.controlContext?.abortSignal.throwIfAborted();
              return contribution.resultProjection ? projection!.data : result.output;
            } finally { scope.dispose(); }
          },
        }));
      }
      await checkCodeIdentity();
      return release;
    } catch (error) { release(); throw error; }
  };
}
