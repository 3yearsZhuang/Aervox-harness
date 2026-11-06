import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { expect, it } from "vitest";
import { createDatabase, initDatabaseSchema, migrateDatabaseViaStaging } from "../src/index.js";
import { CURRENT_SCHEMA_VERSION, SCHEMA_RELEASES, schemaManifest, inspectSchemaParity } from "../src/schema/manifest.js";
import { buildPortableSchemaArtifact } from "../src/schema/portable-artifact.js";

const VERSION_ONE_QUESTION_SQL = 'CREATE TABLE "pending_user_questions" ("turn_id" text NOT NULL PRIMARY KEY, "attempt_id" text NOT NULL, "step" integer NOT NULL, "questions_json" text NOT NULL, "timeout_ms" integer NOT NULL, "expires_at" text NOT NULL, "created_at" text NOT NULL)';

// Reconstruct unchanged v1 declarations and the frozen changed table. The
// released fingerprint proves this is the full real v1 physical schema.
async function initializeVersionOne(client: Client) {
  const manifest = schemaManifest("main").map(table => table.name === "pending_user_questions"
    ? { ...table, sql: VERSION_ONE_QUESTION_SQL, columns: table.columns.filter(column => column.name !== "invocation_id") }
    : table);
  expect(createHash("sha256").update(JSON.stringify(manifest)).digest("hex")).toBe(SCHEMA_RELEASES[1]!.main);
  for (const table of manifest) await client.execute(table.sql);
  for (const table of manifest) for (const index of table.indexes) await client.execute(index.sql);
  await client.execute({ sql: 'INSERT INTO "_aervox_schema_versions" VALUES(?,?,?,?)', args: ["main", "1", SCHEMA_RELEASES[1]!.main, "2026-11-01T00:00:00.000Z"] });
}

it("preserves the full v1 source, old question identity and rollback bytes through explicit staging", async () => {
  expect(CURRENT_SCHEMA_VERSION).toBe(2);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-question-v1-"));
  const sourcePath = path.join(directory, "source.db");
  const stagingPath = path.join(directory, "staging.db");
  const rollbackPath = path.join(directory, "rollback.db");
  try {
    const source = (await createDatabase({ url: `file:${sourcePath}` })).client;
    await initializeVersionOne(source);
    const questions = '[{"id":"old-question","question":"Keep the original question?"}]';
    await source.execute({ sql: "INSERT INTO pending_user_questions VALUES(?,?,?,?,?,?,?)", args: ["old-turn", "old-attempt", 2, questions, 60000, "2099-01-01T00:01:00.000Z", "2099-01-01T00:00:00.000Z"] });
    await source.execute("INSERT INTO sessions(id,title,created_at,updated_at) VALUES('old-session','Keep this session','t','t')");
    await source.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    source.close();
    const original = await fs.readFile(sourcePath);
    const rejected = await createDatabase({ url: `file:${sourcePath}` });
    await expect(initDatabaseSchema(rejected.client)).rejects.toThrow("migration version/fingerprint mismatch");
    rejected.client.close();
    expect(await fs.readFile(sourcePath)).toEqual(original);
    const result = await migrateDatabaseViaStaging({ sourcePath, stagingPath, rollbackPath,
      backupDirectory: path.join(directory, "backup"), quiesce: async () => ({ release: async () => {} }) });
    expect(result.copiedRowsByTable.pending_user_questions).toBe(1);
    expect(result.copiedRowsByTable.sessions).toBe(1);
    expect(await fs.readFile(rollbackPath)).toEqual(original);
    const target = await createDatabase({ url: `file:${sourcePath}` });
    try {
      expect(await inspectSchemaParity(target.client, "main")).toEqual([]);
      const row = (await target.client.execute("SELECT * FROM pending_user_questions")).rows[0]!;
      expect({ ...row }).toEqual({ turn_id: "old-turn", attempt_id: "old-attempt", step: 2,
        questions_json: questions, timeout_ms: 60000, expires_at: "2099-01-01T00:01:00.000Z",
        created_at: "2099-01-01T00:00:00.000Z", invocation_id: null });
      expect((await target.client.execute("SELECT title FROM sessions")).rows[0]!.title).toBe("Keep this session");
      expect((await target.client.execute("SELECT version FROM _aervox_schema_versions WHERE scope='main'")).rows[0]!.version).toBe("2");
    } finally { target.client.close(); }
    const rollback = createClient({ url: `file:${rollbackPath}` });
    try {
      expect((await rollback.execute("SELECT version FROM _aervox_schema_versions WHERE scope='main'")).rows[0]!.version).toBe("1");
      expect((await rollback.execute("PRAGMA table_info(pending_user_questions)")).rows.map(row => row.name)).not.toContain("invocation_id");
      expect((await rollback.execute("SELECT questions_json FROM pending_user_questions")).rows[0]!.questions_json).toBe(questions);
    } finally { rollback.close(); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it("binds the generated native artifact to v2 while retaining the immutable v1 release", () => {
  const artifact = buildPortableSchemaArtifact("main");
  expect(artifact.schemaVersion).toBe(2);
  expect(artifact.fingerprint).toBe(SCHEMA_RELEASES[2]!.main);
  expect(artifact.initialization.statements.find(sql => sql.startsWith('CREATE TABLE "pending_user_questions"'))).toContain('"invocation_id" text');
  expect(SCHEMA_RELEASES[1]!.main).toBe("c749a41cf2155d0b070c08746bd353e77479d6766b113d8e4f78bcaeda5961b4");
  expect(SCHEMA_RELEASES[2]!.ledger).toBe(SCHEMA_RELEASES[1]!.ledger);
});
