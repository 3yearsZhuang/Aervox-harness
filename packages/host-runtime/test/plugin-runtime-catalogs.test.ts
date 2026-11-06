import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteExtensionRepository, SqliteToolRegistryRepository } from "@aervox/repositories";
import { createDefaultQuestionBankRegistry } from "@aervox/practice-review";
import { defaultDiaryStyleRegistry } from "@aervox/diary";
import type { PluginHostServices, ServerPluginRegistration } from "@aervox/host-plugin-api";
import anki from "@aervox/plugin-anki-sync/server";
import diary from "@aervox/plugin-diary-distillers/server";
import { createPluginHostServicesFactory } from "../src/plugin-host-services.js";
import { createRuntimeToolSink } from "../src/plugin-runtime-tools.js";
import { createPluginApiRegistry } from "../src/plugin-api-registry.js";
import { ToolRuntime } from "../src/modules/ecosystem/tools/runtime.js";
import { createRuntimeToolProvider } from "../src/modules/companion/conversation/tool-providers.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const manifests = ["tool/anki-sync", "workflow/diary-distillers"].map(directory => JSON.parse(readFileSync(
  new URL(`../../../plugins/plugins/${directory}/plugin.manifest.json`, import.meta.url), "utf8")));
const ankiId = "ap-tool-anki-sync.anki_list_providers";

