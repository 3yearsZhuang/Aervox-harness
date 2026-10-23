import { describe, expect, it, vi } from "vitest";
import type { ToolProviderPort } from "@aervox/core";
import type { IExtensionRepository, SqliteConversationRepository } from "@aervox/repositories";
import { createContributionToolProvider, ToolBindingCatalog, type ToolBinding } from "../src/modules/companion/conversation/tool-providers.js";
import { createPluginApiRegistry } from "../../contracts/src/plugin-api-registry.js";
import { PluginToolCatalog, preparePluginToolContributions } from "../src/modules/companion/conversation/plugin-tool-catalog.js";
import { createPluginToolScope } from "../src/modules/companion/conversation/plugin-tool-scope.js";
import { setRequestToolApprovalMode } from "../src/shared/tool-approval-policy.js";

const binding = (name: string): ToolBinding => ({ id: name, owner: "test", spec: { name, description: name, readOnly: true }, dispatch: async () => ({ ok: true }) });
const local = { workspaceId: "local", subjectUserId: "local" };
const call = { name: "probe", arguments: {}, turnId: "turn", attemptId: "attempt", invocationId: "invocation" };
function approvals(version?: string) {
  return {
    findGrantedToolApproval: vi.fn(async () => version ? { id: "grant", toolVersion: version } : null),
    recordToolApproval: vi.fn(async () => ({ id: "pending" })),
    decideToolApproval: vi.fn(async () => ({ id: "granted" })),
  } as unknown as Pick<SqliteConversationRepository, "findGrantedToolApproval" | "recordToolApproval" | "decideToolApproval">;
}

