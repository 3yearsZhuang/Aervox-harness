import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, SqlitePluginConfigRepository } from "../src/index.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
describe("atomic message and config writes", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let conversations: SqliteConversationRepository;
  let configs: SqlitePluginConfigRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    conversations = new SqliteConversationRepository(database.db);
    configs = new SqlitePluginConfigRepository(database.db);
  });
  afterEach(async () => { await database.cleanup(); });
  async function seedMessage() {
    await conversations.getOrCreateSession(ctx, "s");
    await conversations.createTurnWithOutbox(ctx, { id: "t", sessionId: "s", idempotencyKey: "t" }, { id: "v1", content: "old" });
    await conversations.createMessage(ctx, { id: "m", sessionId: "s", role: "user" });
    await database.client.execute("UPDATE message_versions SET message_id = 'm' WHERE id = 'v1'");
    await database.client.execute("UPDATE messages SET current_version_id = 'v1' WHERE id = 'm'");
  }
  it.each([
    "BEFORE UPDATE OF superseded_at ON message_versions",
    "BEFORE INSERT ON message_versions",
    "BEFORE UPDATE OF current_version_id ON messages",
  ])("rolls back message edits on %s failure", async (point) => {
    await seedMessage();
    await database.client.execute(`CREATE TRIGGER fail_edit ${point} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await expect(conversations.editMessage(ctx, "m", "new", 1)).rejects.toThrow("injected");
    expect(await conversations.listMessageVersions(ctx, "m")).toMatchObject([{ id: "v1", content: "old", supersededAt: null }]);
    expect((await conversations.getMessage(ctx, "m"))?.currentVersionId).toBe("v1");
  });
  it("concurrent edits at one version have exactly one winner", async () => {
    await seedMessage();
    const results = await Promise.all(["a", "b"].map((content) => conversations.editMessage(ctx, "m", content, 1)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const versions = await conversations.listMessageVersions(ctx, "m");
    expect(versions).toHaveLength(2);
    expect(versions.filter((v) => !v.supersededAt)).toHaveLength(1);
    expect((await conversations.getMessage(ctx, "m"))?.currentVersionId).toBe(versions[0]!.id);
  });
  const save = (revision: number, value: string | null) => configs.saveConfig(ctx, {
    pluginId: "p", expectedRevision: revision, schemaVersion: 1,
    values: { endpoint: value }, secretKeys: [], secretChanges: { key: value },
  });
  const secrets = async () => (await database.client.execute("SELECT field_key, value_json FROM plugin_config_secrets WHERE plugin_id = 'p'")).rows;
  it("stale revisions cannot change or delete secrets, including missing config", async () => {
    expect((await save(9, "ghost")).conflict).toBe(true);
    expect(await secrets()).toEqual([]);
    await save(0, "old");
    const before = await secrets();
    expect((await save(0, "replacement")).conflict).toBe(true);
    expect((await save(0, null)).conflict).toBe(true);
    expect(await secrets()).toEqual(before);
  });
  it.each(["BEFORE UPDATE ON plugin_configs", "BEFORE INSERT ON plugin_config_secrets"])("rolls back config and secrets on %s failure", async (point) => {
    await save(0, "old");
    const before = await secrets();
    await database.client.execute(`CREATE TRIGGER fail_config ${point} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await expect(save(1, "new")).rejects.toThrow("injected");
    expect(await secrets()).toEqual(before);
    expect(await configs.getConfig(ctx, "p")).toMatchObject({ revision: 1, valuesJson: { endpoint: "old" } });
  });
  it("concurrent same-revision saves commit one matching config and secret", async () => {
    await save(0, "old");
    const results = await Promise.all([save(1, "a"), save(1, "b")]);
    expect(results.filter((r) => !r.conflict)).toHaveLength(1);
    const config = await configs.getConfig(ctx, "p");
    expect(config?.revision).toBe(2);
    expect(JSON.parse(String((await secrets())[0]!.value_json))).toBe((config?.valuesJson as { endpoint: string }).endpoint);
  });
  it("reset rolls back credential deletion if config write fails", async () => {
    await save(0, "old");
    const before = await secrets();
    await database.client.execute("CREATE TRIGGER fail_reset BEFORE UPDATE ON plugin_configs BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(configs.resetConfig(ctx, "p", 1, {})).rejects.toThrow("injected");
    expect(await secrets()).toEqual(before);
  });
});