describe("trusted Manifest tools dispatched by the existing Core runtime", () => {
  let memory: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let plugins: SqliteExtensionRepository;
  let runtime: ToolRuntime;
  let services: ReturnType<typeof createPluginHostServicesFactory>;
  let api: ReturnType<typeof createPluginApiRegistry>;
  const questionBanks = createDefaultQuestionBankRegistry();
  let releases: Array<() => void>;

  beforeEach(async () => {
    memory = await createInMemoryDatabase();
    plugins = new SqliteExtensionRepository(memory.db);
    runtime = new ToolRuntime({ registry: new SqliteToolRegistryRepository(memory.db) });
    api = createPluginApiRegistry(); releases = [];
    services = createPluginHostServicesFactory(memory.db, () => undefined, { questionBanks, diaryStyles: defaultDiaryStyleRegistry });
    for (const manifest of manifests) {
      await plugins.createPlugin({ id: manifest.metadata.id, publisher: "aervox-official", version: manifest.metadata.version, checksum: "fixture-content" });
      for (const tool of manifest.spec.tools) await runtime.registerTool({
        id: `${manifest.metadata.id}.${tool.name}`, pluginId: manifest.metadata.id, ...tool,
        safetyLevel: tool.safetyLevel === "read_only" ? "read_only" : "write_with_approval",
      });
    }
  });
  afterEach(async () => { releases.reverse().forEach(release => release()); runtime.dispose(); await memory.cleanup(); vi.restoreAllMocks(); });

  async function bind(registration = anki, factory = services) {
    const sink = createRuntimeToolSink({ runtime, plugins, api, services: factory });
    const release = await sink(registration.pluginId, registration.runtimeToolContributions!, registration.runtimeToolVersion);
    releases.push(release); return release;
  }
  async function grant(pluginId = anki.pluginId, permission = "learning.read", id = "read-grant", scope = "*") {
    return plugins.grantPlugin(local, { id, pluginId, permission, scope });
  }
  async function counts() {
    const tables = (await memory.client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).rows;
    return (await memory.client.execute(tables.map(row => {
      const name = String(row.name).replaceAll('"', '""');
      return `SELECT '${name.replaceAll("'", "''")}' AS name, COUNT(*) AS count FROM "${name}"`;
    }).join(" UNION ALL "))).rows;
  }
  function delayedFactory() {
    let finish!: (value: Awaited<ReturnType<NonNullable<PluginHostServices["catalogs"]>["listQuestionBankProviders"]>>) => void;
    const promise = new Promise<Awaited<ReturnType<NonNullable<PluginHostServices["catalogs"]>["listQuestionBankProviders"]>>>(resolve => { finish = resolve; });
    const read = vi.fn(() => promise);
    const factory: typeof services = (ctx, control) => ({ ...services(ctx, control), catalogs: {
      listQuestionBankProviders: read, listDiaryStyles: async () => [],
    } });
    return { read, factory, finish: () => finish(questionBanks.list()) };
  }

  it("returns the actual registry metadata with no model, endpoint or config and makes no persistent changes", async () => {
    await grant(); await grant(diary.pluginId, "diary.read", "diary-grant");
    await bind(); await bind(diary);
    const before = await counts();
    expect(await runtime.callTool(local, ankiId, {})).toEqual({ providers: questionBanks.list() });
    expect(await runtime.callTool(local, `${diary.pluginId}.diary_list_styles`, {})).toEqual({ items: defaultDiaryStyleRegistry.list().map(
      ({ id, name, description, targetScene }) => ({ id, name, description, targetScene })) });
    expect(await counts()).toEqual(before);
    expect((await runtime.exportRegistry()).map(tool => tool.name).sort()).toEqual(["anki_list_providers", "diary_list_styles"]);
    await expect(runtime.callTool(local, `${anki.pluginId}.anki_import_deck`, { content: "front\tback" }, { approval: true })).rejects.toThrow("handler not registered");
    await expect(runtime.callTool(local, `${diary.pluginId}.diary_generate_styled`, {}, { approval: true })).rejects.toThrow("handler not registered");
  });

  it("requires the exact permission, plugin owner and scope even for direct calls", async () => {
    await bind();
    await expect(runtime.callTool(local, ankiId, {})).rejects.toThrow("permission denied");
    await grant(diary.pluginId, "learning.read", "foreign"); await grant(anki.pluginId, "learning.read", "narrow", "session");
    await expect(runtime.callTool(local, ankiId, {})).rejects.toThrow("permission denied");
    await grant(); expect(await runtime.callTool(local, ankiId, {})).toHaveProperty("providers");
    await plugins.revokePluginGrant(local, "read-grant", anki.pluginId);
    await expect(runtime.callTool(local, ankiId, {})).rejects.toThrow("permission denied");
  });

  it.each(["disabled", "missing", "invalid", "deleted", "version", "checksum"])("refuses %s installations at dispatch", async change => {
    await grant(); await bind();
    if (change === "disabled") await plugins.setPluginEnabled(anki.pluginId, false);
    else if (change === "missing" || change === "invalid") await plugins.setPluginAvailability(anki.pluginId, change);
    else if (change === "deleted") await plugins.deletePlugin(anki.pluginId);
    else await plugins.createPlugin({ id: anki.pluginId, publisher: "test", version: change === "version" ? "1.2.0" : "1.1.0", checksum: change === "checksum" ? "changed-content" : "fixture-content" });
    await expect(runtime.callTool(local, ankiId, {})).rejects.toThrow();
  });

  it.each(["disabled", "generation", "checksum", "revoke-and-regrant"])("drops late metadata after %s and does not reuse renewed authority", async change => {
    await grant(); const pending = delayedFactory(); await bind(anki, pending.factory);
    const call = runtime.callTool(local, ankiId, {}); const rejected = expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(pending.read).toHaveBeenCalledOnce());
    if (change === "disabled") await plugins.setPluginEnabled(anki.pluginId, false);
    if (change === "generation") { await plugins.setPluginEnabled(anki.pluginId, false); await plugins.setPluginEnabled(anki.pluginId, true); }
    if (change === "checksum") await plugins.createPlugin({ id: anki.pluginId, publisher: "test", version: "1.1.0", checksum: "new-content" });
    if (change === "revoke-and-regrant") { await plugins.revokePluginGrant(local, "read-grant"); await grant(anki.pluginId, "learning.read", "new-grant"); }
    pending.finish(); await rejected;
    if (change === "generation" || change === "revoke-and-regrant") expect(await runtime.callTool(local, ankiId, {})).toHaveProperty("providers");
  });

  it("cancels a pending read and never releases its late result", async () => {
    await grant(); const pending = delayedFactory(); await bind(anki, pending.factory);
    const controller = new AbortController();
    const call = runtime.callTool(local, ankiId, {}, { signal: controller.signal });
    const rejected = expect(call).rejects.toThrow("cancel_metadata");
    await vi.waitFor(() => expect(pending.read).toHaveBeenCalledOnce()); controller.abort(new Error("cancel_metadata"));
    await rejected; pending.finish();
    expect(await runtime.callTool(local, ankiId, {})).toHaveProperty("providers");
  });

  it("rejects a permission declaration changed while a handler was already running", async () => {
    await grant(); const pending = delayedFactory(); await bind(anki, pending.factory);
    const call = runtime.callTool(local, ankiId, {}); const rejected = expect(call).rejects.toThrow("declaration changed");
    await vi.waitFor(() => expect(pending.read).toHaveBeenCalledOnce());
    const declaration = (await runtime.listTools()).find(tool => tool.id === ankiId)!;
    await runtime.registerTool({ id: ankiId, pluginId: anki.pluginId, name: declaration.name, description: declaration.description,
      category: declaration.category, safetyLevel: "read_only", inputSchema: declaration.inputSchemaJson, requiredPermissions: ["diary.read"] });
    pending.finish(); await rejected;
    expect(await plugins.hasPluginGrant(local, anki.pluginId, "learning.read", "*")).toBe(true);
  });

  it("does not recapture a new lifecycle after the handler's first installation read was delayed", async () => {
    await grant();
    let held = false; let enter!: () => void; let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const bridgePlugins = {
      getPlugin: plugins.getPlugin.bind(plugins),
      async readPluginToolPermit(...args: Parameters<typeof plugins.readPluginToolPermit>) {
        if (held) { held = false; enter(); await blocked; }
        return plugins.readPluginToolPermit(...args);
      },
    };
    const sink = createRuntimeToolSink({ runtime, plugins: bridgePlugins, services, api });
    releases.push(await sink(anki.pluginId, anki.runtimeToolContributions!, anki.runtimeToolVersion));
    const initial = (await plugins.getPlugin(anki.pluginId))!;
    const provider = createRuntimeToolProvider(runtime, local, {
      conversationRepo: new SqliteConversationRepository(memory.db), pluginPermitReader: plugins, generationFor: () => initial.lifecycleGeneration!,
      async isToolAllowed() { const current = await plugins.getPlugin(anki.pluginId); return current?.enabled === 1 && current.lifecycleGeneration === initial.lifecycleGeneration; },
    });
    await provider.listTools!(); held = true;
    const call = provider.execute({ name: "anki_list_providers", arguments: {}, turnId: "", attemptId: "", invocationId: "" });
    await entered;
    await plugins.setPluginEnabled(anki.pluginId, false); await plugins.setPluginEnabled(anki.pluginId, true);
    await plugins.revokePluginGrant(local, "read-grant"); await grant(anki.pluginId, "learning.read", "renewed-read");
    resume();
    expect(await call).toMatchObject({ ok: false, error: "plugin_generation_changed" });
    expect(await runtime.callTool(local, ankiId, {})).toHaveProperty("providers");
  });

  it("rejects a direct call whose captured installation snapshot returned after a lifecycle replacement", async () => {
    await grant(); let held = false; let enter!: () => void; let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const bridgePlugins = {
      getPlugin: plugins.getPlugin.bind(plugins),
      async readPluginToolPermit(...args: Parameters<typeof plugins.readPluginToolPermit>) {
        const captured = await plugins.readPluginToolPermit(...args);
        if (held) { held = false; enter(); await blocked; }
        return captured;
      },
    };
    const sink = createRuntimeToolSink({ runtime, plugins: bridgePlugins, services, api });
    releases.push(await sink(anki.pluginId, anki.runtimeToolContributions!, anki.runtimeToolVersion));
    held = true;
    const call = runtime.callTool(local, ankiId, {}); const rejected = expect(call).rejects.toThrow("plugin_generation_changed");
    await entered;
    await plugins.setPluginEnabled(anki.pluginId, false); await plugins.setPluginEnabled(anki.pluginId, true);
    await plugins.revokePluginGrant(local, "read-grant"); await grant(anki.pluginId, "learning.read", "renewed-direct");
    resume(); await rejected;
    expect(await runtime.callTool(local, ankiId, {})).toHaveProperty("providers");
  });

  it.each(["generation", "declaration", "grant"])("uses a coherent final model permit after a delayed read (%s)", async change => {
    await grant(); await bind();
    const initial = (await plugins.getPlugin(anki.pluginId))!;
    let enter!: () => void; let resume!: () => void; let reads = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const reader = { async readPluginToolPermit(...args: Parameters<typeof plugins.readPluginToolPermit>) {
      if (++reads === 2) { enter(); await blocked; }
      return plugins.readPluginToolPermit(...args);
    } };
    const allowed = vi.fn(async (tool: Awaited<ReturnType<typeof runtime.listTools>>[number]) => {
      const current = await plugins.getPlugin(anki.pluginId);
      if (current?.enabled !== 1 || current.lifecycleGeneration !== initial.lifecycleGeneration) return false;
      for (const permission of tool.requiredPermissionsJson as string[]) if (!(await plugins.hasPluginGrant(local, anki.pluginId, permission, "*"))) return false;
      return true;
    });
    const provider = createRuntimeToolProvider(runtime, local, {
      conversationRepo: new SqliteConversationRepository(memory.db), pluginPermitReader: reader,
      generationFor: () => initial.lifecycleGeneration!, isToolAllowed: allowed,
    });
    await provider.listTools!();
    const call = provider.execute({ name: "anki_list_providers", arguments: {}, turnId: "", attemptId: "", invocationId: "" });
    await entered;
    if (change === "generation") { await plugins.setPluginEnabled(anki.pluginId, false); await plugins.setPluginEnabled(anki.pluginId, true); }
    if (change === "generation" || change === "grant") {
      await plugins.revokePluginGrant(local, "read-grant"); await grant(anki.pluginId, "learning.read", "renewed-final-read");
    }
    if (change === "declaration") {
      const declaration = (await runtime.listTools()).find(tool => tool.id === ankiId)!;
      await runtime.registerTool({ id: ankiId, pluginId: anki.pluginId, name: declaration.name, description: declaration.description,
        category: declaration.category, safetyLevel: "read_only", inputSchema: declaration.inputSchemaJson, requiredPermissions: ["diary.read"] });
      expect(await plugins.hasPluginGrant(local, anki.pluginId, "diary.read", "*")).toBe(false);
    }
    const checksBeforeFinalPermit = allowed.mock.calls.length;
    resume();
    const expected = change === "generation" ? "plugin_generation_changed" : change === "declaration" ? "declaration changed" : "permission denied";
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining(expected) });
    expect(allowed).toHaveBeenCalledTimes(checksBeforeFinalPermit);
  });

  it.each(["before-snapshot", "after-snapshot"])("uses one final declaration/grant SQL snapshot (%s) with an explicit delivery observation window", async timing => {
    await grant(); let catalogReturned = false; let delayed = false; let enter!: () => void; let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const bridgePlugins = {
      getPlugin: plugins.getPlugin.bind(plugins),
      async readPluginToolPermit(...args: Parameters<typeof plugins.readPluginToolPermit>) {
        if (catalogReturned && !delayed) {
          delayed = true;
          const captured = timing === "after-snapshot" ? await plugins.readPluginToolPermit(...args) : undefined;
          enter(); await blocked;
          return captured ?? plugins.readPluginToolPermit(...args);
        }
        return plugins.readPluginToolPermit(...args);
      },
    };
    const factory: typeof services = (ctx, control) => ({ ...services(ctx, control), catalogs: {
      listQuestionBankProviders: async () => { catalogReturned = true; return questionBanks.list(); }, listDiaryStyles: async () => [],
    } });
    const sink = createRuntimeToolSink({ runtime, plugins: bridgePlugins, services: factory, api });
    releases.push(await sink(anki.pluginId, anki.runtimeToolContributions!, anki.runtimeToolVersion));
    const call = runtime.callTool(local, ankiId, {});
    const outcome = timing === "before-snapshot" ? expect(call).rejects.toThrow("declaration changed")
      : expect(call).resolves.toEqual({ providers: questionBanks.list() });
    await entered;
    const declaration = (await runtime.listTools()).find(tool => tool.id === ankiId)!;
    await runtime.registerTool({ id: ankiId, pluginId: anki.pluginId, name: declaration.name, description: declaration.description,
      category: declaration.category, safetyLevel: "read_only", inputSchema: declaration.inputSchemaJson, requiredPermissions: ["diary.read"] });
    resume(); await outcome;
    const current = await plugins.readPluginToolPermit(local, anki.pluginId, ankiId);
    expect(current.tool?.requiredPermissionsJson).toEqual(["diary.read"]); expect(current.grants).toEqual([]);
  });

  it("preserves embedded NUL identities, permissions and scopes in the combined SQLite projection", async () => {
    const grantId = "grant\u0000first";
    await grant(anki.pluginId, "learning.read", grantId);
    expect((await plugins.readPluginToolPermit(local, anki.pluginId, ankiId)).grants[0]?.id).toBe(grantId);
    const pending = delayedFactory(); await bind(anki, pending.factory);
    const call = runtime.callTool(local, ankiId, {}); const rejected = expect(call).rejects.toThrow("permission denied");
    await vi.waitFor(() => expect(pending.read).toHaveBeenCalledOnce());
    await plugins.revokePluginGrant(local, grantId); await grant(anki.pluginId, "learning.read", "grant\u0000second");
    pending.finish(); await rejected;
    await memory.client.execute({ sql: "UPDATE plugins SET checksum = ? WHERE id = ?", args: ["digest\u0000suffix", anki.pluginId] });
    expect((await plugins.readPluginToolPermit(local, anki.pluginId, ankiId)).plugin?.checksum).toBe("digest\u0000suffix");
    await memory.client.execute({ sql: "UPDATE plugin_grants SET permission = ?, scope = ? WHERE id = ?", args: ["learning.read\u0000foreign", "*\u0000foreign", "grant\u0000second"] });
    expect((await plugins.readPluginToolPermit(local, anki.pluginId, ankiId)).grants).toEqual([]);
  });

  it("rejects an exact declaration name containing NUL rather than matching its truncated prefix", async () => {
    await memory.client.execute({ sql: "UPDATE tool_registrations SET name = ? WHERE id = ?", args: ["anki_list_providers\u0000foreign", ankiId] });
    expect((await plugins.readPluginToolPermit(local, anki.pluginId, ankiId)).tool?.name).toBe("anki_list_providers\u0000foreign");
    await expect(bind()).rejects.toThrow("declaration_mismatch");
  });

  it.each(["integer", "text"])("rejects invalid %s metadata without a lossy identity comparison", async value => {
    if (value === "integer") await memory.client.execute({ sql: "UPDATE tool_registrations SET priority = 9007199254740993 WHERE id = ?", args: [ankiId] });
    else await memory.client.execute({ sql: "UPDATE plugins SET checksum = CAST(x'FF' AS TEXT) WHERE id = ?", args: [anki.pluginId] });
    await expect(plugins.readPluginToolPermit(local, anki.pluginId, ankiId)).rejects.toThrow(`plugin_tool_permit_${value}_invalid`);
  });

  it("refuses an over-budget active-grant projection instead of silently truncating authority", async () => {
    const requiredPermissions = Array.from({ length: 257 }, (_, index) => `catalog.read.${index}`);
    const declaration = (await runtime.listTools()).find(tool => tool.id === ankiId)!;
    await runtime.registerTool({ id: ankiId, pluginId: anki.pluginId, name: declaration.name, description: declaration.description,
      category: declaration.category, safetyLevel: "read_only", inputSchema: declaration.inputSchemaJson, requiredPermissions });
    for (const [index, permission] of requiredPermissions.entries()) await grant(anki.pluginId, permission, `budget-grant-${index}`);
    await expect(plugins.readPluginToolPermit(local, anki.pluginId, ankiId)).rejects.toThrow("budget_exceeded");
    await expect(bind()).rejects.toThrow("budget_exceeded");
    expect(await runtime.exportRegistry()).toEqual([]);
  });

  it("fails closed for a legacy host without the optional catalog port", async () => {
    await bind(anki, createPluginHostServicesFactory(memory.db));
    expect(await runtime.exportRegistry()).toEqual([]);
    await expect(runtime.callTool(local, ankiId, {})).rejects.toThrow("handler not registered");
  });

  it("refuses a metadata model binding without the coherent permit reader", async () => {
    await grant(); await bind();
    const provider = createRuntimeToolProvider(runtime, local, { conversationRepo: new SqliteConversationRepository(memory.db) });
    await provider.listTools!();
    expect(await provider.execute({ name: "anki_list_providers", arguments: {}, turnId: "", attemptId: "", invocationId: "" }))
      .toMatchObject({ ok: false, error: "plugin_metadata_permit_unavailable" });
  });

  it("requires the compiled Manifest version and exact persisted schema before binding", async () => {
    await expect(bind({ ...anki, runtimeToolVersion: undefined })).rejects.toThrow("identity_unavailable");
    await expect(bind({ ...anki, runtimeToolVersion: "1.0.1" })).rejects.toThrow("identity_unavailable");
    const declaration = (await runtime.listTools()).find(tool => tool.id === ankiId)!;
    await runtime.registerTool({ id: ankiId, name: declaration.name, pluginId: anki.pluginId, description: declaration.description,
      category: declaration.category, safetyLevel: "read_only", inputSchema: { type: "array" } });
    await expect(bind()).rejects.toThrow("declaration_mismatch");
    expect(await runtime.exportRegistry()).toEqual([]);
  });

  it("uses the Core input validator and rejects cancellation before entering the catalog port", async () => {
    await grant(); const pending = delayedFactory(); await bind(anki, pending.factory);
    await expect(runtime.callTool(local, ankiId, [])).rejects.toThrow();
    const controller = new AbortController(); controller.abort(new Error("already_cancelled"));
    await expect(runtime.callTool(local, ankiId, {}, { signal: controller.signal })).rejects.toThrow("already_cancelled");
    expect(pending.read).not.toHaveBeenCalled();
  });

  it.each(["declaration", "projection"])("refuses a context-dependent %s before executing its provider", async change => {
    await grant(); const execute = vi.fn(async () => ({ ok: true, output: { providers: [] } }));
    let changed = false;
    const registration: ServerPluginRegistration = { ...anki, runtimeToolContributions: host => anki.runtimeToolContributions!(host).map(contribution => ({
      ...contribution,
      resultProjection: changed && change === "projection" ? { safeParse: contribution.resultProjection!.safeParse } : contribution.resultProjection,
      provider: { ...contribution.provider, execute, tools: contribution.provider.tools.map(tool =>
        changed && change === "declaration" ? { ...tool, description: "changed metadata" } : tool) },
    })) };
    await bind(registration); changed = true;
    await expect(runtime.callTool(local, ankiId, {})).rejects.toThrow("declaration changed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rolls back the whole batch on a bad second declaration and disposes a successful binding", async () => {
    const registration: ServerPluginRegistration = { ...anki, runtimeToolContributions: host => [
      ...anki.runtimeToolContributions!(host), { id: "foreign", provider: { tools: [{ name: "missing_tool", description: "missing", parameters: {}, readOnly: true }], execute: async () => ({ ok: true }) } },
    ] };
    await expect(bind(registration)).rejects.toThrow("declaration_mismatch");
    expect(await runtime.exportRegistry()).toEqual([]);
    await grant(); const release = await bind(); expect(await runtime.exportRegistry()).toHaveLength(1);
    await expect(bind(registration)).rejects.toThrow("declaration_mismatch");
    expect(await runtime.callTool(local, ankiId, {})).toHaveProperty("providers");
    release(); release(); expect(await runtime.exportRegistry()).toEqual([]);
  });
});
