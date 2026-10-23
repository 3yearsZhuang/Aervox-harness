import { connect, type Socket } from "node:net";
import { get, type ClientRequest } from "node:http";
import type { ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, type LocalContext } from "@aervox/repositories";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app-fixture.js";
import { turnStreamHub } from "@aervox/host-runtime-test/modules/companion/conversation/stream-hub";

const ctx: LocalContext = { workspaceId: "local", subjectUserId: "local" };
const tick = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const parse = (body: string) => body.split("\n\n").map(block => block.split("\n").find(line => line.startsWith("data: ")))
  .filter((line): line is string => Boolean(line)).map(line => JSON.parse(line.slice(6)));

describe("bounded durable SSE over HTTP and paused TCP", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let app: FastifyInstance; let repo: SqliteConversationRepository;
  const clients: (Socket | ClientRequest)[] = [];
  let page: ReturnType<typeof vi.spyOn>;
  let highWaterSpy: ReturnType<typeof vi.spyOn>;
  let disclosure: ReturnType<typeof vi.spyOn>;
  const highWater = SqliteConversationRepository.prototype.getStreamEventHighWater;
  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "replay";
    page = vi.spyOn(SqliteConversationRepository.prototype, "getStreamEventsPage");
    highWaterSpy = vi.spyOn(SqliteConversationRepository.prototype, "getStreamEventHighWater");
    disclosure = vi.spyOn(SqliteConversationRepository.prototype, "getStreamEventForDisclosure");
    database = await createInMemoryDatabase(); repo = new SqliteConversationRepository(database.db);
    app = (await buildApp({ db: database.db, client: database.client })).app;
    await repo.getOrCreateSession(ctx, "session");
    await repo.createTurnWithOutbox(ctx, { id: "turn", sessionId: "session", idempotencyKey: "turn" },
      { id: "message", content: "synthetic stream test" });
    await repo.createTurnAttempt(ctx, "turn", { id: "attempt", attempt: 1 });
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await app.close(); await database.cleanup(); vi.restoreAllMocks();
    delete process.env.AERVOX_LOOP_PROVIDER;
  });
  const append = (sequence: number, text: string, eventType = "delta") => repo.appendStreamEvent(ctx,
    { id: `event_${sequence}`, turnId: "turn", sequence, eventType, data: { text } });
  const read = (url: string, cursor?: string) => new Promise<string>((resolve, reject) => {
    const request = get(url, { headers: cursor ? { "Last-Event-ID": cursor } : undefined }, response => {
      let body = ""; response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve(body)); response.on("error", reject);
    });
    clients.push(request); request.on("error", reject);
  });

  it("natural socket backpressure pauses SQLite pages and detachment preserves replayable events", async () => {
    // Fixed synthetic input: 32 x 192 KiB data (6 MiB), temporary SQLite only.
    for (let i = 1; i <= 32; i += 1) await append(i, "x".repeat(192 * 1024));
    let raw!: ServerResponse; let falseWrites = 0; let peakQueuedBytes = 0;
    app.addHook("onRequest", async (req, reply) => {
      if (!req.url.endsWith("/events")) return;
      raw = reply.raw; const original = raw.write.bind(raw);
      raw.write = ((frame: string) => {
        const accepted = original(frame);
        if (!accepted) falseWrites += 1;
        peakQueuedBytes = Math.max(peakQueuedBytes, raw.writableLength);
        return accepted; // Observe the actual Node return; never force false.
      }) as typeof raw.write;
    });
    const base = await app.listen({ host: "127.0.0.1", port: 0 }); const url = new URL(base);
    const paused = connect({ host: "127.0.0.1", port: Number(url.port) }); clients.push(paused);
    paused.on("error", () => undefined); paused.pause();
    await new Promise<void>(resolve => paused.once("connect", resolve));
    paused.write("GET /v1/turns/turn/events HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    await vi.waitFor(() => {
      expect(falseWrites).toBeGreaterThan(0); expect(raw.writableNeedDrain).toBe(true);
    });
    await tick(250); const blockedPages = page.mock.calls.length;
    await tick(200);
    expect(raw.writableNeedDrain).toBe(true);
    expect(page).toHaveBeenCalledTimes(blockedPages);
    expect(blockedPages).toBeGreaterThan(0); expect(blockedPages).toBeLessThan(32);
    // One frame can exceed HWM, while the owner never appends a second blocked frame.
    expect(peakQueuedBytes).toBeLessThan(256 * 1024);
    paused.destroy(); await vi.waitFor(() => expect(raw.destroyed).toBe(true));
    expect((await repo.listTurnAttempts(ctx, "turn"))[0]!.status).toBe("Running");
    expect((await repo.getStreamEvents(ctx, "turn")).some(e => e.eventType === "done")).toBe(false);
    await append(33, "persisted terminal", "done");
    await repo.finalizeTurnAttempt(ctx, { turnId: "turn", attemptId: "attempt", status: "Completed" });
    const body = await read(`${base}/v1/turns/turn/events`, "event_1");
    expect(parse(body).map(e => e.sequence)).toEqual(Array.from({ length: 32 }, (_, i) => i + 2));
    expect(parse(body).at(-1)!.eventType).toBe("done");
  });

  it("replays 600 persisted rows in capped pages and includes a commit in the snapshot window", async () => {
    for (let i = 1; i <= 600; i += 1) await append(i, `event ${i}`);
    await repo.finalizeTurnAttempt(ctx, { turnId: "turn", attemptId: "attempt", status: "Completed" });
    highWaterSpy.mockImplementationOnce(async function (tenant, turnId) {
      const snapshot = await highWater.call(this, tenant, turnId);
      const terminal = await append(601, "snapshot-window terminal", "done");
      turnStreamHub.publishEvent("turn", terminal); return snapshot;
    });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const body = await read(`${base}/v1/turns/turn/events`);
    expect(parse(body).map(e => e.sequence)).toEqual(Array.from({ length: 601 }, (_, i) => i + 1));
    const sizes = await Promise.all(page.mock.results.map(async result => (await result.value).events.length));
    expect(sizes).toEqual([256, 256, 88, 1]);
    expect(page.mock.calls[0]![2].throughSequence).toBe(600);
  });

  it("drops a cached page after a separate SQLite process deletes its source during drain", async () => {
    await repo.createMessage(ctx, { id: "source_identity", sessionId: "session", role: "user" });
    await database.client.execute("UPDATE message_versions SET message_id='source_identity' WHERE turn_id='turn' AND role='user' AND version=1");
    for (let i = 1; i <= 3; i += 1) await append(i, `private event ${i}`);
    let raw!: ServerResponse; let hold = true; let body = "";
    app.addHook("onRequest", async (req, reply) => {
      if (!req.url.endsWith("/events")) return;
      raw = reply.raw; const original = raw.write.bind(raw);
      raw.write = ((frame: string) => {
        const accepted = original(frame);
        return hold ? false : accepted;
      }) as typeof raw.write;
    });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    const request = get(`${base}/v1/turns/turn/events`, response => {
      response.on("data", chunk => { body += chunk.toString(); });
      response.on("error", () => undefined);
      response.on("close", close);
    });
    clients.push(request); request.on("error", () => undefined);
    await vi.waitFor(() => expect(parse(body).map(e => e.sequence)).toEqual([1]));
    expect(page).toHaveBeenCalledOnce();
    const databasePath = String((await database.client.execute("PRAGMA database_list")).rows.find(row => row.name === "main")!.file);
    // Separate connection/process: no shared hub wake or in-memory source flag.
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      import { createDatabase, SqliteConversationRepository } from '@aervox/repositories';
      const database = await createDatabase({ url: 'file:' + process.argv[1] });
      try {
        const result = await new SqliteConversationRepository(database.db).softDeleteMessage(
          { workspaceId: 'local', subjectUserId: 'local' }, 'source_identity');
        if (!result) throw new Error('synthetic_source_not_deleted');
      } finally { database.client.close(); }
    `, databasePath], { timeout: 5_000 });
    expect((await repo.getMessage(ctx, "source_identity"))?.deletedAt).toBeTruthy();
    hold = false; raw.emit("drain");
    await tick(120);
    expect(parse(body).map(e => e.sequence)).toEqual([1]);
    await vi.waitFor(() => expect(raw.destroyed).toBe(true));
    await closed;
    expect(parse(body).map(e => e.sequence)).toEqual([1]);
    expect(disclosure.mock.calls.map(call => call[2])).toEqual(["event_1", "event_2"]);
    expect(page).toHaveBeenCalledOnce();
    expect((await repo.listTurnAttempts(ctx, "turn"))[0]!.status).toBe("Running");
    expect((await repo.getStreamEvents(ctx, "turn")).map(e => e.eventType)).toEqual(["delta", "delta", "delta"]);
    const denied = await app.inject({ method: "GET", url: "/v1/turns/turn/events", headers: { "last-event-id": "event_1" } });
    const missing = await app.inject({ method: "GET", url: "/v1/turns/missing/events" });
    expect(denied.statusCode).toBe(404);
    const { requestId: deniedRequestId, ...deniedProblem } = denied.json();
    const { requestId: missingRequestId, ...missingProblem } = missing.json();
    expect(deniedRequestId).toBeTypeOf("string"); expect(missingRequestId).toBeTypeOf("string");
    expect(deniedProblem).toEqual(missingProblem);
  });
});
