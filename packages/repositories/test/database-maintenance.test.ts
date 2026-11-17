import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { abortSqliteToPostgresqlMigration, activatePostgresqlMigration, preparePostgresqlDatabaseMigration, recoverDatabaseActivation } from "../src/database-selection.js";

describe("database maintenance process exclusion and recovery", () => {
  let root: string, filename: string, holder: ChildProcess | undefined;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-db-maintenance-")); filename = path.join(root, "selection.json"); });
  afterEach(async () => {
    if (holder && holder.exitCode === null && holder.signalCode === null) { const exited = once(holder, "exit"); holder.kill("SIGKILL"); await exited; }
    holder = undefined; await fs.rm(root, { recursive: true, force: true });
  });
  async function holdNativeMutex(): Promise<ChildProcess> {
    const mutexPath = `${filename}.maintenance.db`;
    await fs.writeFile(mutexPath, "", { mode: 0o600 });
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      process.stdout.write('locked\\n');
      setInterval(() => {}, 60_000);
    `, mutexPath], { stdio: ["ignore", "pipe", "pipe"] });
    holder = child;
    await new Promise<void>((resolve, reject) => {
      let errors = "";
      child.stderr?.on("data", chunk => { errors += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`mutex holder exited ${code ?? signal}: ${errors}`)));
      child.stdout?.on("data", chunk => { if (String(chunk).includes("locked\n")) resolve(); });
    });
    return child;
  }
  it("excludes every maintenance operation before modifying persistent claims", async () => {
    await holdNativeMutex();
    const sourcePath = path.join(root, "source.db");
    const operations = [
      abortSqliteToPostgresqlMigration({ sourcePath, selectionPath: filename }),
      activatePostgresqlMigration({ receiptPath: path.join(root, "receipt.json"), connectionString: "postgresql://unused@localhost/app", selectionPath: filename }),
      preparePostgresqlDatabaseMigration({ sourcePath, targetSchema: "unused_schema", instanceId: "owner", backupDirectory: path.join(root, "backup"), connectionString: "postgresql://unused@localhost/app", selectionPath: filename }),
      recoverDatabaseActivation(filename),
    ];
    const results = await Promise.allSettled(operations);
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "DATABASE_MAINTENANCE_BUSY" });
    }
    const files = await fs.readdir(root);
    expect(files).toContain("selection.json.maintenance.db");
    expect(files.filter(name => !/^selection\.json\.maintenance\.db(?:-journal|-wal|-shm)?$/.test(name))).toEqual([]);
  });
  it("releases the OS mutex on process death while retaining the interrupted activation evidence", async () => {
    const child = await holdNativeMutex();
    const claimPath = `${filename}.activation.lock`;
    const claim = { processId: child.pid, operation: "activate", receiptPath: path.join(root, "receipt.json") };
    await fs.writeFile(claimPath, JSON.stringify(claim), { mode: 0o600 });
    await expect(recoverDatabaseActivation(filename)).rejects.toMatchObject({ code: "DATABASE_MAINTENANCE_BUSY" });
    expect(JSON.parse(await fs.readFile(claimPath, "utf8"))).toEqual(claim);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    expect(await recoverDatabaseActivation(filename)).toMatchObject({ backend: "sqlite", generation: null, repairRequired: false });
    expect(await fs.lstat(claimPath).catch(() => null)).toBeNull();
    expect(await fs.readdir(root)).toEqual(["selection.json.maintenance.db"]);
  });
});
