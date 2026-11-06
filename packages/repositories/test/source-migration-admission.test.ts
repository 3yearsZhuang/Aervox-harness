import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../src/client.js";
import { prepareSqliteToPostgresqlMigration } from "../src/migration/sqlite-to-postgresql.js";

let directory: string, source: string, alias: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-source-admission-"));
  source = path.join(directory, "source.db"); alias = path.join(directory, "alias.db");
  const db = new DatabaseSync(source);
  try { db.exec("CREATE TABLE probe(value text)"); } finally { db.close(); }
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

it("rejects reopening a fenced source through a symbolic link", async () => {
  await fs.symlink(source, alias);
  const before = await fs.readFile(source);
  await fs.writeFile(`${source}.aervox-migration.lock`, "claimed", { mode: 0o600 });
  await expect(createDatabase({ url: `file:${alias}` })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_SOURCE_FENCED" });
  expect(await fs.readFile(source)).toEqual(before);
});

it("does not recreate a removed fenced source through a dangling symbolic link", async () => {
  await fs.symlink(source, alias);
  await fs.writeFile(`${source}.aervox-migration.lock`, "claimed", { mode: 0o600 });
  await fs.unlink(source);
  await expect(createDatabase({ url: `file:${alias}` })).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.lstat(source).catch(() => null)).toBeNull();
  expect(await fs.readFile(`${source}.aervox-migration.lock`, "utf8")).toBe("claimed");
});

it("keeps an existing symbolic-link client bound to its actual source after the link is retargeted", async () => {
  await fs.symlink(source, alias);
  const opened = await createDatabase({ url: `file:${alias}` });
  try {
    await opened.client.execute("INSERT INTO probe VALUES ('retained')");
    const other = path.join(directory, "other.db"), db = new DatabaseSync(other);
    try { db.exec("CREATE TABLE probe(value text)"); } finally { db.close(); }
    await fs.unlink(alias); await fs.symlink(other, alias);
    await fs.writeFile(`${source}.aervox-migration.lock`, "claimed", { mode: 0o600 });
    await expect(opened.client.execute("INSERT INTO probe VALUES ('blocked')")).rejects.toMatchObject({ code: "DATABASE_MIGRATION_SOURCE_FENCED" });
    await expect(opened.reconnect()).rejects.toMatchObject({ code: "DATABASE_MIGRATION_SOURCE_FENCED" });
  } finally { opened.client.close(); }
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try { expect(sourceDb.prepare("SELECT value FROM probe").all()).toEqual([{ value: "retained" }]); }
  finally { sourceDb.close(); }
});

it("rejects either hard-link name and rejects an existing client if another link appears", async () => {
  const opened = await createDatabase({ url: `file:${source}` });
  try {
    await fs.link(source, alias);
    for (const filename of [source, alias]) {
      await expect(createDatabase({ url: `file:${filename}` })).rejects.toMatchObject({ code: "DATABASE_SOURCE_HARD_LINKS_UNSUPPORTED" });
    }
    await expect(opened.client.execute("INSERT INTO probe VALUES ('blocked')")).rejects.toMatchObject({ code: "DATABASE_SOURCE_HARD_LINKS_UNSUPPORTED" });
  } finally { opened.client.close(); }
});

it("rejects a hard-linked migration source before creating a claim, backup or PostgreSQL target", async () => {
  await fs.link(source, alias);
  const before = await fs.readFile(source), backupDirectory = path.join(directory, "backup");
  await expect(prepareSqliteToPostgresqlMigration({ sourcePath: source, connectionString: "postgresql://invalid@localhost/missing",
    targetSchema: "source_admission_test", instanceId: "fixture", backupDirectory })).rejects.toThrow("multiple hard links");
  expect(await fs.readFile(source)).toEqual(before);
  expect(await fs.lstat(`${source}.aervox-migration.lock`).catch(() => null)).toBeNull();
  expect(await fs.lstat(backupDirectory).catch(() => null)).toBeNull();
});
