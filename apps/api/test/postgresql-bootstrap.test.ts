import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const connectionString = process.env.AERVOX_PG_TEST_URL;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
const captureLimit = 64 * 1024;

interface ProcessExit { code: number | null; signal: NodeJS.Signals | null; error?: string; }
interface ManagedProcess {
  child: ChildProcess;
  closed: Promise<ProcessExit>;
  done: boolean;
  stdout: string;
  stderr: string;
}

async function bounded<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function startProcess(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  children: ManagedProcess[], redact: (value: string) => string): ManagedProcess {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const managed: ManagedProcess = { child, closed: undefined!, done: false, stdout: "", stderr: "" };
  managed.closed = new Promise(resolve => {
    child.once("error", error => {
      managed.done = true;
      resolve({ code: null, signal: null, error: redact(error.message) });
    });
    child.once("close", (code, signal) => {
      managed.done = true;
      resolve({ code, signal });
    });
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    managed.stdout = `${managed.stdout}${chunk.toString("utf8")}`.slice(-captureLimit);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    managed.stderr = `${managed.stderr}${chunk.toString("utf8")}`.slice(-captureLimit);
  });
  children.push(managed);
  return managed;
}

async function stopProcess(process: ManagedProcess, graceful: boolean, diagnostics: () => string): Promise<void> {
  if (process.done) {
    if (graceful) expect(await process.closed, diagnostics()).toMatchObject({ code: 0, signal: null });
    return;
  }
  process.child.kill("SIGTERM");
  let forced = false;
  let result: ProcessExit;
  try { result = await bounded(process.closed, 25_000, "Child did not stop after SIGTERM"); }
  catch {
    forced = true;
    process.child.kill("SIGKILL");
    result = await bounded(process.closed, 5_000, "Child did not stop after SIGKILL");
  }
  if (graceful) {
    expect(forced, diagnostics()).toBe(false);
    expect(result, diagnostics()).toMatchObject({ code: 0, signal: null });
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP test port is unavailable");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

// Installation-relative defaults in host-runtime include plugins, skills and
// attachments. Copy the unchanged built entrypoints instead of redirecting only
// cwd, which would still let those defaults write into the real checkout.
async function copyInstallation(root: string): Promise<{ api: string; worker: string }> {
  const packages = ["apps/api", "apps/worker", "packages/host-runtime"];
  for (const packagePath of packages) {
    const source = path.join(repositoryRoot, packagePath);
    const target = path.join(root, packagePath);
    await fs.mkdir(target, { recursive: true });
    await fs.copyFile(path.join(source, "package.json"), path.join(target, "package.json"));
    await fs.cp(path.join(source, "dist"), path.join(target, "dist"), { recursive: true });
  }
  const modules = path.join(root, "node_modules");
  await fs.mkdir(modules);
  const linked = new Set<string>();
  for (const source of [repositoryRoot, ...packages.map(value => path.join(repositoryRoot, value))]) {
    for (const entry of await fs.readdir(path.join(source, "node_modules"), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@")) {
        await fs.mkdir(path.join(modules, entry.name), { recursive: true });
        for (const name of await fs.readdir(path.join(source, "node_modules", entry.name))) {
          const key = `${entry.name}/${name}`;
          if (key === "@aervox/host-runtime" || linked.has(key)) continue;
          await fs.symlink(await fs.realpath(path.join(source, "node_modules", key)), path.join(modules, key), "dir");
          linked.add(key);
        }
      } else if (!linked.has(entry.name)) {
        await fs.symlink(await fs.realpath(path.join(source, "node_modules", entry.name)), path.join(modules, entry.name), "dir");
        linked.add(entry.name);
      }
    }
  }
  await fs.symlink(path.join(root, "packages/host-runtime"), path.join(modules, "@aervox/host-runtime"), "dir");
  return { api: path.join(root, "apps/api/dist/index.js"), worker: path.join(root, "apps/worker/dist/index.js") };
}

describe.skipIf(!connectionString)("PostgreSQL external database selection at real process bootstrap", () => {
  it("migrates through the CLI, survives API restart, shares Worker writes, and refuses invalid credentials without SQLite fallback", async () => {
    // Keep the Unix IPC socket path short even on macOS's long default tmpdir.
    const root = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "aervox-pgb-"));
    const schema = `aervox_bootstrap_${randomUUID().replaceAll("-", "")}`;
    const sourcePath = path.join(root, "source.db");
    const vaultPath = path.join(root, "vault.db");
    const ledgerPath = path.join(root, "ledger.db");
    const selectionPath = path.join(root, "database-selection.json");
    const lockPath = `${sourcePath}.aervox-migration.lock`;
    const token = randomUUID();
    const sessionId = `bootstrap-${randomUUID()}`;
    const eventId = `bootstrap-event-${randomUUID()}`;
    const workerId = `bootstrap-worker-${randomUUID()}`;
    const children: ManagedProcess[] = [];
    const redact = (value: string): string => value.replaceAll(connectionString!, "[postgresql connection]")
      .replaceAll(token, "[auth token]").replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[postgresql connection]");
    const diagnostics = (child: ManagedProcess): string => redact(`${child.stdout}\n${child.stderr}`);
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Exclude inherited product configuration and credentials; retain PATH and
    // the mise-selected runtime used to execute this test.
    for (const key of Object.keys(env)) {
      if (/^(?:AERVOX_|WORKER_|DATABASE_|PG(?:HOST|PORT|USER|PASSWORD|DATABASE|OPTIONS|SERVICE|SSLMODE)$)/.test(key)
        || /^(?:OPENAI|ANTHROPIC|DEEPSEEK|GEMINI|DASHSCOPE|SILICONFLOW)_/.test(key)
        || key === "NODE_OPTIONS" || key === "PORT") delete env[key];
    }
    Object.assign(env, {
      NODE_ENV: "test", DATABASE_URL: `file:${sourcePath}`,
      AERVOX_DATABASE_SELECTION_PATH: selectionPath,
      AERVOX_POSTGRESQL_URL: connectionString!,
      AERVOX_API_HOST: "127.0.0.1", AERVOX_AUTH_MODE: "token",
      AERVOX_AUTH_TOKEN: token, AERVOX_AUTH_ACTOR: "postgresql-bootstrap-test",
      AERVOX_LOOP_PROVIDER: "replay", AERVOX_LOOP_DRIVER: "native",
      AERVOX_TURN_EXECUTION: "background", AERVOX_LOOP_RESUME: "off",
      AERVOX_LOG_LEVEL: "error", AERVOX_LOG_FORMAT: "json",
      AERVOX_PROACTIVE_VAULT_URL: `file:${vaultPath}`,
      AERVOX_PROACTIVE_VAULT_KEY_PATH: path.join(root, "vault.key"),
      AERVOX_PROACTIVE_ACCESS_TOKEN_PATH: path.join(root, "vault.token"),
      AERVOX_CR030_STATE_PATH: path.join(root, "cr030.json"),
      AERVOX_WORKER_IPC_SOCKET: path.join(root, "worker.sock"),
      WORKER_ID: workerId, WORKER_TICK_MS: "200",
    });
    const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000,
      query_timeout: 15_000, options: "-c statement_timeout=15000" });
    try {
      const entries = await copyInstallation(root);
      // libsql can retain prepared-statement file handles after client.close().
      // An exited fixture process gives the real offline CLI a quiescent source
      // without replacing or bypassing its lsof admission check.
      const fixturePath = path.join(root, "prepare-fixture.mjs");
      const repositoriesEntry = pathToFileURL(path.join(repositoryRoot, "packages/repositories/dist/index.js")).href;
      await fs.writeFile(fixturePath, `
import { createDatabase, initDatabaseSchema, initLedgerSchema } from ${JSON.stringify(repositoriesEntry)};
import fs from "node:fs/promises";
const [sourcePath, vaultPath, ledgerPath] = process.argv.slice(2);
for (const [filename, initialize] of [[sourcePath, initDatabaseSchema], [vaultPath, initDatabaseSchema], [ledgerPath, initLedgerSchema]]) {
  const opened = await createDatabase({ url: "file:" + filename });
  try {
    await initialize(opened.client);
    if (filename === sourcePath) {
      const now = new Date().toISOString();
      await opened.client.execute({ sql: "INSERT INTO plugins (id,publisher,version,checksum,install_source,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        args: ["ap-tool-postgresql", "3yearsZ", "1.0.0", "0".repeat(64), "registry", 1, now, now] });
    }
    await opened.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { opened.client.close(); }
  await fs.chmod(filename, 0o600);
}
`, { mode: 0o600 });
      const fixture = startProcess(fixturePath, [sourcePath, vaultPath, ledgerPath], root, env, children, redact);
      expect(await bounded(fixture.closed, 30_000, "Database fixture preparation timed out"), diagnostics(fixture))
        .toMatchObject({ code: 0, signal: null });
      const sourceBytes = await fs.readFile(sourcePath);
      const vaultBytes = await fs.readFile(vaultPath);
      const ledgerBytes = await fs.readFile(ledgerPath);
      const cli = path.join(repositoryRoot, "scripts/database.mjs");
      async function command(args: string[]): Promise<Record<string, unknown>> {
        const child = startProcess(cli, args, root, env, children, redact);
        const result = await bounded(child.closed, 60_000, `Database CLI timed out: ${args[0]}`);
        expect(result, diagnostics(child)).toMatchObject({ code: 0, signal: null });
        return JSON.parse(child.stdout) as Record<string, unknown>;
      }
      const migration = await command(["migrate", "--source", sourcePath, "--schema", schema,
        "--backup", path.join(root, "backup"), "--instance", `bootstrap-${randomUUID()}`,
        "--vault", vaultPath, "--ledger", ledgerPath]);
      expect(migration).toMatchObject({ phase: "verified", schema, sourcePreserved: true, activated: false });
      expect(typeof migration.receiptPath).toBe("string");
      const activated = await command(["activate", "--receipt", migration.receiptPath as string]);
      expect(activated).toMatchObject({ backend: "postgresql", schema, repairRequired: false });
      expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
      expect(await fs.readFile(vaultPath)).toEqual(vaultBytes);
      expect(await fs.readFile(ledgerPath)).toEqual(ledgerBytes);
      const lockBytes = await fs.readFile(lockPath);
      const selectionBytes = await fs.readFile(selectionPath);
      const keyBytes = await fs.readFile(`${selectionPath}.key`);
      expect(selectionBytes.toString("utf8")).not.toContain(connectionString!);
      expect((await command(["status"])).backend).toBe("postgresql");

      async function waitForHttp(child: ManagedProcess, url: string, status: number): Promise<void> {
        const deadline = Date.now() + 35_000;
        while (Date.now() < deadline) {
          if (child.done) throw new Error(`Child exited before readiness: ${diagnostics(child)}`);
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
            await response.arrayBuffer();
            if (response.status === status) return;
          } catch { /* The real listener may still be starting. */ }
          await delay(100);
        }
        throw new Error(`Child readiness timed out: ${diagnostics(child)}`);
      }
      async function startApi(): Promise<{ child: ManagedProcess; base: string }> {
        const port = await freePort();
        const child = startProcess(entries.api, [], root, { ...env, PORT: String(port) }, children, redact);
        const base = `http://127.0.0.1:${port}`;
        await waitForHttp(child, `${base}/v1/sessions`, 401);
        return { child, base };
      }
      const headers = { authorization: `Bearer ${token}` };
      async function request(base: string, route: string, options: RequestInit = {}): Promise<Response> {
        const requestHeaders = new Headers(options.headers);
        requestHeaders.set("authorization", headers.authorization);
        return fetch(`${base}${route}`, { ...options, headers: requestHeaders,
          signal: AbortSignal.timeout(5_000) });
      }
      async function assertSession(base: string): Promise<void> {
        const list = await request(base, "/v1/sessions");
        expect(list.status).toBe(200);
        expect((await list.json() as { items: { id: string }[] }).items.some(item => item.id === sessionId)).toBe(true);
        const detail = await request(base, `/v1/sessions/${sessionId}`);
        expect(detail.status).toBe(200);
        expect(await detail.json()).toMatchObject({ id: sessionId, title: "External PostgreSQL selection" });
      }
      const firstApi = await startApi();
      const created = await request(firstApi.base, "/v1/sessions", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: sessionId, title: "External PostgreSQL selection" }) });
      expect(created.status, redact(await created.clone().text())).toBe(201);
      await created.arrayBuffer();
      await assertSession(firstApi.base);
      await stopProcess(firstApi.child, true, () => diagnostics(firstApi.child));
      const secondApi = await startApi();
      await assertSession(secondApi.base);
      expect((await admin.query(`SELECT id FROM ${quote(schema)}.sessions WHERE id=$1`, [sessionId])).rows).toEqual([{ id: sessionId }]);

      await admin.query(`INSERT INTO ${quote(schema)}.outbox_events (id,idempotency_key,event_type,payload,status,retry_count,created_at) VALUES ($1,$2,$3,$4,'pending',0,$5)`,
        [eventId, eventId, "bootstrap.probe", JSON.stringify({ source: "real-entrypoint-test" }), new Date().toISOString()]);
      const healthPort = await freePort();
      const worker = startProcess(entries.worker, [], root, { ...env, AERVOX_WORKER_HEALTH_PORT: String(healthPort) }, children, redact);
      await waitForHttp(worker, `http://127.0.0.1:${healthPort}/health`, 200);
      const writeDeadline = Date.now() + 15_000;
      let workerWrote = false;
      while (Date.now() < writeDeadline) {
        if (worker.done) throw new Error(`Worker exited before its durable write: ${diagnostics(worker)}`);
        const result = await admin.query(`SELECT e.status, a.actor_id, a.action FROM ${quote(schema)}.outbox_events e JOIN ${quote(schema)}.audit_records a ON a.subject_id=e.id WHERE e.id=$1 AND a.actor_id=$2 AND a.action=$3`,
          [eventId, `outbox:${workerId}`, "outbox.consume.bootstrap.probe"]);
        if (result.rows.some(row => row.status === "published")) { workerWrote = true; break; }
        await delay(100);
      }
      expect(workerWrote, diagnostics(worker)).toBe(true);
      await assertSession(secondApi.base);
      await stopProcess(worker, true, () => diagnostics(worker));
      await stopProcess(secondApi.child, true, () => diagnostics(secondApi.child));

      // A broken credential file must reject both real bootstrap paths before
      // opening the old, sealed SQLite URL that remains in DATABASE_URL.
      await fs.chmod(`${selectionPath}.key`, 0o644);
      for (const [entry, specificEnv] of [
        [entries.api, { PORT: String(await freePort()) }],
        [entries.worker, { AERVOX_WORKER_HEALTH_PORT: String(await freePort()) }],
      ] as const) {
        const child = startProcess(entry, [], root, { ...env, ...specificEnv }, children, redact);
        const result = await bounded(child.closed, 20_000, "Invalid selection did not reject child startup");
        expect(result.code, diagnostics(child)).not.toBe(0);
        expect(result.signal, diagnostics(child)).toBeNull();
        expect(diagnostics(child)).toContain("DATABASE_SELECTION_CREDENTIALS_UNAVAILABLE");
      }
      expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
      expect(await fs.readFile(lockPath)).toEqual(lockBytes);
      expect(await fs.readFile(selectionPath)).toEqual(selectionBytes);
      expect(await fs.readFile(`${selectionPath}.key`)).toEqual(keyBytes);
      const sourceRead = new DatabaseSync(sourcePath, { readOnly: true });
      try {
        expect(sourceRead.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n).toBe(0);
        expect(sourceRead.prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE id=?").get(eventId)!.n).toBe(0);
      } finally { sourceRead.close(); }
      expect((await admin.query(`SELECT id FROM ${quote(schema)}.sessions WHERE id=$1`, [sessionId])).rows).toEqual([{ id: sessionId }]);
      expect((await admin.query(`SELECT status FROM ${quote(schema)}.outbox_events WHERE id=$1`, [eventId])).rows).toEqual([{ status: "published" }]);
    } finally {
      const stopped = await Promise.allSettled(children.map(child => stopProcess(child, false, () => diagnostics(child))));
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      } finally {
        try { await admin.end(); }
        finally { await fs.rm(root, { recursive: true, force: true }); }
      }
      const failedStop = stopped.find(result => result.status === "rejected");
      if (failedStop?.status === "rejected") throw failedStop.reason;
    }
  }, 240_000);
});
