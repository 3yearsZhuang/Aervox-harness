#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function parseMigrationArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--stopped") { if (values.stopped) throw new Error("duplicate --stopped"); values.stopped = true; continue; }
    if (!["--source", "--staging", "--rollback", "--backup", "--scope"].includes(flag)) throw new Error(`unknown migration option: ${flag}`);
    const key = flag.slice(2);
    if (values[key] !== undefined) throw new Error(`duplicate migration option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing migration value: ${flag}`);
    values[key] = value;
  }
  if (!values.stopped) throw new Error("--stopped is required after all writers and connections have been stopped and checkpointed");
  for (const key of ["source", "staging", "rollback", "backup"]) {
    if (!values[key] || !path.isAbsolute(values[key])) throw new Error(`--${key} requires an explicit absolute path`);
  }
  if (values.scope !== undefined && !["main", "ledger"].includes(values.scope)) throw new Error("--scope must be main or ledger");
  const paths = [values.source, values.staging, values.rollback].map(value => path.resolve(value));
  if (new Set(paths).size !== paths.length) throw new Error("source, staging and rollback must differ");
  return { sourcePath: paths[0], stagingPath: paths[1], rollbackPath: paths[2], backupDirectory: path.resolve(values.backup), scope: values.scope ?? "main" };
}

export async function runSchemaMigration(args) {
  const input = parseMigrationArguments(args);
  const { migrateDatabaseViaStaging } = await import("../packages/repositories/dist/index.js");
  const lockPath = `${input.sourcePath}.maintenance.lock`;
  const lock = await fs.open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, sourcePath: input.sourcePath }));
    // This lock coordinates maintenance invocations. The operator owns proof that every runtime is stopped.
    return await migrateDatabaseViaStaging({ ...input, quiesce: async () => ({ release: async () => undefined }) });
  } finally { await lock.close(); await fs.unlink(lockPath); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes("--help")) {
    console.log("Usage: mise exec -- node scripts/schema-staging.mjs --source /absolute/database.db --staging /absolute/database.staging.db --rollback /absolute/database.rollback.db --backup /absolute/new-backup-directory --scope main --stopped");
  } else {
    try { console.log(JSON.stringify(await runSchemaMigration(process.argv.slice(2)), null, 2)); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}
