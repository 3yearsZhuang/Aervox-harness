import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createInjectedDatabase } from "../src/database.js";
import { initializeCanonicalSchema } from "../src/schema/manifest.js";
import { ConversationRepository, TurnIntentConflictError, normalizeTurnIntent, turnIntentHashWithHost, FencingMismatchError, type ConversationHostPort } from "../src/conversation.js";
import { SqliteConversationRepository } from "../src/repositories/sqlite/conversation-repository.js";
import { TurnIntentConflictError as NodeIntentConflict, turnIntentHash } from "../src/conversation-turn-intent.js";
import { FencingMismatchError as NodeFencingError } from "../src/errors.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [], clients: Client[] = [];
const ctx = { workspaceId: "local", subjectUserId: "local" };
const host = (patch: Partial<ConversationHostPort> = {}): ConversationHostPort => ({
  sha256Utf8: value => createHash("sha256").update(value).digest("hex"), randomUUID,
  wakeOutbox: vi.fn(() => true), ...patch,
});
const acceptedInput = { turnId: "turn", sessionId: "session", idempotencyKey: "intent", attemptId: "attempt",
  message: { id: "input", content: "persisted input" }, consumeInbox: false };
afterEach(() => { clients.splice(0).forEach(client => client.close()); directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.restoreAllMocks(); });
async function fixture(runtime = host()) {
  const directory = mkdtempSync(join(tmpdir(), "aervox-neutral-conversation-")); directories.push(directory);
  const file = `file:${join(directory, "business.db")}`;
  const client = createClient({ url: file }); clients.push(client);
  await client.execute("PRAGMA foreign_keys=ON"); await initializeCanonicalSchema(client, "main");
  const db = createInjectedDatabase(client), repository = new ConversationRepository(db, runtime);
  await repository.createSession(ctx, "isolated conversation", { id: "session" });
  return { db, client, repository, file };
}

