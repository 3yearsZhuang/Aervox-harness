import { afterEach, describe, expect, it } from "vitest";
import { createClient, type Client, type InStatement, type ResultSet } from "@libsql/client";
import { build } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createInjectedDatabase } from "../src/database.js";
import { ConversationRepository } from "../src/conversation.js";
import { initializeCanonicalSchema } from "../src/schema/manifest.js";
import { NativeSqliteClient, type NativeSqliteRequest, type NativeSqliteTransport } from "../src/driver/native-sqlite-client.js";
import { decodeNativeSqliteValue, encodeNativeSqliteValue, type NativeSqliteResult } from "../src/driver/native-sqlite-values.js";

const epoch = "connection_1";
const empty = (): NativeSqliteResult => ({ columns: [], columnTypes: [], rows: [], rowsAffected: 0, lastInsertRowid: null });
const ok = (request: NativeSqliteRequest) => request.operation === "execute"
  ? { kind: "result", connectionEpoch: epoch, transactionId: request.transactionId, result: empty() }
  : request.operation === "begin" ? { kind: "begun", connectionEpoch: epoch, transactionId: "transaction_1" }
    : { kind: "terminal", connectionEpoch: epoch, transactionId: request.transactionId, outcome: request.operation === "commit" ? "committed" : "rolledBack" };
