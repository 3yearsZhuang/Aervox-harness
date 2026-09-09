/**
 * Aervox｜思隅 @aervox/database — 阶段 7（ADR-017）ModelRun/ContextManifest 迁移与仓储测试
 *
 * 覆盖：
 * - Expand 迁移幂等：model_runs 新增 attempt_id/step_id、context_manifests 新增 snapshot_json
 *   （重建 schema 可重复执行不报错；列存在）；
 * - createModelRun 携带 attemptId/stepId；completeModelRun 收口；
 * - createContextManifest 携带 snapshot 快照 + attachContextManifest 关联回写。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqlitePlatformRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

const tenant: TenantContext = { workspaceId: "ws_cm", subjectUserId: "usr_cm" };

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
    const run = await repo.createModelRun(tenant, {
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

    const done = await repo.completeModelRun(tenant, "mr_1", { status: "completed", latencyMs: 12, tokenUsage: { prompt: 10, completion: 5, total: 15 } });
    expect(done?.status).toBe("completed");
    expect(done?.latencyMs).toBe(12);
    expect((done?.tokenUsage as { total?: number }).total).toBe(15);
  });

  it("createContextManifest 携带 snapshot；attachContextManifest 关联回写 model_runs", async () => {
    await repo.createModelRun(tenant, {
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
    expect((manifest.snapshot as Array<{ content: string }>)[0].content).toBe("帮我总结");

    const attached = await repo.attachContextManifest(tenant, "mr_2", "mcm_2");
    expect(attached?.contextManifestId).toBe("mcm_2");
  });
});