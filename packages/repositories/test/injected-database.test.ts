import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createContext, runInContext } from "node:vm";
import { eq, sql } from "drizzle-orm";
import { sessions } from "@aervox/schema";
import { createInjectedDatabase } from "../src/database.js";
import { initializeCanonicalSchema } from "../src/schema/manifest.js";
import { SqliteConversationRepository } from "../src/repositories/sqlite/conversation-repository.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];
const clients: Client[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.restoreAllMocks(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "aervox-injected-database-")); directories.push(directory);
  const client = createClient({ url: `file:${join(directory, "business.db")}` }); clients.push(client);
  return { client, db: createInjectedDatabase(client) };
}

describe("connection-free database assembly", () => {
  it("keeps relation assembly, current repository commands and atomic acceptance on the injected file writer", async () => {
    const { client, db } = fixture();
    await client.execute("PRAGMA foreign_keys=ON"); await initializeCanonicalSchema(client, "main");
    const repository = new SqliteConversationRepository(db);
    const ctx = { workspaceId: "local", subjectUserId: "local" };
    await repository.createSession(ctx, "native candidate", { id: "injected" });
    const input = { turnId: "turn", sessionId: "injected", idempotencyKey: "same-intent", attemptId: "attempt",
      message: { id: "input", content: "retained" }, consumeInbox: false };
    const accepted = await repository.acceptTurn(ctx, input);
    expect(accepted.created).toBe(true);
    expect((await repository.acceptTurn(ctx, input)).created).toBe(false);
    expect((await db.query.sessions.findFirst({ where: eq(sessions.id, "injected") }))?.title).toBe("native candidate");
    expect((await client.execute("SELECT count(*) AS n FROM turn_attempts")).rows[0]?.n).toBe(1);
    expect((await client.execute("SELECT count(*) AS n FROM outbox_events")).rows[0]?.n).toBe(1);
  });

  it("routes transaction SQL through the one transaction handle and rolls back a rejected CAS as a unit", async () => {
    const { client, db } = fixture(); const calls: string[] = [];
    await db.run(sql`CREATE TABLE cas_record(id TEXT PRIMARY KEY, revision INTEGER, body TEXT)`);
    await db.run(sql`INSERT INTO cas_record VALUES ('row', 1, 'before')`);
    const start = client.transaction.bind(client);
    vi.spyOn(client, "transaction").mockImplementation(async (...args) => {
      calls.push("begin"); const tx = await start(...args);
      const execute = tx.execute.bind(tx), commit = tx.commit.bind(tx), rollback = tx.rollback.bind(tx);
      vi.spyOn(tx, "execute").mockImplementation(async statement => { calls.push("tx.execute"); return execute(statement); });
      vi.spyOn(tx, "commit").mockImplementation(async () => { calls.push("commit"); return commit(); });
      vi.spyOn(tx, "rollback").mockImplementation(async () => { calls.push("rollback"); return rollback(); });
      return tx;
    });
    let callbacks = 0;
    await expect(db.transaction(async tx => {
      callbacks++;
      await tx.run(sql`UPDATE cas_record SET revision=2, body='pending' WHERE id='row' AND revision=1`);
      const changed = await tx.all(sql`UPDATE cas_record SET revision=3 WHERE id='row' AND revision=1 RETURNING id`);
      if (changed.length !== 1) throw new Error("cas_rejected");
    })).rejects.toThrow("cas_rejected");
    expect(callbacks).toBe(1); expect(calls).toEqual(["begin", "tx.execute", "tx.execute", "rollback"]);
    expect(await db.get(sql`SELECT revision, body FROM cas_record WHERE id='row'`)).toMatchObject({ revision: 1, body: "before" });
  });

  it.each([false, true])("never replays a callback when commit fails after native commit=%s", async committed => {
    const { client, db } = fixture(); await db.run(sql`CREATE TABLE result(id TEXT PRIMARY KEY)`);
    const start = client.transaction.bind(client); let callbacks = 0; const calls: string[] = [];
    vi.spyOn(client, "transaction").mockImplementation(async (...args) => {
      const tx = await start(...args), commit = tx.commit.bind(tx), rollback = tx.rollback.bind(tx);
      vi.spyOn(tx, "commit").mockImplementation(async () => {
        calls.push("commit"); if (committed) await commit(); throw new Error("commit_result_unknown");
      });
      vi.spyOn(tx, "rollback").mockImplementation(async () => { calls.push("rollback"); await rollback(); });
      return tx;
    });
    await expect(db.transaction(async tx => { callbacks++; await tx.run(sql`INSERT INTO result VALUES ('intent')`); })).rejects.toThrow(committed ? "TRANSACTION_CLOSED" : "commit_result_unknown");
    // The pinned Drizzle session attempts rollback after commit acknowledgement
    // loss; the real native client can replace the original error with closed.
    // Neither error proves rollback: preserve unknown outcome and query receipts.
    expect(callbacks).toBe(1); expect(calls).toEqual(["commit", "rollback"]);
    expect((await db.all(sql`SELECT id FROM result`)).length).toBe(committed ? 1 : 0);
  });

  it("defaults to no query logger and retains explicit host logger injection", async () => {
    const { client, db } = fixture(); const log = vi.spyOn(console, "log");
    await db.get(sql`SELECT 1 AS value`); expect(log).not.toHaveBeenCalled();
    const logger = { logQuery: vi.fn() };
    await createInjectedDatabase(client, { logger }).get(sql`SELECT 2 AS value`);
    expect(logger.logQuery).toHaveBeenCalledExactlyOnceWith("SELECT 2 AS value", []);
  });

  it("bundles the entire database entry without Node globals or local/remote client creators", async () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, { default: string }> };
    const entry = resolve(root, manifest.exports["./database"]!.default);
    const built = await build({ entryPoints: [entry], bundle: true, platform: "browser", format: "iife",
      globalName: "InjectedDatabase", write: false, metafile: true, treeShaking: false, logLevel: "silent" });
    expect(Object.keys(built.metafile!.inputs).filter(file => /\/node_modules\/(?:@libsql|libsql|@aervox\/process-coordination)\//.test(file))).toEqual([]);
    expect(Object.values(built.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
    const context = createContext({ TextEncoder, TextDecoder, AbortController, AbortSignal, setTimeout, clearTimeout, crypto: globalThis.crypto });
    runInContext(built.outputFiles![0]!.text, context);
    expect(runInContext("typeof process + ':' + typeof require + ':' + typeof Buffer", context)).toBe("undefined:undefined:undefined");
    const observed = await runInContext(`(async () => {
      const calls = [];
      const result = () => ({ columns: ['value'], columnTypes: ['INTEGER'], rows: [{ value: 1 }], rowsAffected: 0, lastInsertRowid: 0n });
      const client = {
        execute: async () => { calls.push('root'); return result(); },
        transaction: async () => ({
          execute: async () => { calls.push('tx'); return result(); },
          commit: async () => { calls.push('commit'); }, rollback: async () => { calls.push('rollback'); },
        }),
      };
      const db = InjectedDatabase.createInjectedDatabase(client);
      const outside = await db.get('SELECT 1 AS value');
      const inside = await db.transaction(tx => tx.get('SELECT 1 AS value'));
      return { outside, inside, calls };
    })()`, context);
    expect(observed).toEqual({ outside: { value: 1 }, inside: { value: 1 }, calls: ['root', 'tx', 'commit'] });
  });

  it("typechecks the actual entry declarations with current project library checking, without client.ts or ambient Node", () => {
    const directory = mkdtempSync(join(tmpdir(), "aervox-database-types-")); directories.push(directory);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, {types: string}> };
    const declaration = resolve(root, manifest.exports["./database"]!.types);
    const config = join(directory, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ compilerOptions: {
      target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      noEmit: true, types: [], skipLibCheck: true, lib: ["ES2023", "DOM", "DOM.Iterable"],
    }, files: [declaration] }));
    const tsc = fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url));
    execFileSync(process.execPath, [tsc, "-p", config], { stdio: "pipe" });
    const files = execFileSync(process.execPath, [tsc, "-p", config, "--listFilesOnly"], { encoding: "utf8" });
    expect(files).not.toMatch(/repositories\/(?:src|dist)\/client\.(?:d\.)?ts|@types\/node\//);
    // This deliberately retains the repository's skipLibCheck setting. Strict
    // checking of upstream Drizzle declarations is a separate unresolved gate.
  });
});