const rejected = (request: NativeSqliteRequest, code = "SQLITE_BUSY") => ({ kind: "rejected", connectionEpoch: epoch,
  transactionId: request.operation === "begin" ? null : request.transactionId, state: request.operation === "begin" || request.transactionId === null ? "none" : "active", code });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function fixture(handler: (request: NativeSqliteRequest) => unknown | Promise<unknown> = ok, dispose = async (_epoch: string) => ({ kind: "disposed", connectionEpoch: epoch })) {
  const calls: NativeSqliteRequest[] = [], disposals: string[] = [];
  const port: NativeSqliteTransport = { async request(request) { calls.push(request); return handler(request); },
    async dispose(value) { disposals.push(value); return dispose(value); } };
  return { client: new NativeSqliteClient(port, { connectionEpoch: epoch }), port, calls, disposals };
}
const paths: string[] = [], clients: Client[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function wire(result: ResultSet): NativeSqliteResult {
  return { columns: result.columns, columnTypes: result.columnTypes, rowsAffected: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid?.toString() ?? null,
    rows: result.rows.map(row => Array.from(row, value => typeof value === "number" && !Number.isFinite(value)
      ? { type: "float" as const, value: value > 0 ? "Infinity" as const : "-Infinity" as const } : encodeNativeSqliteValue(value))) };
}
async function fileFixture() {
  const directory = mkdtempSync(join(tmpdir(), "aervox-native-client-")); paths.push(directory);
  const backend = createClient({ url: `file:${join(directory, "test.db")}`, intMode: "bigint" }); clients.push(backend);
  await backend.execute("PRAGMA foreign_keys=ON");
  let tx: Awaited<ReturnType<Client["transaction"]>> | undefined, counter = 0;
  const calls: NativeSqliteRequest[] = [];
  const transport: NativeSqliteTransport = {
    async request(request) {
      calls.push(request); expect(request.connectionEpoch).toBe(epoch);
      if (request.operation === "begin") { expect(tx).toBeUndefined(); tx = await backend.transaction("write"); counter++;
        return { kind: "begun", connectionEpoch: epoch, transactionId: `tx_${counter}` }; }
      expect(request.transactionId).toBe(tx ? `tx_${counter}` : null);
      if (request.operation === "execute") {
        const input = request.statement, args = input.args;
        const decoded = Array.isArray(args) ? args.map(value => decodeNativeSqliteValue(value, "bigint"))
          : Object.fromEntries(Object.entries(args).map(([key, value]) => [key, decodeNativeSqliteValue(value, "bigint")]));
        try { const result = await (tx ?? backend).execute({ sql: input.sql, args: decoded } as InStatement);
          return { kind: "result", connectionEpoch: epoch, transactionId: request.transactionId, result: JSON.parse(JSON.stringify(wire(result))) }; }
        catch { return rejected(request, "SQLITE_ERROR"); }
      }
      await tx![request.operation](); tx = undefined;
      return { kind: "terminal", connectionEpoch: epoch, transactionId: request.transactionId, outcome: request.operation === "commit" ? "committed" : "rolledBack" };
    },
    async dispose() { if (tx && !tx.closed) await tx.rollback(); tx = undefined; return { kind: "disposed", connectionEpoch: epoch }; },
  };
  return { backend, transport, calls, client: new NativeSqliteClient(transport, { connectionEpoch: epoch }) };
}

describe("M0 native SQLite writer adapter", () => {
  it("holds the writer across a transaction while allowing its own statements", async () => {
    const { client, calls } = fixture();
    const tx = await client.transaction(), outside = client.execute("outside");
    await tx.execute("inside"); expect(calls.map(call => call.operation)).toEqual(["begin", "execute"]);
    expect(calls[0]).toMatchObject({ mode: "write" }); expect(calls[1]).toMatchObject({ transactionId: "transaction_1" });
    await tx.commit(); await outside;
    expect(calls.map(call => call.operation)).toEqual(["begin", "execute", "commit", "execute"]);
    expect(calls[3]).toMatchObject({ transactionId: null }); expect(tx.closed).toBe(true);
  });

  it("serializes independent roots and bounds queued admission", async () => {
    const held = deferred<unknown>(); const { port, calls } = fixture(request => calls.length === 1 ? held.promise : ok(request));
    const client = new NativeSqliteClient(port, { connectionEpoch: epoch, maxQueue: 1 });
    const first = client.execute("one"), second = client.execute("two");
    await expect(client.execute("three")).rejects.toMatchObject({ code: "QUEUE_FULL" });
    await tick(); expect(calls).toHaveLength(1); held.resolve(ok(calls[0]!));
    await Promise.all([first, second]); expect(calls).toHaveLength(2);
  });

  it("releases a definitively failed BEGIN without returning a handle", async () => {
    const { client, calls } = fixture(request => request.operation === "begin" ? rejected(request) : ok(request));
    await expect(client.transaction()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    await client.execute("next"); expect(calls.map(call => call.operation)).toEqual(["begin", "execute"]);
    expect(client.closed).toBe(false);
  });

  it("poisons admission after unacknowledged BEGIN until explicit cleanup confirmation", async () => {
    const { client, calls, disposals } = fixture(() => { throw new Error("PRIVATE_CANARY"); });
    const failed = await client.transaction().catch(reason => reason);
    expect(failed.message).toBe("OUTCOME_UNKNOWN"); expect(failed.cause).toBeUndefined();
    expect(String(failed)).not.toContain("PRIVATE_CANARY");
    await expect(client.execute("next")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(calls).toHaveLength(1); expect(disposals).toEqual([]); expect(client.cleanupState).toBe("unknown");
    await client.dispose(); expect(client.drained).toBe(true); expect(client.closed).toBe(true);
  });

  it.each(["commit", "rollback"] as const)("keeps ownership unknown after lost %s acknowledgement and never replays", async operation => {
    const { client, calls } = fixture(request => { if (request.operation === operation) throw new Error("lost acknowledgement"); return ok(request); });
    const tx = await client.transaction(); const waiting = client.execute("outside");
    const blocked = expect(waiting).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await tx.execute("inside"); await expect(tx[operation]()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await blocked; await expect(tx.rollback()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(calls.map(call => call.operation)).toEqual(["begin", "execute", operation]);
    expect(tx.closed).toBe(true); expect(client.drained).toBe(false); await client.dispose();
  });

  it("does not dispatch an already queued commit after an earlier statement becomes unknown", async () => {
    const held = deferred<unknown>();
    const { client, calls } = fixture(request => request.operation === "execute" ? held.promise : ok(request));
    const tx = await client.transaction();
    const executing = expect(tx.execute("unknown")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    const committing = expect(tx.commit()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await tick(); held.reject(new Error("lost statement acknowledgement"));
    await Promise.all([executing, committing]);
    expect(calls.map(call => call.operation)).toEqual(["begin", "execute"]);
    expect(client.drained).toBe(false); await client.dispose();
  });

  it.each(["commit", "rollback"] as const)("keeps close intent when pending %s is definitively rejected", async operation => {
    const held = deferred<unknown>();
    const { client, calls } = fixture(request => request.operation === operation ? held.promise : ok(request));
    const tx = await client.transaction();
    const outside = expect(client.execute("outside")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    const ending = expect(tx[operation]()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await tick();
    tx.close();
    expect(tx.closed).toBe(true);
    held.resolve(rejected(calls.at(-1)!));
    await Promise.all([ending, outside]);
    expect(tx.closed).toBe(true); expect(client.closed).toBe(true); expect(client.drained).toBe(false);
    expect(calls.map(call => call.operation)).toEqual(["begin", operation]);
    await client.dispose(); expect(client.drained).toBe(true);
  });

  it.each(["epoch", "owner", "result"])("rejects malformed %s reply and dispatches no queued root", async invalid => {
    const { client, calls } = fixture(request => request.operation !== "execute" ? ok(request)
      : { ...ok(request), ...(invalid === "epoch" ? { connectionEpoch: "old" } : invalid === "owner" ? { transactionId: "alien" } : { result: {} }) });
    await expect(client.execute("write")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(client.execute("next")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" }); expect(calls).toHaveLength(1);
  });

  it("distinguishes close admission from drain and preserves explicit cleanup retry", async () => {
    const cleanup = deferred<{ kind: string; connectionEpoch: string }>();
    const { client, disposals } = fixture(ok, () => cleanup.promise);
    const tx = await client.transaction(), waiting = client.execute("outside");
    const blocked = expect(waiting).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    client.close(); expect(client.closed).toBe(true); expect(client.drained).toBe(false); expect(tx.closed).toBe(true);
    await blocked; const drained = client.dispose(); expect(disposals).toEqual([epoch]);
    cleanup.resolve({ kind: "disposed", connectionEpoch: epoch }); await drained; expect(client.drained).toBe(true);
    let attempts = 0; const retry = fixture(ok, async () => { if (++attempts === 1) throw new Error("lost"); return { kind: "disposed", connectionEpoch: epoch }; }).client;
    await expect(retry.dispose()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" }); expect(retry.drained).toBe(false);
    await retry.dispose(); expect(retry.drained).toBe(true); expect(attempts).toBe(2);
  });

  it("can retry explicit disposal even when the transport throws synchronously", async () => {
    let attempts = 0;
    const port: NativeSqliteTransport = { request: async request => ok(request), dispose: () => {
      if (++attempts === 1) throw new Error("PRIVATE_SYNC_CANARY");
      return Promise.resolve({ kind: "disposed", connectionEpoch: epoch });
    } };
    const client = new NativeSqliteClient(port, { connectionEpoch: epoch });
    await expect(client.dispose()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(client.drained).toBe(false); await client.dispose();
    expect(attempts).toBe(2); expect(client.drained).toBe(true);
  });

  it("queues terminal cleanup even when the statement queue is full", async () => {
    const held = deferred<unknown>(); const { port, calls } = fixture(request => request.operation === "execute" && calls.length === 2 ? held.promise : ok(request));
    const client = new NativeSqliteClient(port, { connectionEpoch: epoch, maxQueue: 1 });
    const tx = await client.transaction(), executing = tx.execute("one"); await tick();
    await expect(tx.execute("two")).rejects.toMatchObject({ code: "QUEUE_FULL" }); tx.close();
    expect(tx.closed).toBe(true); held.resolve(ok(calls[1]!)); await executing; await tick();
    expect(calls.map(call => call.operation)).toEqual(["begin", "execute", "rollback"]); await client.execute("after");
  });

  it("keeps definitive statement or commit rejection in the same owner for rollback", async () => {
    const { client, calls } = fixture(request => request.operation === "execute" || request.operation === "commit" ? rejected(request, "SQLITE_ERROR") : ok(request));
    const tx = await client.transaction();
    await expect(tx.execute("bad")).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    await expect(tx.commit()).rejects.toMatchObject({ code: "SQLITE_ERROR" }); expect(tx.closed).toBe(false);
    await tx.rollback(); expect(calls.map(call => call.operation)).toEqual(["begin", "execute", "commit", "rollback"]);
  });

  it("rejects unsupported capabilities and invalid input before native dispatch", async () => {
    const { client, calls } = fixture();
    await expect(client.transaction("read")).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(client.transaction("deferred")).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(client.batch([], "deferred")).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(client.migrate([])).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(client.executeMultiple("BEGIN;")).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(client.sync()).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(client.batch([{ sql: "?", args: [Infinity] }])).rejects.toThrow(); expect(calls).toEqual([]);
  });

  it("quarantines an orphaned batch owner if its cleanup is definitively rejected", async () => {
    const { client, calls } = fixture(request => request.operation === "execute" || request.operation === "rollback" ? rejected(request, "SQLITE_ERROR") : ok(request));
    await expect(client.batch(["failed"])).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(client.execute("outside")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(calls.map(call => call.operation)).toEqual(["begin", "execute", "rollback"]);
    expect(client.drained).toBe(false); await client.dispose(); expect(client.drained).toBe(true);
  });

  it("requires an exact dispose acknowledgement before proving cleanup", async () => {
    const { client } = fixture(ok, async () => ({ kind: "disposed", connectionEpoch: "old_epoch" }));
    await expect(client.dispose()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(client.closed).toBe(true); expect(client.drained).toBe(false); expect(client.cleanupState).toBe("unknown");
  });

  it("uses typed bindings and safe named properties without coercion", async () => {
    const { client, calls } = fixture(); const args = Object.create(null); args.__proto__ = 1n; args.value = Uint8Array.of(0, 255);
    await client.execute({ sql: "bound", args }); await client.execute({ sql: "values", args: [-0, true, new Date(123)] });
    expect(calls[0]).toMatchObject({ statement: { args: { ["__proto__"]: { type: "int64", value: "1" }, value: { type: "blob", value: "00ff" } } } });
    expect(calls[1]).toMatchObject({ statement: { args: [{ type: "float", value: "-0" }, { type: "float", value: 1 }, { type: "float", value: 123 }] } });
  });

  it("runs injected Drizzle CAS against real file SQLite with one native owner", async () => {
    const { client, backend, calls } = await fileFixture(), db = createInjectedDatabase(client);
    await db.run(sql`CREATE TABLE record(id TEXT PRIMARY KEY, revision INTEGER, body TEXT)`);
    await db.run(sql`INSERT INTO record VALUES ('row', 1, 'before')`); let callbacks = 0;
    await expect(db.transaction(async tx => { callbacks++; await tx.run(sql`UPDATE record SET revision=2, body='pending' WHERE id='row'`);
      const changed = await tx.all(sql`UPDATE record SET body='lost' WHERE id='row' AND revision=1 RETURNING id`);
      if (changed.length !== 1) throw new Error("CAS_REJECTED"); })).rejects.toThrow("CAS_REJECTED");
    expect(callbacks).toBe(1); expect((await backend.execute("SELECT revision, body FROM record")).rows[0]).toMatchObject({ revision: 1n, body: "before" });
    expect(calls.filter(call => call.operation === "rollback")).toHaveLength(1);
    await client.batch(["INSERT INTO record VALUES ('second', 1, 'committed')", "UPDATE record SET revision=3 WHERE id='second'"]);
    expect((await db.get(sql`SELECT revision FROM record WHERE id='second'`))).toMatchObject({ revision: 3 }); await client.dispose();
  });

  it("rolls back every statement in a failed atomic batch on real SQLite", async () => {
    const { client, backend, calls } = await fileFixture();
    await client.execute("CREATE TABLE batch_record(id TEXT PRIMARY KEY)");
    await expect(client.batch(["INSERT INTO batch_record VALUES ('first')", "INSERT INTO batch_record VALUES ('first')"])).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    expect((await backend.execute("SELECT count(*) AS n FROM batch_record")).rows[0]?.n).toBe(0n);
    expect(calls.filter(call => call.operation === "rollback")).toHaveLength(1);
    expect(client.closed).toBe(false); await client.dispose();
  });

  it("reuses shared acceptance and idempotency through real SQLite JSON transport", async () => {
    const { client, backend } = await fileFixture(); await initializeCanonicalSchema(backend, "main");
    const repository = new ConversationRepository(createInjectedDatabase(client), { sha256Utf8: value => createHash("sha256").update(value).digest("hex"), randomUUID, wakeOutbox: () => true });
    const context = { workspaceId: "local", subjectUserId: "local" }; await repository.createSession(context, "native candidate", { id: "session" });
    const input = { turnId: "turn", sessionId: "session", idempotencyKey: "intent", attemptId: "attempt", message: { id: "input", content: "body\0尾" }, consumeInbox: false };
    expect((await repository.acceptTurn(context, input)).created).toBe(true); expect((await repository.acceptTurn(context, input)).created).toBe(false);
    for (const table of ["turns", "turn_attempts", "messages", "outbox_events"]) expect((await backend.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n).toBe(1n);
    const history = await repository.getSessionHistoryPage(context, { sessionId: "session" });
    expect(history.items[0]?.messages[0]?.content).toBe("body\0尾"); await client.dispose();
  });

  it("never replays a real commit after ack loss, preserving committed receipt", async () => {
    const { client, backend, transport } = await fileFixture(); await client.execute("CREATE TABLE receipt(id TEXT PRIMARY KEY)");
    const request = transport.request.bind(transport); transport.request = async value => { const result = await request(value); if (value.operation === "commit") throw new Error("lost"); return result; };
    let callbacks = 0;
    await expect(createInjectedDatabase(client).transaction(async tx => { callbacks++; await tx.run(sql`INSERT INTO receipt VALUES ('intent')`); })).rejects.toThrow("OUTCOME_UNKNOWN");
    expect(callbacks).toBe(1); expect((await backend.execute("SELECT id FROM receipt")).rows[0]?.id).toBe("intent");
    expect(client.drained).toBe(false); await client.dispose(); expect(client.drained).toBe(true);
  });

  it("bundles the public dist without libsql runtime, Node globals or connection creators", async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, { default: string; types: string }> };
    const exported = manifest.exports["./native-sqlite-client"]!;
    const built = await build({ entryPoints: [resolve(root, exported.default)], bundle: true,
      platform: "browser", format: "iife", globalName: "NativeClient", treeShaking: false, write: false, metafile: true, logLevel: "silent" });
    expect(Object.values(built.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
    expect(Object.keys(built.metafile!.inputs)).toHaveLength(2);
    const context = createContext({}); runInContext(built.outputFiles![0]!.text, context);
    expect(runInContext("typeof process + ':' + typeof require + ':' + typeof Buffer", context)).toBe("undefined:undefined:undefined");
    const observed = await runInContext(`(async () => {
      const requests=[];
      const client=new NativeClient.NativeSqliteClient({
        request:async request=>{requests.push(request);return {kind:'result',connectionEpoch:'vm',transactionId:null,
          result:{columns:['value'],columnTypes:['REAL'],rows:[[{type:'float',value:'-0'}]],rowsAffected:0,lastInsertRowid:null}}},
        dispose:async connectionEpoch=>({kind:'disposed',connectionEpoch})
      },{connectionEpoch:'vm'});
      const result=await client.execute({sql:'SELECT ?',args:[-0]});
      await client.dispose();
      return {negativeZero:Object.is(result.rows[0].value,-0),requests,closed:client.closed,drained:client.drained};
    })()`, context);
    expect(observed).toMatchObject({ negativeZero: true, closed: true, drained: true,
      requests: [{ connectionEpoch: 'vm', statement: { args: [{ type: 'float', value: '-0' }] } }] });
    const directory = mkdtempSync(join(tmpdir(), "aervox-native-client-types-")); paths.push(directory);
    const config=join(directory,"tsconfig.json");
    writeFileSync(config,JSON.stringify({compilerOptions:{target:"ES2023",module:"NodeNext",moduleResolution:"NodeNext",
      strict:true,skipLibCheck:false,noEmit:true,types:[],lib:["ES2023","DOM"]},files:[resolve(root,exported.types)]}));
    const tsc=fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc",import.meta.url));
    execFileSync(process.execPath,[tsc,"-p",config],{stdio:"pipe"});
    expect(execFileSync(process.execPath,[tsc,"-p",config,"--listFilesOnly"],{encoding:"utf8"})).not.toMatch(/@types\/node\//);
  });
});
