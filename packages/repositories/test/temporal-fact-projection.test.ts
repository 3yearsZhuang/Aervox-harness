import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createInMemoryDatabase, initDatabaseSchema } from "../src/index.js";
import { SqliteTemporalFactProjection } from "../src/temporal-fact-projection.js";

const recordedAt = "2026-03-05T00:00:00.000Z";
let client: Client;
let cleanup: () => Promise<void>;
let projection: SqliteTemporalFactProjection;

async function addVerifiedEvidence(id: string, options: { value?: string; ingestedAt?: string } = {}): Promise<void> {
  const artifactId = `artifact_${id}`;
  const sourceRevisionId = `source_${id}`;
  const memoryId = `memory_${id}`;
  const memoryRevisionId = `revision_${id}`;
  const now = options.ingestedAt ?? recordedAt;
  await client.execute({
    sql: `INSERT INTO source_artifacts
      (id, kind, owner_module, current_revision_id, occurred_at, ingested_at, status, created_at, updated_at)
      VALUES (?, 'message', 'conversation', ?, ?, ?, 'active', ?, ?)`,
    args: [artifactId, sourceRevisionId, now, now, now, now],
  });
  await client.execute({
    sql: `INSERT INTO source_revisions(id, artifact_id, checksum, content, version, created_at)
          VALUES (?, ?, ?, ?, 1, ?)`,
    args: [sourceRevisionId, artifactId, `checksum_${id}`, options.value ?? id, now],
  });
  await client.execute({
    sql: `INSERT INTO memory_records
      (id, layer, type, content, version, is_deleted, current_revision_id,
       verification_status, created_at, updated_at)
      VALUES (?, 'long_term', 'user_fact', ?, 1, 0, ?, 'verified', ?, ?)`,
    args: [memoryId, options.value ?? id, memoryRevisionId, now, now],
  });
  await client.execute({
    sql: `INSERT INTO memory_revisions(id, memory_id, content, created_at)
          VALUES (?, ?, ?, ?)`,
    args: [memoryRevisionId, memoryId, options.value ?? id, now],
  });
  await client.execute({
    sql: `INSERT INTO memory_evidence
      (id, memory_revision_id, source_artifact_id, source_revision_id, status, created_at)
      VALUES (?, ?, ?, ?, 'active', ?)`,
    args: [id, memoryRevisionId, artifactId, sourceRevisionId, now],
  });
}

function fact(id: string, value: string, validFrom: string) {
  return { id: `fact_${id}`, subjectId: "user_1", predicate: "residence_city",
    value, validFrom, memoryEvidenceId: id };
}

beforeEach(async () => {
  const db = await createInMemoryDatabase();
  client = db.client;
  cleanup = db.cleanup;
  await initDatabaseSchema(client);
  projection = new SqliteTemporalFactProjection(client);
});

afterEach(async () => {
  await cleanup();
});

