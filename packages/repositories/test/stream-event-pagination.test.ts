import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository,
  MAX_STREAM_EVENT_PAGE_ROWS, MAX_STREAM_EVENT_PAGE_DATA_BYTES } from "../src/index.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
describe("durable stream transport pages", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase(); repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(ctx, "session");
    for (const id of ["turn", "other"]) await repo.createTurnWithOutbox(ctx,
      { id, sessionId: "session", idempotencyKey: id }, { id: `m_${id}`, content: "test" });
  });
  afterEach(async () => { vi.restoreAllMocks(); await database.cleanup(); });
  const append = (sequence: number, data: unknown = {}, turnId = "turn") => repo.appendStreamEvent(ctx,
    { id: `${turnId}_${sequence}`, turnId, sequence, eventType: "delta", data });

  it("reads terminal status and watermark together, including a Running continuation without events", async () => {
    expect(await repo.getStreamReplayState(ctx, "turn")).toEqual({ highWaterSequence: 0, settled: false });
    await repo.createTurnAttempt(ctx, "turn", { id: "old", attempt: 1 });
    await repo.finalizeTurnAttempt(ctx, { turnId: "turn", attemptId: "old", status: "Interrupted" });
    await append(1);
    await repo.createTurnAttempt(ctx, "other", { id: "unrelated", attempt: 1 });
    await append(900, {}, "other");
    const select = vi.spyOn(database.db, "select");
    expect(await repo.getStreamReplayState(ctx, "turn")).toEqual({ highWaterSequence: 1, settled: true });
    expect(select).toHaveBeenCalledOnce();
    await repo.createTurnAttempt(ctx, "turn", { id: "continuation", attempt: 2 });
    expect(await repo.getStreamReplayState(ctx, "turn")).toEqual({ highWaterSequence: 1, settled: false });
    await repo.finalizeTurnAttempt(ctx, { turnId: "turn", attemptId: "continuation", status: "Completed" });
    await append(2);
    expect(await repo.getStreamReplayState(ctx, "turn")).toEqual({ highWaterSequence: 2, settled: true });
  });

  it("caps rows and replays a captured high-water snapshot without gaps or duplicates", async () => {
    for (let i = 1; i <= 600; i += 1) await append(i);
    await append(900, {}, "other");
    const highWater = await repo.getStreamEventHighWater(ctx, "turn");
    expect(highWater).toBe(600); expect(await repo.getStreamEventHighWater(ctx, "empty")).toBe(0);
    await append(601);
    let after = 0; const seen: number[] = []; const sizes: number[] = [];
    while (after < highWater) {
      const page = await repo.getStreamEventsPage(ctx, "turn", { afterSequence: after, throughSequence: highWater, limit: 100_000 });
      sizes.push(page.events.length); seen.push(...page.events.map(e => e.sequence));
      after = page.events.at(-1)!.sequence;
      expect(page.persistedDataBytes).toBeLessThanOrEqual(MAX_STREAM_EVENT_PAGE_DATA_BYTES);
    }
    expect(sizes).toEqual([MAX_STREAM_EVENT_PAGE_ROWS, MAX_STREAM_EVENT_PAGE_ROWS, 88]);
    expect(seen).toEqual(Array.from({ length: 600 }, (_, i) => i + 1));
    expect((await repo.getStreamEventsPage(ctx, "turn", { afterSequence: after, throughSequence: 601 })).events.map(e => e.sequence)).toEqual([601]);
    // Resume's existing full-history reader is intentionally unaffected.
    expect(await repo.getStreamEvents(ctx, "turn")).toHaveLength(601);
  });

  it("counts SQLite UTF-8 bytes before materializing a bounded data prefix", async () => {
    const data = { text: "界".repeat(30_000) };
    for (let i = 1; i <= 4; i += 1) await append(i, data);
    const page = await repo.getStreamEventsPage(ctx, "turn", { throughSequence: 4 });
    expect(page.events.map(e => e.sequence)).toEqual([1, 2]);
    expect(page.persistedDataBytes).toBe(Buffer.byteLength(JSON.stringify(data)) * 2);
    expect(page.oversizedEvent).toBe(false);
    expect((await repo.getStreamEventsPage(ctx, "turn", { afterSequence: 2, throughSequence: 4 })).events.map(e => e.sequence)).toEqual([3, 4]);
  });

  it("returns one oversized historical event intact and advances to the following event", async () => {
    const data = { text: "x".repeat(MAX_STREAM_EVENT_PAGE_DATA_BYTES + 1) };
    await append(1, data); await append(2, { text: "following" });
    const page = await repo.getStreamEventsPage(ctx, "turn", { throughSequence: 2 });
    expect(page.events).toMatchObject([{ sequence: 1, data }]);
    expect(page.events).toHaveLength(1); expect(page.oversizedEvent).toBe(true);
    expect((await repo.getStreamEventsPage(ctx, "turn", { afterSequence: 1, throughSequence: 2 })).events).toMatchObject([{ sequence: 2 }]);
  });

  it("rejects invalid cursors and clamps the requested row budget", async () => {
    await append(1); await append(2);
    for (const throughSequence of [NaN, Infinity, -1, 1.5]) {
      await expect(repo.getStreamEventsPage(ctx, "turn", { throughSequence })).rejects.toThrow("invalid_stream_event_page_sequence");
    }
    await expect(repo.getStreamEventsPage(ctx, "turn", { throughSequence: 2, limit: NaN })).rejects.toThrow("invalid_stream_event_page_limit");
    expect((await repo.getStreamEventsPage(ctx, "turn", { throughSequence: 2, limit: 0 })).events).toHaveLength(1);
    expect((await repo.getStreamEventsPage(ctx, "turn", { afterSequence: 2, throughSequence: 1 })).events).toEqual([]);
  });

  it("does not invent a row when deletion happens between metadata and payload reads", async () => {
    await append(1);
    const highWater = await repo.getStreamEventHighWater(ctx, "turn");
    const select = database.db.select.bind(database.db);
    let reads = 0;
    vi.spyOn(database.db, "select").mockImplementation(((...args: unknown[]) => {
      reads += 1;
      if (reads === 2) {
        // Enqueue a real SQLite deletion before the payload statement executes.
        void database.client.execute("DELETE FROM turn_stream_events WHERE turn_id = 'turn'");
      }
      return select(...args as []);
    }) as typeof database.db.select);
    const page = await repo.getStreamEventsPage(ctx, "turn", { throughSequence: highWater });
    expect(page.events).toEqual([]);
    expect(await repo.getStreamEventHighWater(ctx, "turn")).toBe(0);
  });
});
