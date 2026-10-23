import { createHash } from "node:crypto";
import { awaitWithSignal, stableSerialize, type ToolGuidance, type ToolSpec } from "@aervox/core";
import type { PluginApiRegistry, ToolResultProjectionSchema } from "@aervox/contracts";
import type { PluginToolContribution } from "@aervox/host-plugin-api";
import type { IExtensionRepository } from "@aervox/repositories";
import { createPluginToolScope } from "./plugin-tool-scope.js";
import { processToolImplementationRevision, type ContributionToolSource } from "./tool-providers.js";

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

type ToolScope = ReturnType<typeof createPluginToolScope>;
export interface PluginToolLease {
  readonly owner: string;
  readonly generation: string;
  readonly revision: string;
  readonly sources: ContributionToolSource[];
  readonly guidance: ToolGuidance[];
  /** Ends this invocation only, preserving safe replay projections for the current generation. */
  release(): void;
  /** A registration owner can revoke this exact batch; a replaced batch is never affected. */
  revoke(): void;
}
interface LeaseState {
  release(): void;
}
interface Entry {
  owner: string;
  generation: string;
  revision: string;
  names: Set<string>;
  tools: ToolSpec[];
  guidance: ToolGuidance[];
  leases: Set<LeaseState>;
  release(): void;
}
interface Acquisition {
  owner: string;
  generation: string;
  signal?: AbortSignal;
  reservedNames?: ReadonlySet<string>;
  /** Factory receives only this invocation's lifecycle-bound services scope. */
  create(scope: ToolScope): PluginToolContribution[];
}

/** One host owns complete tool batches and their invocation leases. Only safe projection metadata survives a Turn. */
export class PluginToolCatalog {
  private readonly entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  private disposed = false;
  constructor(private readonly plugins: Pick<IExtensionRepository, "getPlugin">, private readonly api: PluginApiRegistry) {}

  async acquire(input: Acquisition): Promise<PluginToolLease> {
    if (this.disposed) throw new Error("tool_catalog_disposed");
    const scope = createPluginToolScope(this.plugins, input.owner, input.generation, input.signal);
    try {
      await scope.checkActive();
      const contributions = await preparePluginToolContributions(input.create(scope), scope, input.reservedNames);
      await scope.checkActive();
      scope.signal?.throwIfAborted();
      if (this.disposed) throw new Error("tool_catalog_disposed");
      const names = new Set(contributions.flatMap(item => item.provider.tools.map(tool => tool.name)));
      for (const [owner, entry] of this.entries) {
        if (owner !== input.owner && [...names].some(name => entry.names.has(name))) throw new Error("duplicate_tool_binding");
      }
      // Context-bound handler objects differ between Turns. Their trusted implementation
      // identity is the plugin generation; the complete declaration/projection revision is shared.
      const revision = createHash("sha256").update(stableSerialize(contributions.map(item => ({
        id: item.id, tools: item.provider.tools, guidance: item.guidance,
        projection: item.projectionRevision,
      })))).digest("hex");
      let entry = this.entries.get(input.owner);
      if (!entry || entry.generation !== input.generation || entry.revision !== revision) {
        entry = this.publish(input.owner, input.generation, revision, names,
          contributions.flatMap(item => structuredClone(item.provider.tools)),
          contributions.flatMap(item => structuredClone(item.guidance ?? [])),
          contributions.flatMap(item => item.resultProjection
            ? item.provider.tools.map(tool => ({ name: tool.name, schema: item.resultProjection! })) : []));
      }
      return this.createLease(entry, contributions, scope);
    } catch (error) {
      scope.dispose();
      throw error;
    }
  }

  /** Contains no context-bound handlers. Projection installation is synchronous and rolls back as one batch. */
  private publish(owner: string, generation: string, revision: string, names: Set<string>, tools: ToolSpec[], guidance: ToolGuidance[],
    projections: Array<{ name: string; schema: ToolResultProjectionSchema }>): Entry {
    const releaseProjections = this.api.registerToolResultProjections(owner, projections);
    if (!releaseProjections) throw new Error("tool_projection_owner_conflict");
    const previous = this.entries.get(owner);
    const entry: Entry = { owner, generation, revision, names, tools, guidance, leases: new Set(), release: () => {
      for (const lease of [...entry.leases]) lease.release();
      releaseProjections();
      if (this.entries.get(owner) === entry) this.entries.delete(owner);
      if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    } };
    this.entries.set(owner, entry);
    previous?.release();
    this.startMonitoring();
    return entry;
  }

  private createLease(entry: Entry, contributions: PluginToolContribution[], scope: ToolScope): PluginToolLease {
    let bindings = contributions;
    let open = true;
    const active = async () => {
      if (!open || this.entries.get(entry.owner) !== entry) return false;
      const allowed = await scope.active();
      return allowed && open && this.entries.get(entry.owner) === entry;
    };
    const state: LeaseState = {
      release: () => {
        if (!open) return;
        open = false;
        bindings = []; // Do not retain an expired Turn's services or handler closures for replay.
        scope.signal?.removeEventListener("abort", state.release);
        scope.dispose();
        entry.leases.delete(state);
      },
    };
    const sources: ContributionToolSource[] = bindings.map((item, index) => ({
      owner: entry.owner, generation: entry.generation,
      // Preserve the persisted approval identity already used by the authoritative ToolBinding.
      approvalRevision: `plugin:${item.id}:${entry.generation}`, checkActive: active,
      provider: {
        tools: structuredClone(item.provider.tools),
        async listTools() { return await active() ? structuredClone(bindings[index]?.provider.tools ?? []) : []; },
        async execute(call) {
          if (!(await active())) return { ok: false, error: "tool_permission_denied" };
          const binding = bindings[index];
          if (!binding || !open || scope.signal?.aborted) return { ok: false, error: "tool_permission_denied" };
          const signal = call.signal ? AbortSignal.any([call.signal, scope.signal!]) : scope.signal;
          return awaitWithSignal(binding.provider.execute({ ...call, signal }), signal);
        },
      },
    }));
    entry.leases.add(state);
    scope.signal?.addEventListener("abort", state.release, { once: true });
    return {
      owner: entry.owner, generation: entry.generation, revision: entry.revision,
      get sources() { return open ? sources : []; },
      get guidance() { return open ? structuredClone(entry.guidance) : []; },
      release: state.release,
      revoke: () => { if (this.entries.get(entry.owner) === entry) entry.release(); },
    };
  }

  /** Inspection exposes active declarations, never their context ports or handler closures. */
  snapshot(owner: string): { generation: string; revision: string; tools: ToolSpec[]; guidance: ToolGuidance[]; activeLeases: number } | undefined {
    const entry = this.entries.get(owner);
    return entry ? { generation: entry.generation, revision: entry.revision,
      tools: structuredClone(entry.tools), guidance: structuredClone(entry.guidance),
      activeLeases: entry.leases.size } : undefined;
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