describe("shared conversation authority with explicit host primitives", () => {
  it("requires an explicit crypto and wakeup host, preserves default Node constructor and exact error identities", async () => {
    const { db } = await fixture();
    expect(() => new ConversationRepository(db, undefined as never)).toThrow("conversation_crypto_port_required");
    expect(() => new ConversationRepository(db, { randomUUID, sha256Utf8: host().sha256Utf8 } as never)).toThrow("conversation_wakeup_port_required");
    const node = new SqliteConversationRepository(db);
    expect(node).toBeInstanceOf(ConversationRepository);
    expect(node.acceptTurn).toBe(ConversationRepository.prototype.acceptTurn);
    expect(TurnIntentConflictError).toBe(NodeIntentConflict);
    expect(FencingMismatchError).toBe(NodeFencingError);
  });

  it("preserves the pre-refactor SHA-256 canonical receipt including Chinese, NUL and unpaired UTF-16", () => {
    const intent = normalizeTurnIntent({ sessionId: "会话\0尾", message: { content: "text\ud800尾", attachments: [{ attachmentId: "a", name: "文档" }] },
      metadata: { z: [2, 1], a: { x: null, b: true } } }, "local-v1", "actor");
    const expected = "turn-intent-v1:6219325274423c83db44b43679701d6ba292b042da19f98a6c062efaa30d14fd";
    expect(turnIntentHashWithHost(intent, host())).toBe(expected);
    expect(turnIntentHash(intent)).toBe(expected);
  });

  it.each(["throw", "reject"])("keeps committed acceptance visible when the post-commit wakeup can %s", async kind => {
    let committed: Promise<unknown> | undefined; let reader: Client | undefined;
    const wakeOutbox = vi.fn(() => {
      committed = reader!.execute("SELECT count(*) AS n FROM outbox_events");
      if (kind === "throw") throw new Error("wakeup unavailable");
      return Promise.reject(new Error("wakeup unavailable"));
    });
    const { repository, file, client } = await fixture(host({ wakeOutbox }));
    reader = createClient({ url: file }); clients.push(reader);
    const result = await repository.acceptTurn(ctx, acceptedInput);
    expect(result.created).toBe(true);
    expect((await committed as Awaited<ReturnType<Client["execute"]>>).rows[0]?.n).toBe(1);
    expect((await client.execute("SELECT count(*) AS n FROM turn_attempts")).rows[0]?.n).toBe(1);
    expect((await repository.acceptTurn(ctx, acceptedInput)).created).toBe(false);
    expect(wakeOutbox).toHaveBeenCalledTimes(1);
  });

  it.each(["not-a-digest", "A".repeat(64), "0".repeat(63), 7, Promise.resolve("0".repeat(64))])(
    "rejects an invalid synchronous hash result before any accepted rows or wakeup", async value => {
      const runtime = host({ sha256Utf8: (() => value) as unknown as ConversationHostPort["sha256Utf8"] });
      const { repository, client } = await fixture(runtime);
      await expect(repository.acceptTurn(ctx, acceptedInput)).rejects.toThrow("conversation_sha256_result_invalid");
      for (const table of ["turns", "turn_attempts", "messages", "message_versions", "outbox_events"]) {
        expect((await client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n).toBe(0);
      }
      expect(runtime.wakeOutbox).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "bad-uuid", Promise.resolve("08f5c6ef-8e08-4bb9-94cf-93d3b2f3979e")])("rejects an invalid UUID result without creating a branch", async value => {
    const runtime = host({ randomUUID: (() => value) as unknown as ConversationHostPort["randomUUID"] });
    const { repository, client } = await fixture(runtime);
    await expect(repository.createExplorationBranch(ctx, { parentSessionId: "session" })).rejects.toThrow("conversation_uuid_result_invalid");
    expect((await client.execute("SELECT count(*) AS n FROM conversation_branches")).rows[0]?.n).toBe(0);
    expect((await client.execute("SELECT count(*) AS n FROM sessions")).rows[0]?.n).toBe(1);
  });

  it("rejects an accidentally asynchronous hash without an unhandled rejection or partial acceptance", async () => {
    const sha256Utf8 = (async () => { throw new Error("private-hash-error"); }) as unknown as ConversationHostPort["sha256Utf8"];
    const { repository, client } = await fixture(host({ sha256Utf8 }));
    await expect(repository.acceptTurn(ctx, acceptedInput)).rejects.toThrow("conversation_sha256_result_invalid");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await client.execute("SELECT count(*) AS n FROM turns")).rows[0]?.n).toBe(0);
  });

  it("keeps deterministic branch identities compatible with the Node wrapper", async () => {
    const { repository, db } = await fixture();
    const created = await repository.createExplorationBranch(ctx, { parentSessionId: "session", idempotencyKey: "same-branch" });
    const replay = await new SqliteConversationRepository(db).createExplorationBranch(ctx, { parentSessionId: "session", idempotencyKey: "same-branch" });
    expect(replay).toEqual(created);
    expect(created!.id).toBe(`br_${createHash("sha256").update(JSON.stringify(["exploration-branch-v1", "session", "same-branch"])).digest("hex")}`);
  });

  it("bundles the entire public entry without Node, Buffer, process coordination or libsql runtime and executes through injected host ports", async () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, {default: string}> };
    expect(manifest.exports["./conversation"]?.default).toBe("./dist/conversation.js");
    const built = await build({ entryPoints: [join(root, manifest.exports["./conversation"]!.default)], bundle: true, platform: "browser", format: "iife",
      globalName: "NeutralConversation", write: false, metafile: true, treeShaking: false, logLevel: "silent" });
    expect(Object.keys(built.metafile!.inputs).filter(file => /\/node_modules\/(?:@libsql|libsql)\/|process-coordination|conversation-(?:crypto|host)-node|conversation-turn-intent\.ts/.test(file))).toEqual([]);
    expect(Object.values(built.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
    const { db, client } = await fixture();
    const context = createContext({ TextEncoder, TextDecoder, AbortController, AbortSignal, setTimeout, clearTimeout,
      crypto: globalThis.crypto, injectedDb: db, trustedHost: host() });
    runInContext(built.outputFiles![0]!.text, context);
    expect(runInContext("typeof process + ':' + typeof require + ':' + typeof Buffer", context)).toBe("undefined:undefined:undefined");
    const result = await runInContext(`(async () => {
      const ctx = { workspaceId: 'local', subjectUserId: 'local' };
      const repository = new NeutralConversation.ConversationRepository(injectedDb, trustedHost);
      const accepted = await repository.acceptTurn(ctx, { turnId: 'vm-turn', sessionId: 'session', idempotencyKey: 'vm-intent', attemptId: 'vm-attempt',
        message: { id: 'vm-input', content: 'vm input\\0尾' }, consumeInbox: false });
      const page = await repository.getSessionHistoryPage(ctx, { sessionId: 'session' });
      return { created: accepted.created, content: page.items[0].messages[0].content };
    })()`, context);
    expect(result).toEqual({ created: true, content: "vm input\0尾" });
    expect((await client.execute("SELECT count(*) AS n FROM outbox_events")).rows[0]?.n).toBe(1);
  });

  it("compiles an actual DOM consumer under current library checking without ambient Node", () => {
    const directory = mkdtempSync(join(tmpdir(), "aervox-conversation-types-")); directories.push(directory);
    const consumer = join(directory, "consumer.mts"), config = join(directory, "tsconfig.json");
    writeFileSync(consumer, `import { ConversationRepository, type ConversationHostPort } from ${JSON.stringify(join(root, "dist/conversation.js"))};
import { createInjectedDatabase, type InjectedDatabaseClient } from ${JSON.stringify(join(root, "dist/database.js"))};
declare const client: InjectedDatabaseClient;
declare const host: ConversationHostPort;
const repository = new ConversationRepository(createInjectedDatabase(client), host);
const accepted: Promise<unknown> = repository.acceptTurn({ workspaceId: 'local', subjectUserId: 'local' }, {
  turnId: 'turn', sessionId: 'session', idempotencyKey: 'intent', attemptId: 'attempt',
  message: { id: 'input', content: 'input' }, consumeInbox: false,
});
void accepted;`);
    writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, noEmit: true, types: [], skipLibCheck: true, lib: ["ES2023", "DOM", "DOM.Iterable"] }, files: [consumer] }));
    const tsc = fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url));
    execFileSync(process.execPath, [tsc, "-p", config], { stdio: "pipe" });
    const files = execFileSync(process.execPath, [tsc, "-p", config, "--listFilesOnly"], { encoding: "utf8" });
    expect(files).not.toMatch(/@types\/node\//);
    // Upstream Drizzle declarations still require the existing skipLibCheck
    // setting. This validates the consumer, not a strict upstream type closure.
  });
});
