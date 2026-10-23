import { describe, expect, it, vi } from "vitest";
import type { ToolProviderPort, ToolSpec } from "@aervox/core";
import type { IExtensionRepository, SqliteConversationRepository } from "@aervox/repositories";
import { createContributionToolProvider, ToolBindingCatalog, type ToolBinding } from "../src/modules/companion/conversation/tool-providers.js";
import { createPluginApiRegistry } from "../src/plugin-api-registry.js";
import { projectSafeEventData } from "@aervox/contracts";
import { focusModeRegistration } from "@aervox/plugin-focus-mode/server";
import type { PluginHostServices, JudgedAnswerInput } from "@aervox/host-plugin-api";
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
    const api = createPluginApiRegistry();
    const repo = { getPlugin: async () => ({ enabled: 1, availability: "available", lifecycleGeneration: "one" }) } as unknown as IExtensionRepository;
    const catalog = new PluginToolCatalog(repo, api);
    const first = vi.fn(async () => [binding("first").spec]);
    const later = vi.fn(async () => { throw new Error("later_declaration_failed"); });
    const publish = () => catalog.acquire({ owner: "owner", generation: "one", create: () => [
      { id: "first", provider: { tools: [], listTools: first, execute: async () => ({ ok: true }) }, guidance: [{ name: "first", whenToUse: "first" }], resultProjection: { safeParse: () => ({ success: true }) } },
      { id: "later", provider: { tools: [], listTools: later, execute: async () => ({ ok: true }) } },
    ] });
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
  const contribution = (name: string, resultProjection = projection(name), execute = async () => ({ ok: true, output: name })) => ({
    id: name, provider: { tools: [binding(name).spec], execute }, resultProjection,
    guidance: [{ name, whenToUse: `Use ${name}` }],
  });
  const registry = (generation: () => string = () => "one") => ({
    getPlugin: async () => ({ enabled: 1, availability: "available", lifecycleGeneration: generation() }),
  }) as unknown as Pick<IExtensionRepository, "getPlugin">;

  it("publishes definitions, handlers, guidance and projections under one registration and revokes them together", async () => {
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(), api);
    const dispatched = vi.fn(async () => ({ ok: true, output: "executed" }));
    try {
      const lease = await catalog.acquire({ owner: "owner", generation: "one", create: () => [contribution("probe", projection("probe"), dispatched)] });
      const source = lease.sources[0]!;
      expect(catalog.snapshot("owner")).toMatchObject({ generation: "one", revision: lease.revision, activeLeases: 1,
        tools: [{ name: "probe" }], guidance: [{ name: "probe" }] });
      expect((await source.provider.listTools!()).map(tool => tool.name)).toEqual(["probe"]);
      expect(lease.guidance).toEqual([{ name: "probe", whenToUse: "Use probe" }]);
      expect(api.getPluginToolResultProjection("probe")).toBeDefined();
      expect(await source.provider.execute(call)).toMatchObject({ ok: true });
      lease.revoke(); lease.revoke();
      expect(catalog.snapshot("owner")).toBeUndefined();
      expect(api.getPluginToolResultProjection("probe")).toBeUndefined();
      expect(lease.sources).toEqual([]); expect(lease.guidance).toEqual([]);
      expect(await source.provider.listTools!()).toEqual([]);
      expect(await source.provider.execute(call)).toMatchObject({ ok: false, error: "tool_permission_denied" });
      expect(dispatched).toHaveBeenCalledOnce();
    } finally { catalog.dispose(); }
  });

  it("rolls back every part on a later projection conflict and preserves the previous complete registration", async () => {
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(), api);
    const previous = projection("previous");
    const oldHandler = vi.fn(async () => ({ ok: true, output: "old" }));
    const newHandler = vi.fn(async () => ({ ok: true, output: "new" }));
    const old = await catalog.acquire({ owner: "owner", generation: "one", create: () => [contribution("probe", previous, oldHandler)] });
    api.registerToolResultProjections("foreign", [{ name: "occupied", schema: projection("foreign") }]);
    const beforeRevision = api.getPluginApiRevision();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(catalog.acquire({ owner: "owner", generation: "one", create: () => [
        contribution("probe", projection("new"), newHandler), contribution("occupied"),
      ] })).rejects.toThrow("tool_projection_owner_conflict");
      expect(api.getPluginToolResultProjection("probe")?.safeParse({}).data).toEqual({ name: "previous" });
      expect(api.getPluginApiRevision()).toBe(beforeRevision);
      expect(api.getToolResultProjectionOwner("occupied")).toBe("foreign");
      expect(catalog.snapshot("owner")).toMatchObject({ revision: old.revision, activeLeases: 1,
        tools: [{ name: "probe" }], guidance: [{ name: "probe" }] });
      expect(old.guidance).toHaveLength(1);
      expect(await old.sources[0]!.provider.execute(call)).toMatchObject({ output: "old" });
      expect(newHandler).not.toHaveBeenCalled();
    } finally { catalog.dispose(); warn.mockRestore(); }
  });

  it("does not activate foreign guidance or any earlier part of its batch", async () => {
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(), api);
    try {
      await expect(catalog.acquire({ owner: "owner", generation: "one", create: () => [{
        ...contribution("probe"), guidance: [{ name: "foreign", whenToUse: "not contributed" }],
      }] })).rejects.toThrow("undeclared_tool_guidance");
      expect(catalog.snapshot("owner")).toBeUndefined();
      expect(api.getPluginToolResultProjection("probe")).toBeUndefined();
    } finally { catalog.dispose(); }
  });

  it("releases expired invocation ports while retaining safe declarations and projection metadata for replay", async () => {
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(), api);
    const dispatched = vi.fn(async () => ({ ok: true, output: "private-context" }));
    try {
      const lease = await catalog.acquire({ owner: "owner", generation: "one", create: () => [contribution("probe", projection("safe"), dispatched)] });
      const captured = lease.sources[0]!;
      lease.release(); lease.release();
      expect(catalog.snapshot("owner")).toMatchObject({ activeLeases: 0, tools: [{ name: "probe" }], guidance: [{ name: "probe" }] });
      expect(lease.sources).toEqual([]); expect(lease.guidance).toEqual([]);
      expect(await captured.provider.execute(call)).toMatchObject({ ok: false });
      expect(dispatched).not.toHaveBeenCalled();
      expect(api.getPluginToolResultProjection("probe")?.safeParse({ private: "hidden" }).data).toEqual({ name: "safe" });
      expect(projectSafeEventData("tool_result", { invocationId: "past", name: "probe", ok: true,
        output: { private: "hidden" } }, api)).toEqual({ invocationId: "past", name: "probe", ok: true, output: { name: "safe" } });
      lease.revoke(); expect(api.getPluginToolResultProjection("probe")).toBeUndefined();
    } finally { catalog.dispose(); }
  });

  it("keeps concurrent Turn handlers bound to their own context without replacing the shared registration", async () => {
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(), api);
    const safe = projection("safe");
    try {
      const acquire = (context: string) => catalog.acquire({ owner: "owner", generation: "one", create: () => [
        contribution("probe", safe, async () => ({ ok: true, output: context })),
      ] });
      const first = await acquire("session-one"); const second = await acquire("session-two");
      expect(first.revision).toBe(second.revision);
      expect(catalog.snapshot("owner")?.activeLeases).toBe(2);
      const [a, b] = await Promise.all([first.sources[0]!.provider.execute(call), second.sources[0]!.provider.execute(call)]);
      expect([a.output, b.output]).toEqual(["session-one", "session-two"]);
      first.release();
      expect(catalog.snapshot("owner")?.activeLeases).toBe(1);
      expect(await second.sources[0]!.provider.execute(call)).toMatchObject({ output: "session-two" });
      second.release(); expect(catalog.snapshot("owner")?.activeLeases).toBe(0);
    } finally { catalog.dispose(); }
  });

  it("captures the declared handler, definitions, guidance and projection method before activation", async () => {
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(), api);
    const original = vi.fn(async () => ({ ok: true, output: "original" }));
    const changed = vi.fn(async () => ({ ok: true, output: "changed" }));
    const candidate = contribution("probe", projection("safe"), original);
    try {
      const lease = await catalog.acquire({ owner: "owner", generation: "one", create: () => [candidate] });
      candidate.provider.execute = changed;
      candidate.provider.tools[0]!.description = "changed";
      candidate.guidance[0]!.whenToUse = "changed";
      candidate.resultProjection.safeParse = () => ({ success: true, data: { name: "unsafe" } });
      expect(await lease.sources[0]!.provider.execute(call)).toMatchObject({ output: "original" });
      expect(changed).not.toHaveBeenCalled();
      expect((await lease.sources[0]!.provider.listTools!())[0]!.description).toBe("probe");
      expect(lease.guidance[0]!.whenToUse).toBe("Use probe");
      expect(api.getPluginToolResultProjection("probe")?.safeParse({}).data).toEqual({ name: "safe" });
      const snapshot = catalog.snapshot("owner")!;
      snapshot.tools[0]!.description = "consumer mutation";
      snapshot.guidance[0]!.whenToUse = "consumer mutation";
      expect(catalog.snapshot("owner")!.tools[0]!.description).toBe("probe");
      expect(lease.guidance[0]!.whenToUse).toBe("Use probe");
    } finally { catalog.dispose(); }
  });

  it("keeps the real first-party factory stable across concurrent Turns with separate learning services", async () => {
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(), api);
    const one = vi.fn(async (_input: JudgedAnswerInput) => ({ questionId: "question-one", attemptId: "attempt-one", judgement: "incorrect" as const, enteredMistakeNotebook: true }));
    const two = vi.fn(async (_input: JudgedAnswerInput) => ({ questionId: "question-two", attemptId: "attempt-two", judgement: "incorrect" as const, enteredMistakeNotebook: true }));
    const acquire = (recordJudgedAnswer: typeof one) => catalog.acquire({
      owner: focusModeRegistration.pluginId, generation: "one",
      create: () => focusModeRegistration.toolContributions!({ learningFacts: { recordJudgedAnswer } } as unknown as PluginHostServices),
    });
    try {
      const [first, second] = await Promise.all([acquire(one), acquire(two)]);
      expect(first.revision).toBe(second.revision);
      expect(catalog.snapshot(focusModeRegistration.pluginId)?.activeLeases).toBe(2);
      const invocation = { ...call, name: "record_practice_attempt", arguments: {
        prompt: "1 + 1", userAnswer: "3", correctAnswer: "2", judgement: "incorrect",
      } };
      const [a, b] = await Promise.all([first.sources[0]!.provider.execute({ ...invocation, turnId: "turn-one" }),
        second.sources[0]!.provider.execute({ ...invocation, turnId: "turn-two" })]);
      expect(a.output).toMatchObject({ questionId: "question-one" });
      expect(b.output).toMatchObject({ questionId: "question-two" });
      expect(one).toHaveBeenCalledWith(expect.objectContaining({ turnId: "turn-one" }));
      expect(two).toHaveBeenCalledWith(expect.objectContaining({ turnId: "turn-two" }));
      first.release();
      expect(await second.sources[0]!.provider.execute(invocation)).toMatchObject({ ok: true });
      second.release();
      expect(projectSafeEventData("tool_result", { invocationId: "past", name: invocation.name, ok: true,
        output: { ...(b.output as object), private: "hidden" } }, api)).toEqual({
        invocationId: "past", name: invocation.name, ok: true, output: b.output,
      });
    } finally { catalog.dispose(); }
  });

  it("replaces a projection when its receiver changes even if both declarations share a prototype method", async () => {
    class Schema {
      constructor(private readonly label: string) {}
      safeParse() { return { success: true, data: { name: this.label } }; }
    }
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(), api);
    try {
      const first = await catalog.acquire({ owner: "owner", generation: "one", create: () => [contribution("probe", new Schema("one"))] });
      const second = await catalog.acquire({ owner: "owner", generation: "one", create: () => [contribution("probe", new Schema("two"))] });
      expect(first.revision).not.toBe(second.revision); expect(first.sources).toEqual([]);
      expect(api.getPluginToolResultProjection("probe")?.safeParse({}).data).toEqual({ name: "two" });
      first.revoke(); expect(second.sources).toHaveLength(1);
    } finally { catalog.dispose(); }
  });

  it("keeps replay projection until the declared generation is revoked even without any active Turn", async () => {
    let generation = "one";
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(() => generation), api);
    const past = { invocationId: "past", name: "probe", ok: true, output: { private: "hidden" } };
    try {
      const lease = await catalog.acquire({ owner: "owner", generation, create: () => [contribution("probe")] });
      lease.release();
      expect(projectSafeEventData("tool_result", past, api)).toHaveProperty("output", { name: "probe" });
      generation = "two";
      await vi.waitFor(() => expect(catalog.snapshot("owner")).toBeUndefined());
      expect(projectSafeEventData("tool_result", past, api)).not.toHaveProperty("output");
      expect(api.getPluginToolResultProjection("probe")).toBeUndefined();
    } finally { catalog.dispose(); }
  });

  it("a stale registration disposer cannot release its replacement or another host", async () => {
    const a = createPluginApiRegistry(); const b = createPluginApiRegistry();
    const first = new PluginToolCatalog(registry(), a); const second = new PluginToolCatalog(registry(), b);
    try {
      const old = await first.acquire({ owner: "owner", generation: "one", create: () => [contribution("probe")] });
      const current = await first.acquire({ owner: "owner", generation: "one", create: () => [contribution("probe", projection("replacement"))] });
      const other = await second.acquire({ owner: "owner", generation: "one", create: () => [contribution("probe")] });
      expect(old.revision).not.toBe(current.revision);
      old.revoke(); old.release();
      expect(first.snapshot("owner")?.revision).toBe(current.revision);
      expect(await current.sources[0]!.provider.execute(call)).toMatchObject({ ok: true });
      first.dispose(); expect(a.getPluginToolResultProjection("probe")).toBeUndefined();
      expect(await other.sources[0]!.provider.execute(call)).toMatchObject({ ok: true });
      expect(b.getPluginToolResultProjection("probe")).toBeDefined();
    } finally { first.dispose(); second.dispose(); }
  });

  it("expires all four parts and cancels an in-flight handler on disable and reenable", async () => {
    let generation = "one";
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(() => generation), api);
    let signal: AbortSignal | undefined;
    const dispatched = vi.fn((input: Parameters<ToolProviderPort["execute"]>[0]) => {
      signal = input.signal;
      return new Promise<{ ok: boolean; output: string }>(() => {});
    });
    try {
      const lease = await catalog.acquire({ owner: "owner", generation, create: () => [contribution("probe", projection("probe"), dispatched)] });
      const source = lease.sources[0]!;
      const execution = source.provider.execute(call).catch(error => error);
      await vi.waitFor(() => expect(dispatched).toHaveBeenCalledOnce());
      generation = "two";
      await vi.waitFor(() => expect(api.getPluginToolResultProjection("probe")).toBeUndefined());
      expect(catalog.snapshot("owner")).toBeUndefined();
      expect(lease.sources).toEqual([]); expect(lease.guidance).toEqual([]);
      expect(signal?.aborted).toBe(true); expect(await execution).toBeInstanceOf(Error);
      expect(await source.provider.execute(call)).toMatchObject({ ok: false });
      const next = await catalog.acquire({ owner: "owner", generation, create: () => [contribution("probe")] });
      lease.revoke(); expect(next.guidance).toHaveLength(1);
      expect(api.getPluginToolResultProjection("probe")).toBeDefined();
    } finally { catalog.dispose(); }
  });

  it("parent cancellation releases its lease even if the caller has not reached its finally cleanup", async () => {
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(), api);
    const controller = new AbortController();
    try {
      const lease = await catalog.acquire({ owner: "owner", generation: "one", signal: controller.signal, create: () => [contribution("probe")] });
      controller.abort(new Error("turn_cancelled"));
      expect(lease.sources).toEqual([]); expect(lease.guidance).toEqual([]);
      expect(catalog.snapshot("owner")).toMatchObject({ activeLeases: 0, tools: [{ name: "probe" }], guidance: [{ name: "probe" }] });
      expect(api.getPluginToolResultProjection("probe")).toBeDefined();
    } finally { catalog.dispose(); }
  });

  it("cancellation during asynchronous preflight never publishes a partial registration", async () => {
    const api = createPluginApiRegistry(); const catalog = new PluginToolCatalog(registry(), api);
    const controller = new AbortController();
    const later = vi.fn(() => new Promise<ToolSpec[]>(() => {}));
    try {
      const pending = catalog.acquire({ owner: "owner", generation: "one", signal: controller.signal, create: () => [
        contribution("probe"), { ...contribution("later"), provider: { ...contribution("later").provider, listTools: later } },
      ] });
      await vi.waitFor(() => expect(later).toHaveBeenCalledOnce());
      controller.abort(new Error("preflight_cancelled"));
      await expect(pending).rejects.toThrow("preflight_cancelled");
      expect(catalog.snapshot("owner")).toBeUndefined();
      expect(api.getPluginToolResultProjection("probe")).toBeUndefined();
    } finally { catalog.dispose(); }
  });
});
