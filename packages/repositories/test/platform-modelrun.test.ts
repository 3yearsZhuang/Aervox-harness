/**
 * Aervox｜思隅 @aervox/repositories — 阶段 7（ADR-017）ModelRun/ContextManifest 迁移与仓储测试
 *
 * 覆盖：
 * - Expand 迁移幂等：model_runs 新增 attempt_id/step_id、context_manifests 新增 snapshot_json
 *   （重建 schema 可重复执行不报错；列存在）；
 * - createModelRun 携带 attemptId/stepId；completeModelRun 收口；
 * - createContextManifest 最小化持久快照 + attachContextManifest 关联回写。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqlitePlatformRepository,
  type AervoxDatabase,
  type LocalContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

const ctx: LocalContext = { workspaceId: "ws_cm", subjectUserId: "usr_cm" };

describe("阶段 7 model_runs / context_manifests（ADR-017 Expand + Step 级关联）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqlitePlatformRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client); // 幂等：重复初始化（迁移重放）不报错
    await initDatabaseSchema(client);
    repo = new SqlitePlatformRepository(db);
  });

  it("Expand 迁移幂等：model_runs 含 attempt_id/step_id，context_manifests 含 snapshot_json", async () => {
    const info = await client.execute("PRAGMA table_info(model_runs)");
    const cols = new Set(info.rows.map((r) => r.name));
    expect(cols.has("attempt_id")).toBe(true);
    expect(cols.has("step_id")).toBe(true);
    const manifestInfo = await client.execute("PRAGMA table_info(context_manifests)");
    expect(new Set(manifestInfo.rows.map((r) => r.name)).has("snapshot_json")).toBe(true);
  });

  it("createModelRun 携带 attemptId/stepId；completeModelRun 收口", async () => {
    const run = await repo.createModelRun(ctx, {
      id: "mr_1",
      attemptId: "attempt_1",
      stepId: 2,
      purpose: "agent.loop",
      provider: "openai-compat",
      modelId: "deepseek-chat",
    });
    expect(run.attemptId).toBe("attempt_1");
    expect(run.stepId).toBe(2);
    expect(run.status).toBe("started");

    const done = await repo.completeModelRun(ctx, "mr_1", { status: "completed", latencyMs: 12, tokenUsage: { prompt: 10, completion: 5, total: 15 } });
    expect(done?.status).toBe("completed");
    expect(done?.latencyMs).toBe(12);
    expect((done?.tokenUsage as { total?: number }).total).toBe(15);
  });

  it("createContextManifest 保留请求元数据；attachContextManifest 关联回写 model_runs", async () => {
    await repo.createModelRun(ctx, {
      id: "mr_2",
      attemptId: "attempt_1",
      stepId: 1,
      purpose: "agent.loop",
      provider: "replay",
      modelId: "n/a",
    });
    const manifest = await repo.createContextManifest({
      id: "mcm_2",
      modelRunId: "mr_2",
      purpose: "agent.loop",
      sourceArtifactId: "turn:history",
      sourceRevisionId: "1",
      snapshot: [{ role: "user", content: "帮我总结" }],
    });
    expect(manifest.snapshot).toEqual({ version: 2, kind: "request-metadata", messageCount: 1,
      messageRoles: { system: 0, user: 1, assistant: 0, tool: 0 }, toolCount: 0 });

    const attached = await repo.attachContextManifest(ctx, "mr_2", "mcm_2");
    expect(attached?.contextManifestId).toBe("mcm_2");
  });

  it("writes only versioned request counts to raw SQLite, including nested tool and reasoning secrets", async () => {
    await repo.createModelRun(ctx, { id: "mr_private", purpose: "agent.loop", provider: "replay", modelId: "test" });
    await repo.createContextManifest({ id: "cm_private", modelRunId: "mr_private", purpose: "agent.loop",
      sourceArtifactId: "turn:history", sourceRevisionId: "1", snapshot: {
        version: 1,
        messages: [
          { id: "PRIVATE message-id", role: "system", content: "PRIVATE system prompt" },
          { role: "user", content: "PRIVATE user prompt" },
          { role: "assistant", content: "PRIVATE assistant", reasoning: "PRIVATE reasoning",
            toolCalls: [{ id: "PRIVATE call", name: "PRIVATE name", arguments: { secret: "PRIVATE arguments" } }] },
          { role: "tool", toolCallId: "PRIVATE call", name: "PRIVATE name", content: "PRIVATE tool result" },
        ],
        tools: [
          { name: "PRIVATE name", description: "PRIVATE tool description", inputSchema: { default: "PRIVATE schema" } },
          { name: "PRIVATE other", metadata: { secret: "PRIVATE nested extension" } },
        ],
        maxOutputTokens: 1024, temperature: 0.7,
        contentHash: "PRIVATE content hash", extra: "PRIVATE unknown field",
      } });
    const rows = await client.execute("SELECT snapshot_json FROM context_manifests WHERE id='cm_private'");
    const raw = String(rows.rows[0]!.snapshot_json);
    expect(raw).not.toContain("PRIVATE");
    expect(JSON.parse(raw)).toEqual({ version: 2, kind: "request-metadata", messageCount: 4,
      messageRoles: { system: 1, user: 1, assistant: 1, tool: 1 }, toolCount: 2,
      maxOutputTokens: 1024, temperature: 0.7 });
  });

  it("reprojects metadata and drops invalid generation values without retaining extension fields", async () => {
    await repo.createModelRun(ctx, { id: "mr_metadata", purpose: "agent.loop", provider: "replay", modelId: "test" });
    const manifest = await repo.createContextManifest({ id: "cm_metadata", modelRunId: "mr_metadata", purpose: "agent.loop",
      sourceArtifactId: "turn:history", sourceRevisionId: "1", snapshot: {
        version: 2, kind: "request-metadata", messageCount: 1,
        messageRoles: { system: 0, user: 1, assistant: 0, tool: 0, secret: "PRIVATE role" }, toolCount: 2,
        maxOutputTokens: -1, temperature: Number.POSITIVE_INFINITY,
        messages: [{ content: "PRIVATE prompt" }], tools: [{ inputSchema: "PRIVATE schema" }], contentHash: "PRIVATE hash",
      } });
    expect(manifest.snapshot).toEqual({ version: 2, kind: "request-metadata", messageCount: 1,
      messageRoles: { system: 0, user: 1, assistant: 0, tool: 0 }, toolCount: 2 });
    expect(String((await client.execute("SELECT snapshot_json FROM context_manifests WHERE id='cm_metadata'")).rows[0]!.snapshot_json))
      .not.toContain("PRIVATE");
  });

  it.each([
    undefined, "PRIVATE arbitrary body", { body: "PRIVATE arbitrary body" },
    { version: 3, messages: [{ role: "user", content: "PRIVATE prompt" }] },
    [{ role: "PRIVATE invalid role", content: "PRIVATE prompt" }],
    { version: 1, messages: [{ role: "user", content: "PRIVATE prompt" }], tools: "PRIVATE invalid tools" },
    { version: 2, kind: "request-metadata", messageCount: -1, messageRoles: { system: 0, user: 0, assistant: 0, tool: 0 }, toolCount: 0 },
    { version: 2, kind: "request-metadata", messageCount: 2, messageRoles: { system: 0, user: 1, assistant: 0, tool: 0 }, toolCount: 0 },
    { version: 2, kind: "request-metadata", messageCount: 1, messageRoles: { system: 0, user: 1, assistant: 0, tool: 0 }, toolCount: 0.5 },
  ])("does not persist an unknown or malformed snapshot %#", async snapshot => {
    await repo.createModelRun(ctx, { id: "mr_unknown", purpose: "agent.loop", provider: "replay", modelId: "test" });
    await repo.createContextManifest({ id: "cm_unknown", modelRunId: "mr_unknown", purpose: "agent.loop",
      sourceArtifactId: "turn:history", sourceRevisionId: "1", snapshot });
    expect((await client.execute("SELECT snapshot_json FROM context_manifests WHERE id='cm_unknown'")).rows[0]!.snapshot_json).toBeNull();
  });
});
