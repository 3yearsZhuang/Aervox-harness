import { awaitWithSignal, stableSerialize } from "@aervox/core";
import type { PluginToolContribution } from "@aervox/host-plugin-api";
import type { IExtensionRepository } from "@aervox/repositories";
import type { PluginHostServiceControl } from "./plugin-host-services.js";

const contributionRevisions = new WeakMap<object, string>();
/** Stable only for the same injected implementation object in this process; never infer code identity from function text. */
export function processToolImplementationRevision(implementation: object): string {
  let revision = contributionRevisions.get(implementation);
  if (!revision) { revision = `process:${globalThis.crypto.randomUUID()}`; contributionRevisions.set(implementation, revision); }
  return revision;
}

interface PreparedContribution extends PluginToolContribution { projectionRevision: string | null }

/** Resolve and capture the complete declaration before publishing any of its parts. */
export async function preparePluginToolContributions(
  candidates: PluginToolContribution[],
  scope: { signal?: AbortSignal; checkActive(): Promise<void> },
  reservedNames: ReadonlySet<string> = new Set(),
): Promise<PreparedContribution[]> {
  const ids = new Set<string>();
  const names = new Set<string>(reservedNames);
  const prepared: PreparedContribution[] = [];
  for (const candidate of candidates) {
    await scope.checkActive();
    if (ids.has(candidate.id)) throw new Error(`duplicate_plugin_contribution: ${candidate.id}`);
    ids.add(candidate.id);
    const execute = candidate.provider.execute.bind(candidate.provider);
    const declared = candidate.provider.listTools
      ? await awaitWithSignal(Promise.resolve(candidate.provider.listTools({ signal: scope.signal })), scope.signal) : candidate.provider.tools;
    const tools = structuredClone(declared);
    for (const tool of tools) {
      if (names.has(tool.name)) throw new Error(`duplicate_tool_binding: ${tool.name}`);
      names.add(tool.name);
    }
    const guidance = candidate.guidance ? structuredClone(candidate.guidance) : undefined;
    for (const item of guidance ?? []) {
      if (!tools.some(tool => tool.name === item.name)) throw new Error(`undeclared_tool_guidance: ${item.name}`);
    }
    // Capture the declared method as well as the provider handler. Reassigning either
    // property after preflight cannot change an already published declaration.
    const projectionMethod = candidate.resultProjection?.safeParse;
    if (candidate.resultProjection && typeof projectionMethod !== "function") throw new Error(`invalid_tool_projection: ${candidate.id}`);
    const resultProjection = candidate.resultProjection && projectionMethod
      ? Object.freeze({ safeParse: projectionMethod.bind(candidate.resultProjection) }) : undefined;
    prepared.push({ id: candidate.id, guidance, resultProjection,
      // A prototype method alone does not identify the schema receiver it reads.
      // Reuse a context-free schema declaration across Turns; replacements fail closed.
      projectionRevision: candidate.resultProjection && projectionMethod ? stableSerialize([
        processToolImplementationRevision(candidate.resultProjection), processToolImplementationRevision(projectionMethod),
      ]) : null, provider: {
      tools, listTools: async () => structuredClone(tools), execute,
    } });
  }
  await scope.checkActive();
  return prepared;
}

/** A tool declaration belongs to one enabled lifecycle generation, including its writes. */
export function createPluginToolScope(
  repo: Pick<IExtensionRepository, "getPlugin">, pluginId: string, generation: string, parent?: AbortSignal,
): PluginHostServiceControl & { active(): Promise<boolean>; dispose(): void } {
  const controller = new AbortController();
  const abortParent = () => controller.abort(parent?.reason ?? new Error("turn_cancelled"));
  parent?.addEventListener("abort", abortParent, { once: true });
  if (parent?.aborted) abortParent();
  let checking = false;
  let disposed = false;
  const checkActive = async () => {
    controller.signal.throwIfAborted();
    const plugin = await awaitWithSignal(repo.getPlugin(pluginId), controller.signal);
    if (disposed || !plugin || plugin.enabled !== 1 || (plugin.availability ?? "available") !== "available"
      || plugin.lifecycleGeneration !== generation) controller.abort(new Error("plugin_generation_changed"));
    controller.signal.throwIfAborted();
  };
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void checkActive().catch(error => controller.abort(error)).finally(() => { checking = false; });
  }, 50);
  timer.unref();
  return {
    signal: controller.signal, checkActive, pluginGeneration: { pluginId, generation },
    async active() { try { await checkActive(); return true; } catch { return false; } },
    dispose() {
      disposed = true; clearInterval(timer); parent?.removeEventListener("abort", abortParent);
      controller.abort(new Error("plugin_tool_scope_finished"));
    },
  };
}