describe("tool binding identity and ownership", () => {
  it("preflights complete replacement and preserves old bindings on a conflict", () => {
    const catalog = new ToolBindingCatalog();
    catalog.register("a", "one", [binding("a")]);
    expect(() => catalog.register("b", "one", [binding("b"), binding("a")])).toThrow("duplicate_tool_binding");
    expect(catalog.get("a")?.owner).toBe("a");
    expect(catalog.get("b")).toBeUndefined();
  });
  it("disposes only its generation and keeps disposer identity while other owners register", () => {
    const catalog = new ToolBindingCatalog();
    const old = catalog.register("a", "one", [binding("a")]);
    const next = catalog.register("a", "two", [binding("a")]);
    const other = catalog.register("b", "one", [binding("b")]);
    old(); expect(catalog.get("a")?.generation).toBe("two");
    next(); expect(catalog.get("a")).toBeUndefined(); expect(catalog.get("b")).toBeDefined();
    other(); expect(catalog.get("b")).toBeUndefined();
  });
  it("an approval from a prior plugin generation cannot authorize the new generation", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const provider: ToolProviderPort = { tools: [{ name: "probe", description: "probe", readOnly: false, safetyLevel: "write_with_approval" }], execute: dispatch };
    const repo = approvals('old:{"description":"probe","name":"probe","readOnly":false,"safetyLevel":"write_with_approval"}');
    const tools = createContributionToolProvider([{ provider, owner: "plugin", generation: "new" }], local, repo);
    await tools.listTools!();
    expect(await tools.execute(call)).toMatchObject({ ok: false, needsApproval: { approvalId: "pending" } });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("static handler replacement and redeclaration need a new approval while the old declaration retains its captured handler", async () => {
    const first = vi.fn(async () => ({ ok: true })); const replacement = vi.fn(async () => ({ ok: true }));
    const provider: ToolProviderPort = { tools: [{ name: call.name, description: "write", readOnly: false }], execute: first };
    let grantedVersion: string | undefined;
    const repo = { ...approvals(),
      findGrantedToolApproval: vi.fn(async () => grantedVersion ? { id: "grant", toolVersion: grantedVersion } : null),
      recordToolApproval: vi.fn(async (_local: unknown, input: { toolVersion?: string | null }) => {
        grantedVersion = input.toolVersion ?? undefined; return { id: "pending" };
      }),
    };
    const tools = createContributionToolProvider([{ provider }], local, repo);
    await tools.listTools!(); await tools.execute(call);
    const oldVersion = grantedVersion;
    provider.execute = replacement;
    expect(await tools.execute(call)).toMatchObject({ ok: true });
    expect(first).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
    await tools.listTools!();
    expect((await tools.execute(call)).needsApproval).toBeDefined();
    expect(grantedVersion).not.toBe(oldVersion);
    expect(replacement).not.toHaveBeenCalled();
    expect(await tools.execute(call)).toMatchObject({ ok: true });
    expect(replacement).toHaveBeenCalledOnce();
  });
  it("destructive contributions remain pending in full access without explicit authorization", async () => {
    const ctx = { ...local }; setRequestToolApprovalMode(ctx, "full_access");
    const dispatch = vi.fn(async () => ({ ok: true }));
    const provider: ToolProviderPort = { tools: [{ name: "probe", description: "probe", readOnly: false, safetyLevel: "destructive" }], execute: dispatch };
    const tools = createContributionToolProvider([{ provider }], ctx, approvals());
    expect(await tools.execute(call)).toMatchObject({ ok: false, needsApproval: { approvalId: "pending" } });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("a disabled then reenabled plugin cannot execute its old declaration", async () => {
    let generation = "one";
    const repo = { getPlugin: async () => ({ enabled: 1, availability: "available", lifecycleGeneration: generation }) } as unknown as IExtensionRepository;
    const scope = createPluginToolScope(repo, "plugin", generation);
    const dispatch = vi.fn(async () => ({ ok: true }));
    const tools = createContributionToolProvider([{ provider: { tools: [binding("probe").spec], execute: dispatch }, owner: "plugin", generation, checkActive: scope.active }], local, approvals());
    try {
      await tools.listTools!(); generation = "two";
      expect(await tools.execute(call)).toMatchObject({ ok: false, error: "tool_permission_denied" });
      expect(dispatch).not.toHaveBeenCalled(); expect(scope.signal?.aborted).toBe(true);
    } finally { scope.dispose(); }
  });
  it("revokes static declarations when their first asynchronous listing fails", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const listTools = vi.fn(async () => [binding("probe").spec]);
    const tools = createContributionToolProvider([{ provider: {
      tools: [binding("probe").spec], listTools, execute: dispatch,
    } }], local, approvals());
    listTools.mockRejectedValueOnce(new Error("registry_unavailable"));
    await expect(tools.listTools!()).rejects.toThrow("registry_unavailable");
    expect(await tools.execute(call)).toMatchObject({ ok: false, error: "unregistered_tool: probe" });
    expect(dispatch).not.toHaveBeenCalled();
    await tools.listTools!();
    expect(await tools.execute(call)).toMatchObject({ ok: true });
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("revokes the complete snapshot after a later source fails without publishing its partial replacement", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const first = vi.fn(async () => [binding("probe").spec]);
    const later = vi.fn(async () => [binding("other").spec]);
    const tools = createContributionToolProvider([
      { provider: { tools: [], listTools: first, execute: dispatch } },
      { provider: { tools: [], listTools: later, execute: dispatch } },
    ], local, approvals());
    await tools.listTools!();
    expect(await tools.execute(call)).toMatchObject({ ok: true });
    first.mockResolvedValueOnce([binding("replacement").spec]);
    later.mockRejectedValueOnce(new Error("later_registry_unavailable"));
    await expect(tools.listTools!()).rejects.toThrow("later_registry_unavailable");
    for (const name of ["probe", "other", "replacement"]) {
      expect(await tools.execute({ ...call, name })).toMatchObject({ ok: false, error: `unregistered_tool: ${name}` });
    }
    expect(dispatch).toHaveBeenCalledOnce();
    expect((await tools.listTools!()).map(tool => tool.name)).toEqual(["probe", "other"]);
    expect(await tools.execute(call)).toMatchObject({ ok: true });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("does not dispatch an authorized call if its declaration was revoked while approval was loading", async () => {
    let release!: (approval: { id: string }) => void;
    const repo = {
      ...approvals(),
      findGrantedToolApproval: vi.fn(() => new Promise<{ id: string }>(resolve => { release = resolve; })),
    };
    const dispatch = vi.fn(async () => ({ ok: true }));
    const spec = { ...binding("probe").spec, readOnly: false };
    const listTools = vi.fn(async () => [spec]);
    const tools = createContributionToolProvider([{ provider: { tools: [], listTools, execute: dispatch } }], local, repo);
    await tools.listTools!();
    const execution = tools.execute(call);
    await vi.waitFor(() => expect(repo.findGrantedToolApproval).toHaveBeenCalledOnce());
    listTools.mockRejectedValueOnce(new Error("registry_unavailable"));
    await expect(tools.listTools!()).rejects.toThrow("registry_unavailable");
    release({ id: "explicit_grant" });
    expect(await execution).toMatchObject({ ok: false, error: "tool_permission_denied" });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("asynchronous plugin contribution preflight", () => {
  const scope = { checkActive: async () => {} };
  it("does not publish earlier providers or projections when a later declaration fails", async () => {
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog({ getPlugin: vi.fn() }, api);
    const first = vi.fn(async () => [binding("first").spec]);
    const later = vi.fn(async () => { throw new Error("later_declaration_failed"); });
    const publish = async () => {
      const prepared = await preparePluginToolContributions([
        { id: "first", provider: { tools: [], listTools: first, execute: async () => ({ ok: true }) }, guidance: [{ name: "first", whenToUse: "first" }], resultProjection: { safeParse: () => ({ success: true }) } },
        { id: "later", provider: { tools: [], listTools: later, execute: async () => ({ ok: true }) } },
      ], scope);
      catalog.register("owner", "one", prepared);
    };
    try {
      await expect(publish()).rejects.toThrow("later_declaration_failed");
      expect(first).toHaveBeenCalledOnce(); expect(later).toHaveBeenCalledOnce();
      expect(api.getPluginToolResultProjection("first")).toBeUndefined();
    } finally { catalog.dispose(); }
  });
  it("freezes the resolved revision and validates dynamic names against all preceding contributions", async () => {
    const tools = [binding("dynamic").spec]; const listTools = vi.fn(async () => tools);
    const candidate = { id: "candidate", provider: { tools: [], listTools, execute: async () => ({ ok: true }) } };
    const prepared = await preparePluginToolContributions([candidate], scope);
    tools[0]!.description = "changed after preflight";
    expect((await prepared[0]!.provider.listTools!())[0]!.description).toBe("dynamic");
    expect(listTools).toHaveBeenCalledOnce();
    await expect(preparePluginToolContributions([candidate], scope, new Set(["dynamic"]))).rejects.toThrow("duplicate_tool_binding");
  });
  it("cancellation stops waiting for an uncooperative declaration before commit", async () => {
    const controller = new AbortController();
    const pending = preparePluginToolContributions([{ id: "blocked", provider: {
      tools: [], listTools: () => new Promise(() => {}), execute: async () => ({ ok: true }),
    } }], { ...scope, signal: controller.signal });
    controller.abort(new Error("declaration_cancelled"));
    await expect(pending).rejects.toThrow("declaration_cancelled");
  });
});

describe("host ToolCatalog lifecycle", () => {
  const projection = (name: string) => ({ safeParse: () => ({ success: true, data: { name } }) });
  const contribution = (name: string, resultProjection = projection(name)) => ({
    id: name, provider: { tools: [binding(name).spec], execute: async () => ({ ok: true }) }, resultProjection,
  });
  it("rolls back every projection when a later contribution conflicts, preserving the previous generation", () => {
    const api = createPluginApiRegistry();
    const catalog = new PluginToolCatalog({ getPlugin: vi.fn() }, api);
    const previous = projection("previous");
    catalog.register("owner", "one", [contribution("probe", previous)]);
    api.registerToolResultProjection("foreign", "occupied", projection("foreign"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() => catalog.register("owner", "two", [contribution("probe"), contribution("occupied")])).toThrow("tool_projection_owner_conflict");
      expect(api.getPluginToolResultProjection("probe")).toBe(previous);
      expect(api.getToolResultProjectionOwner("occupied")).toBe("foreign");
    } finally { catalog.dispose(); warn.mockRestore(); }
  });
  it("expires projections after disable and reenable even while no Turn is running", async () => {
    let generation = "one";
    const api = createPluginApiRegistry();
    const catalog = new PluginToolCatalog({ getPlugin: async () => ({ enabled: 1, availability: "available", lifecycleGeneration: generation }) } as unknown as IExtensionRepository, api);
    try {
      catalog.register("owner", generation, [contribution("probe")]);
      expect(api.getPluginToolResultProjection("probe")).toBeDefined();
      generation = "two";
      await vi.waitFor(() => expect(api.getPluginToolResultProjection("probe")).toBeUndefined());
      catalog.register("owner", generation, [contribution("probe")]);
      expect(api.getPluginToolResultProjection("probe")).toBeDefined();
    } finally { catalog.dispose(); }
    expect(api.getPluginToolResultProjection("probe")).toBeUndefined();
  });
  it("an old generation disposer cannot release the replacement or another host", () => {
    const a = createPluginApiRegistry(); const b = createPluginApiRegistry();
    const repo = { getPlugin: vi.fn() };
    const first = new PluginToolCatalog(repo, a); const second = new PluginToolCatalog(repo, b);
    const disposeOld = first.register("owner", "one", [contribution("probe")]);
    first.register("owner", "two", [contribution("probe")]);
    second.register("owner", "one", [contribution("probe")]);
    disposeOld(); expect(a.getPluginToolResultProjection("probe")).toBeDefined();
    first.dispose(); expect(a.getPluginToolResultProjection("probe")).toBeUndefined();
    expect(b.getPluginToolResultProjection("probe")).toBeDefined(); second.dispose();
  });
});
