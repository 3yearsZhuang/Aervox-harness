/** Explicit stop-writes → verified backup → new staging → validate → atomic swap. Never invoked by bootstrap. */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createDatabase } from "../client.js";
import { initDatabaseSchema, initLedgerSchema } from "../schema/ddl/index.js";
import { inspectSchemaParity, schemaFingerprint, type SchemaScope } from "../schema/manifest.js";
import { exportSnapshot, restoreSnapshotToEmptyStaging, type DatabaseSnapshot } from "../sync/git-snapshot.js";
import { createVerifiedBackup, assertVerifiedBackup } from "./backup-manifest.js";
import { atomicSwapCr030Database } from "./staging-migration.js";
import { rebuildMessageFts } from "../search/fts.js";

export interface QuiescedDatabaseLease {
  /** Called after every writer, reader and SQLite connection to source has stopped. */
  release(): Promise<void>;
}
const sqliteSidecars = (databasePath: string): string[] => ["-wal", "-shm", "-journal"].map(suffix => `${databasePath}${suffix}`);
async function assertUnusedPaths(paths: readonly string[]): Promise<void> {
  for (const candidate of paths) {
    try { await fs.lstat(candidate); throw new Error(`migration output already exists: ${candidate}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export async function migrateDatabaseViaStaging(input: {
  sourcePath: string; stagingPath: string; rollbackPath: string; backupDirectory: string;
  scope?: SchemaScope; snapshot?: DatabaseSnapshot;
  quiesce(): Promise<QuiescedDatabaseLease>;
}): Promise<{ backupManifestPath: string; rollbackPath: string; copiedRowsByTable: Record<string, number> }> {
  const paths = [input.sourcePath, input.stagingPath, input.rollbackPath].map((value) => path.resolve(value));
  if (new Set(paths).size !== paths.length) throw new Error("source, staging and rollback paths must differ");
  if (path.dirname(paths[0]!) !== path.dirname(paths[1]!)) throw new Error("staging must be a sibling of source");
  const inspectionPath = `${input.stagingPath}.source-inspection`;
  if (new Set([...paths, path.resolve(input.backupDirectory), path.resolve(inspectionPath)]).size !== 5) throw new Error("source, staging, inspection, rollback and backup paths must differ");
  await assertUnusedPaths([input.backupDirectory, ...[input.stagingPath, input.rollbackPath, inspectionPath].flatMap(databasePath => [databasePath, ...sqliteSidecars(databasePath)])]);
  const sourceStat = await fs.lstat(input.sourcePath);
  if (!sourceStat.isFile()) throw new Error("source must be a regular database file");
  const lease = await input.quiesce();
  let source: Awaited<ReturnType<typeof createDatabase>> | undefined;
  let staging: Awaited<ReturnType<typeof createDatabase>> | undefined;
  const scope = input.scope ?? "main";
  try {
    // Quiescence includes checkpoint + closed connections. Refuse an uncheckpointed file set.
    for (const suffix of ["-wal", "-journal"]) {
      try { if ((await fs.stat(`${input.sourcePath}${suffix}`)).size > 0) throw new Error(`source has uncheckpointed ${suffix}; stop and checkpoint all connections first`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    // Source is never opened by SQLite: failed import must preserve its exact bytes.
    // mkdir without recursive/exist-ok is the ownership claim. Never reuse a prior
    // directory whose manifest or other recovery artifacts could be overwritten.
    await fs.mkdir(input.backupDirectory, { mode: 0o700 });
    const { manifestPath, manifest } = await createVerifiedBackup({ destinationDir: input.backupDirectory, schemaVersion: "source-before-staging",
      artifacts: [{ role: scope === "ledger" ? "recovery-ledger" : "database", sourcePath: input.sourcePath, relativePath: "source.db" }] });
    await assertVerifiedBackup(manifestPath);
    await fs.copyFile(path.join(input.backupDirectory, "source.db"), inspectionPath, fs.constants.COPYFILE_EXCL);
    await fs.chmod(inspectionPath, 0o600);
    await assertUnusedPaths(sqliteSidecars(inspectionPath));
    source = await createDatabase({ url: `file:${path.resolve(inspectionPath)}` });
    if (!input.snapshot) {
      // Logical export excludes virtual tables. Only owned search indexes may be
      // discarded and rebuilt; an unknown virtual table may contain primary data.
      const undeclared = (await inspectSchemaParity(source.client, scope, { allowUnversioned: true }))
        .filter((issue) => issue.endsWith(": undeclared table"));
      if (undeclared.length) throw new Error(`source contains undeclared data; choose an explicit reviewed snapshot: ${undeclared.join("; ")}`);
    }
    const snapshot = input.snapshot ?? await exportSnapshot(source.client, 1);
    const copiedRowsByTable = Object.fromEntries(Object.entries(snapshot.tables).map(([table, rows]) => [table, rows.length]));
    source.client.close(); source = undefined;
    // Exclusive creation prevents using an unrelated database as a staging target.
    const handle = await fs.open(input.stagingPath, "wx", 0o600); await handle.close();
    await assertUnusedPaths(sqliteSidecars(input.stagingPath));
    staging = await createDatabase({ url: `file:${path.resolve(input.stagingPath)}` });
    await (scope === "main" ? initDatabaseSchema : initLedgerSchema)(staging.client);
    await restoreSnapshotToEmptyStaging(staging.client, snapshot);
    const issues = await inspectSchemaParity(staging.client, scope);
    if (issues.length) throw new Error(`staging schema mismatch: ${issues.join("; ")}`);
    const integrity = await staging.client.execute("PRAGMA integrity_check");
    if (String(integrity.rows[0]?.integrity_check) !== "ok") throw new Error("staging integrity check failed");
    // Search indexes are derived and rebuilt locally, never imported as FTS shadow tables.
    if (scope === "main") {
      await rebuildMessageFts(staging.client);
      await staging.client.execute("INSERT INTO memories_fts(id, content) SELECT id, content FROM memory_records WHERE is_deleted = 0");
    }
    await staging.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    staging.client.close(); staging = undefined;
    // Recheck source backup immediately before replacement; validation failures never change the source.
    await assertVerifiedBackup(manifestPath);
    const currentSource = await fs.lstat(input.sourcePath);
    const sourceDigest = createHash("sha256").update(await fs.readFile(input.sourcePath)).digest("hex");
    if (currentSource.ino !== sourceStat.ino || currentSource.dev !== sourceStat.dev || sourceDigest !== manifest.artifacts[0]?.sha256) throw new Error("source changed after quiescence; refusing replacement");
    for (const suffix of ["-wal", "-journal"]) {
      try { if ((await fs.stat(`${input.sourcePath}${suffix}`)).size > 0) throw new Error("source writer became active; refusing replacement"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await atomicSwapCr030Database({ sourcePath: input.sourcePath, stagingPath: input.stagingPath, rollbackPath: input.rollbackPath });
    return { backupManifestPath: manifestPath, rollbackPath: input.rollbackPath, copiedRowsByTable };
  } catch (error) {
    throw new Error(`staging migration failed; inspect retained staging/backup artifacts; target ${schemaFingerprint(scope)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { source?.client.close(); staging?.client.close(); await lease.release(); }
}