describe("SQLite 时态事实投影", () => {
  it("写入并替换已确认事实，分别查询当前和历史有效区间", async () => {
    await addVerifiedEvidence("beijing", { value: "北京" });
    await addVerifiedEvidence("shanghai", { value: "上海", ingestedAt: "2026-04-03T00:00:00.000Z" });
    expect((await projection.apply(fact("beijing", "北京", "2025-01-01T00:00:00.000Z"))).kind).toBe("insert");
    expect((await projection.apply(fact("shanghai", "上海", "2026-04-01T00:00:00.000Z"))).kind).toBe("replace");

    expect((await projection.listAt("user_1", "residence_city", "2025-06-01T00:00:00.000Z"))[0]).toMatchObject({
      value: "北京", validTo: "2026-04-01T00:00:00.000Z", recordedAt,
    });
    expect((await projection.listCurrent("user_1", "residence_city"))[0]).toMatchObject({
      value: "上海", validFrom: "2026-04-01T00:00:00.000Z",
      recordedAt: "2026-04-03T00:00:00.000Z",
    });
    expect(await projection.listAt("user_2", "residence_city", "2025-06-01T00:00:00.000Z")).toEqual([]);
  });

  it("同值只追加证据，重复提交不复制证据；来源删除后立即停止查询", async () => {
    await addVerifiedEvidence("first", { value: "北京" });
    await addVerifiedEvidence("second", { value: "北京" });
    await projection.apply(fact("first", "北京", "2025-01-01T00:00:00.000Z"));
    expect((await projection.apply(fact("second", "北京", "2026-04-01T00:00:00.000Z"))).kind).toBe("corroborate");
    await projection.apply(fact("second", "北京", "2026-04-01T00:00:00.000Z"));
    expect((await projection.listEvidence("fact_first")).map((item) => item.memoryEvidenceId)).toEqual(["first", "second"]);

    await client.execute("UPDATE source_artifacts SET status = 'deleted', deleted_at = '2026-05-01T00:00:00.000Z' WHERE id = 'artifact_first'");
    expect((await projection.listEvidence("fact_first")).map((item) => item.active)).toEqual([false, true]);
    expect(await projection.listCurrent("user_1", "residence_city")).toHaveLength(1);
    await client.execute("UPDATE memory_records SET verification_status = 'invalidated' WHERE id = 'memory_second'");
    expect(await projection.listCurrent("user_1", "residence_city")).toEqual([]);
    expect(await projection.listAt("user_1", "residence_city", "2025-06-01T00:00:00.000Z")).toEqual([]);
  });

  it("同刻矛盾、迟到输入和同一来源修订矛盾不改写数据库", async () => {
    await addVerifiedEvidence("first", { value: "北京" });
    await addVerifiedEvidence("second", { value: "上海" });
    await projection.apply(fact("first", "北京", "2025-01-01T00:00:00.000Z"));
    expect(await projection.apply(fact("second", "上海", "2025-01-01T00:00:00.000Z"))).toMatchObject({
      kind: "review", reason: "same_time_conflict",
    });
    expect(await projection.apply(fact("second", "上海", "2024-01-01T00:00:00.000Z"))).toMatchObject({
      kind: "review", reason: "out_of_order",
    });
    expect(await projection.apply({ ...fact("first", "上海", "2026-01-01T00:00:00.000Z"), id: "fact_first_other" })).toMatchObject({
      kind: "review", reason: "source_revision_conflict",
    });
    const rows = await client.execute("SELECT id, valid_to FROM temporal_facts");
    expect(rows.rows).toMatchObject([{ id: "fact_first", valid_to: null }]);
  });

  it("拒绝未确认记忆及已修订来源，失败写入保持原区间开放", async () => {
    await addVerifiedEvidence("first", { value: "北京" });
    await addVerifiedEvidence("second", { value: "上海" });
    await projection.apply(fact("first", "北京", "2025-01-01T00:00:00.000Z"));
    await client.execute("UPDATE memory_records SET verification_status = 'unverified' WHERE id = 'memory_second'");
    await expect(projection.apply(fact("second", "上海", "2026-04-01T00:00:00.000Z"))).rejects.toThrow("active evidence");
    await client.execute("UPDATE memory_records SET verification_status = 'verified' WHERE id = 'memory_second'");
    await client.execute("UPDATE source_revisions SET superseded_at = '2026-04-02T00:00:00.000Z' WHERE id = 'source_second'");
    await expect(projection.apply(fact("second", "上海", "2026-04-01T00:00:00.000Z"))).rejects.toThrow("active evidence");
    await client.execute("UPDATE source_revisions SET superseded_at = NULL WHERE id = 'source_second'");
    await expect(projection.apply({ ...fact("second", "上海", "2026-04-01T00:00:00.000Z"), id: "fact_first" })).rejects.toThrow();
    expect((await client.execute("SELECT valid_to FROM temporal_facts WHERE id = 'fact_first'")).rows[0]?.valid_to).toBeNull();
  });
});
