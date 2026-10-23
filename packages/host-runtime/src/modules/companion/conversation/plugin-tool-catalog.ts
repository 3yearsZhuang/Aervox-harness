import { awaitWithSignal } from "@aervox/core";
import type { PluginApiRegistry } from "@aervox/contracts";
import type { PluginToolContribution } from "@aervox/host-plugin-api";
import type { IExtensionRepository } from "@aervox/repositories";

/** Resolve every asynchronous declaration before publishing any handler, guidance or projection. */
export async function preparePluginToolContributions(
  candidates: PluginToolContribution[],
  scope: { signal?: AbortSignal; checkActive(): Promise<void> },
  reservedNames: ReadonlySet<string> = new Set(),
): Promise<PluginToolContribution[]> {
  const ids = new Set<string>();
  const names = new Set<string>(reservedNames);
  const prepared: PluginToolContribution[] = [];
  for (const candidate of candidates) {
    await scope.checkActive();
    if (ids.has(candidate.id)) throw new Error(`duplicate_plugin_contribution: ${candidate.id}`);
    ids.add(candidate.id);
    const declared = candidate.provider.listTools
      ? await awaitWithSignal(Promise.resolve(candidate.provider.listTools()), scope.signal) : candidate.provider.tools;
    const tools = structuredClone(declared);
    for (const tool of tools) {
      if (names.has(tool.name)) throw new Error(`duplicate_tool_binding: ${tool.name}`);
      names.add(tool.name);
    }
    prepared.push({ ...candidate, guidance: candidate.guidance ? structuredClone(candidate.guidance) : undefined, provider: {
      tools,
      listTools: async () => tools,
      execute: input => candidate.provider.execute(input),
    } });
  }
  await scope.checkActive();
  return prepared;
}

interface Entry {
  generation: string;
  names: Set<string>;
  release(): void;
}

/** Host-owned metadata survives turn completion for replay, and expires with its plugin generation. */
export class PluginToolCatalog {
  private readonly entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  private disposed = false;
  constructor(private readonly plugins: Pick<IExtensionRepository, "getPlugin">, private readonly api: PluginApiRegistry) {}

  register(owner: string, generation: string, contributions: PluginToolContribution[]): () => void {
    if (this.disposed) throw new Error("tool_catalog_disposed");
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const contribution of contributions) {
      if (ids.has(contribution.id)) throw new Error(`duplicate_plugin_contribution: ${contribution.id}`);
      ids.add(contribution.id);
      for (const tool of contribution.provider.tools) {
        if (names.has(tool.name)) throw new Error(`duplicate_tool_binding: ${tool.name}`);
        names.add(tool.name);
        for (const [otherOwner, entry] of this.entries) {
          if (otherOwner !== owner && entry.names.has(tool.name)) {
            throw new Error(`duplicate_tool_binding: ${tool.name}`);
          }
        }
      }
    }
    const cleanups: Array<() => void> = [];
    try {
      for (const contribution of contributions) {
        if (!contribution.resultProjection) continue;
        for (const tool of contribution.provider.tools) {
          const dispose = this.api.registerToolResultProjection(owner, tool.name, contribution.resultProjection);
          if (!dispose) throw new Error(`tool_projection_owner_conflict: ${tool.name}`);
          cleanups.push(dispose);
        }
      }
    } catch (error) {
      for (const cleanup of cleanups.reverse()) cleanup();
      throw error;
    }
    const previous = this.entries.get(owner);
    const entry: Entry = {
      generation, names,
      release: () => {
        for (const cleanup of cleanups.splice(0).reverse()) cleanup();
        if (this.entries.get(owner) === entry) this.entries.delete(owner);
        if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
      },
    };
    this.entries.set(owner, entry);
    previous?.release();
    this.startMonitoring();
    return entry.release;
  }

  private startMonitoring(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.checking) return;
      this.checking = true;
      void Promise.all([...this.entries].map(async ([owner, entry]) => {
        const plugin = await Promise.resolve().then(() => this.plugins.getPlugin(owner)).catch(() => null);
        if (this.entries.get(owner) !== entry) return;
        if (!plugin || plugin.enabled !== 1 || (plugin.availability ?? "available") !== "available" || plugin.lifecycleGeneration !== entry.generation) entry.release();
      })).finally(() => { this.checking = false; });
    }, 50);
    this.timer.unref();
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.entries.values()]) entry.release();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
