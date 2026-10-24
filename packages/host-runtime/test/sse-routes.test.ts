import Fastify from "fastify";
import { get, type ClientRequest, type IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteConversationRepository, TurnStreamEventModel } from "@aervox/repositories";
import { createNoopObservability } from "@aervox/observability";
import { registerConversationRoutes } from "../src/modules/companion/conversation/routes.js";
import { turnStreamHub } from "../src/modules/companion/conversation/stream-hub.js";

const event = (sequence: number, eventType = "delta"): TurnStreamEventModel => ({
  id: `ev_${sequence}`, turnId: "turn", sequence, eventType, payloadVersion: 1,
  occurredAt: "2026-10-22T00:00:00.000Z", data: { text: `event ${sequence}` },
});
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
const tick = (ms = 30) => new Promise<void>(r => setTimeout(r, ms));
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("test_completion_deadline")), 2_000);
    })]);
  } finally { clearTimeout(timer!); }
};

function fixture() {
  const events = [event(1), event(2), event(3)];
  const attempts = [{ id: "attempt", status: "Running" }];
  const getTurn = vi.fn(async () => ({ id: "turn" }));
  const source = { disclosable: true, turnExists: true };
  const isTurnStreamDisclosable = vi.fn(async () => source.disclosable && source.turnExists);
  const eventForDisclosure = vi.fn(async (_ctx, _turnId, id) =>
    source.disclosable ? events.find(e => e.id === id) ?? null : null);
  const highWater = vi.fn(async () => events.at(-1)?.sequence ?? 0);
  const replayState = vi.fn(async () => ({
    highWaterSequence: events.at(-1)?.sequence ?? 0,
    settled: attempts.length > 0 && attempts.every(a => ["Completed", "Failed", "Interrupted", "Cancelled"].includes(a.status)),
  }));
  const page = vi.fn(async (_ctx, _turnId, options) => ({
    events: events.filter(e => e.sequence > options.afterSequence && e.sequence <= options.throughSequence).slice(0, 1),
    persistedDataBytes: 32, oversizedEvent: false,
  }));
  const repo = {
    getTurn, getStreamEventHighWater: highWater, getStreamReplayState: replayState, getStreamEventsPage: page,
    getStreamEventById: vi.fn(async (_ctx, _turnId, id) => events.find(e => e.id === id) ?? null),
    isTurnStreamDisclosable, getStreamEventForDisclosure: eventForDisclosure,
    listTurnAttempts: vi.fn(async () => attempts.map(a => ({ ...a }))),
    requestCancelTurnAttempt: vi.fn(),
  } as unknown as SqliteConversationRepository;
  const app = Fastify({ logger: false });
  const logInfo = vi.fn();
  const noopObservability = createNoopObservability();
  const observability = { ...noopObservability, log: { ...noopObservability.log, info: logInfo } };
  return { app, repo, events, attempts, source, isTurnStreamDisclosable, eventForDisclosure, getTurn, highWater, replayState, page, observability, logInfo };
}

async function open(url: string, requests: ClientRequest[], cursor?: string) {
  const headers = cursor ? { "Last-Event-ID": cursor } : undefined;
  const received = deferred<IncomingMessage>();
  const request = get(url, { headers }, received.resolve);
  requests.push(request); request.on("error", () => undefined);
  const response = await bounded(received.promise);
  let body = "";
  const ended = deferred();
  response.on("data", chunk => { body += chunk.toString(); });
  response.on("error", () => undefined);
  response.on("end", () => ended.resolve());
  return { request, response, body: () => body, ended: ended.promise };
}
const parse = (body: string) => body.split("\n\n")
  .map(block => block.split("\n").find(line => line.startsWith("data: ")))
  .filter((line): line is string => Boolean(line))
  .map(line => JSON.parse(line.slice(6)));

describe("SSE bounded replay over real HTTP", () => {
  const apps: ReturnType<typeof fixture>["app"][] = [];
  const requests: ClientRequest[] = [];
  afterEach(async () => {
    for (const request of requests.splice(0)) request.destroy();
    for (const app of apps.splice(0)) await bounded(app.close());
    vi.restoreAllMocks();
  });
  const start = async (f: ReturnType<typeof fixture>) => {
    apps.push(f.app);
    registerConversationRoutes(f.app, { commands: {}, queries: f.repo } as never, { observability: f.observability });
    return `${await f.app.listen({ host: "127.0.0.1", port: 0 })}/v1/turns/turn/events`;
  };

  it("stops fetching pages under backpressure, coalesces bus wakes, and reconnects without cancelling the Attempt", async () => {
    const f = fixture(); const blocked = deferred(); let raw!: ServerResponse; let hold = true;
    f.app.addHook("onRequest", async (_req, reply) => {
      raw = reply.raw; const original = raw.write.bind(raw);
      raw.write = ((frame: string) => {
        const accepted = original(frame);
        if (hold) { blocked.resolve(); return false; }
        return accepted;
      }) as typeof raw.write;
    });
    const unsubscribe = vi.fn(); const subscribe = turnStreamHub.subscribe.bind(turnStreamHub);
    vi.spyOn(turnStreamHub, "subscribe").mockImplementation((id, subscriber) => {
      const stop = subscribe(id, subscriber);
      return () => { unsubscribe(); stop(); };
    });
    const url = await start(f); const first = await open(url, requests);
    await bounded(blocked.promise);
    const pagesBeforeWake = f.page.mock.calls.length;
    for (let i = 0; i < 10_000; i += 1) turnStreamHub.publishEvent("turn", event(i % 2 ? 3 : 2));
    await tick(120);
    expect(f.page).toHaveBeenCalledTimes(pagesBeforeWake);
    expect(parse(first.body()).map(e => e.sequence)).toEqual([1]);
    hold = false; raw.emit("drain");
    await vi.waitFor(() => expect(parse(first.body()).map(e => e.sequence)).toEqual([1, 2, 3]));
    first.response.destroy(); first.request.destroy();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    expect(f.logInfo).toHaveBeenCalledOnce();
    const log = f.logInfo.mock.calls[0]![0];
    expect(log).toEqual({
      event: "sse.connection.closed", message: "SSE connection closed",
      fields: { reason: "sse_closed", pages: 3, oversizedEvents: 0,
        backpressureWaits: 1, peakQueuedBytes: expect.any(Number), writableHighWaterMark: expect.any(Number) },
    });
    for (const [name, value] of Object.entries(log.fields)) {
      if (name !== "reason") expect(typeof value).toBe("number");
    }
    expect(JSON.stringify(log)).not.toContain("event 1");
    expect(JSON.stringify(log)).not.toContain("text");
    expect(f.attempts[0]!.status).toBe("Running");
    expect(f.repo.requestCancelTurnAttempt).not.toHaveBeenCalled();
    expect(f.events.some(e => e.eventType === "done")).toBe(false);
    f.events.push(event(4, "done")); f.attempts[0]!.status = "Completed";
    const second = await open(url, requests, "ev_1"); await bounded(second.ended);
    expect(parse(second.body()).map(e => e.sequence)).toEqual([2, 3, 4]);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("discards the rest of a cached page when its source is deleted during socket drain", async () => {
    const f = fixture(); const blocked = deferred(); let raw!: ServerResponse; let hold = true;
    f.page.mockImplementation(async () => ({
      events: structuredClone(f.events), persistedDataBytes: 96, oversizedEvent: false,
    }));
    f.app.addHook("onRequest", async (_req, reply) => {
      raw = reply.raw; const original = raw.write.bind(raw);
      raw.write = ((frame: string) => {
        const accepted = original(frame);
        if (hold) { blocked.resolve(); return false; }
        return accepted;
      }) as typeof raw.write;
    });
    const response = await open(await start(f), requests); await bounded(blocked.promise);
    const closed = deferred(); response.response.once("close", () => closed.resolve());
    f.source.disclosable = false;
    hold = false; raw.emit("drain"); await tick(120);
    expect(parse(response.body()).map(e => e.sequence)).toEqual([1]);
    await bounded(closed.promise);
    expect(f.eventForDisclosure.mock.calls.map(call => call[2])).toEqual(["ev_1", "ev_2"]);
    expect(f.page).toHaveBeenCalledOnce();
    expect(f.attempts[0]!.status).toBe("Running");
    expect(f.repo.requestCancelTurnAttempt).not.toHaveBeenCalled();
    expect(f.events.map(e => e.eventType)).toEqual(["delta", "delta", "delta"]);
  });

  it("encodes the current persisted event instead of the body cached by pagination", async () => {
    const f = fixture(); f.attempts[0]!.status = "Completed";
    f.page.mockImplementation(async (_ctx, _turnId, options) => {
      const cached = structuredClone(f.events.filter(e => e.sequence > options.afterSequence));
      f.events[1]!.data = { text: "current persisted projection" };
      return { events: cached, persistedDataBytes: 96, oversizedEvent: false };
    });
    const response = await open(await start(f), requests); await bounded(response.ended);
    expect(parse(response.body())[1].data).toEqual({ text: "current persisted projection" });
    expect(f.eventForDisclosure).toHaveBeenCalledTimes(3);
  });

  it("closes an idle stream after its source becomes unavailable without a bus event", async () => {
    const f = fixture(); const response = await open(await start(f), requests);
    await vi.waitFor(() => expect(parse(response.body())).toHaveLength(3));
    const closed = deferred(); response.response.once("close", () => closed.resolve());
    f.source.disclosable = false;
    await bounded(closed.promise);
    expect(parse(response.body()).map(e => e.sequence)).toEqual([1, 2, 3]);
    expect(f.attempts[0]!.status).toBe("Running");
    expect(f.repo.requestCancelTurnAttempt).not.toHaveBeenCalled();
    expect(f.events.some(e => e.eventType === "done" || e.eventType === "error")).toBe(false);
  });

  it("uses the same pre-stream response for an unavailable source and an absent Turn", async () => {
    const f = fixture(); f.source.disclosable = false;
    const url = await start(f);
    const unavailable = await open(url, requests); await bounded(unavailable.ended);
    f.source.turnExists = false;
    const absent = await open(url, requests); await bounded(absent.ended);
    expect(unavailable.response.statusCode).toBe(404);
    expect(unavailable.body()).toBe(absent.body());
    expect(f.page).not.toHaveBeenCalled();
    expect(f.eventForDisclosure).not.toHaveBeenCalled();
  });

  it("replays commits made while capturing the initial high-water in database order", async () => {
    const f = fixture(); f.events.splice(1);
    f.highWater.mockImplementationOnce(async () => {
      f.events.push(event(2), event(3));
      turnStreamHub.publishEvent("turn", event(3)); turnStreamHub.publishEvent("turn", event(2));
      return 1;
    });
    f.attempts[0]!.status = "Completed";
    const response = await open(await start(f), requests); await bounded(response.ended);
    expect(parse(response.body()).map(e => e.sequence)).toEqual([1, 2, 3]);
    expect(f.page.mock.calls[0]![2].throughSequence).toBe(1);
  });

  it("keeps a running continuation open when the old Interrupted Attempt settles", async () => {
    const f = fixture(); f.attempts.unshift({ id: "old", status: "Interrupted" });
    const response = await open(await start(f), requests);
    await vi.waitFor(() => expect(parse(response.body())).toHaveLength(3));
    turnStreamHub.publishSettled("turn", "Interrupted");
    await tick(120); expect(response.response.complete).toBe(false);
    f.attempts[1]!.status = "Completed"; f.events.push(event(4, "done"));
    turnStreamHub.publishSettled("turn", "Completed"); await bounded(response.ended);
    expect(parse(response.body()).map(e => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("does not close a continuation started during the last terminal snapshot read", async () => {
    const f = fixture(); f.attempts[0]!.status = "Interrupted";
    const readState = f.replayState.getMockImplementation()!;
    f.replayState.mockImplementation(async () => {
      if (f.replayState.mock.calls.length === 2) f.attempts.push({ id: "continuation", status: "Running" });
      return readState();
    });
    const response = await open(await start(f), requests);
    await vi.waitFor(() => expect(f.attempts).toHaveLength(2));
    await tick(120);
    expect(response.response.complete).toBe(false);
    f.attempts[1]!.status = "Completed"; f.events.push(event(4, "done"));
    turnStreamHub.publishSettled("turn", "Completed"); await bounded(response.ended);
    expect(parse(response.body()).map(e => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("replays a terminal commit observed by the final consistent snapshot before closing", async () => {
    const f = fixture(); f.attempts[0]!.status = "Interrupted";
    const readState = f.replayState.getMockImplementation()!;
    f.replayState.mockImplementation(async () => {
      if (f.replayState.mock.calls.length === 2) f.events.push(event(4, "done"));
      return readState();
    });
    const response = await open(await start(f), requests); await bounded(response.ended);
    expect(parse(response.body()).map(e => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("preClose destroys a backpressured SSE socket before waiting for the HTTP server", async () => {
    const f = fixture(); const blocked = deferred();
    f.app.addHook("onRequest", async (_req, reply) => {
      const original = reply.raw.write.bind(reply.raw);
      reply.raw.write = ((frame: string) => { original(frame); blocked.resolve(); return false; }) as typeof reply.raw.write;
    });
    await open(await start(f), requests); await bounded(blocked.promise);
    await bounded(f.app.close());
    expect(f.attempts[0]!.status).toBe("Running");
    expect(f.repo.requestCancelTurnAttempt).not.toHaveBeenCalled();
    expect(f.page).toHaveBeenCalledOnce();
  });

  it("starts the 10-minute connection deadline during initial replay and closes only the subscription", async () => {
    const f = fixture(); const blocked = deferred(); let expire!: () => void;
    const setTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
      if (delay === 10 * 60_000) expire = callback as () => void;
      return setTimer(callback, delay, ...args);
    }) as typeof setTimeout);
    f.app.addHook("onRequest", async (_req, reply) => {
      const original = reply.raw.write.bind(reply.raw);
      reply.raw.write = ((frame: string) => { original(frame); blocked.resolve(); return false; }) as typeof reply.raw.write;
    });
    const response = await open(await start(f), requests); await bounded(blocked.promise);
    expect(expire).toBeTypeOf("function");
    const closed = deferred(); response.response.once("close", () => closed.resolve());
    expire(); await bounded(closed.promise);
    expect(f.page).toHaveBeenCalledOnce(); expect(f.attempts[0]!.status).toBe("Running");
    expect(f.repo.requestCancelTurnAttempt).not.toHaveBeenCalled();
    expect(parse(response.body()).map(e => e.eventType)).toEqual(["delta"]);
  });

  it("rejects late SSE registration after preClose while its source check is pending", async () => {
    const f = fixture(); const reading = deferred(); const release = deferred<void>(); const closing = deferred();
    f.isTurnStreamDisclosable.mockImplementation(async () => { reading.resolve(); await release.promise; return true; });
    apps.push(f.app); registerConversationRoutes(f.app, { commands: {}, queries: f.repo } as never);
    f.app.addHook("preClose", async () => { closing.resolve(); });
    const url = `${await f.app.listen({ host: "127.0.0.1", port: 0 })}/v1/turns/turn/events`;
    const responsePending = open(url, requests);
    await bounded(reading.promise); const closed = f.app.close();
    await bounded(closing.promise); release.resolve();
    const response = await responsePending; await bounded(response.ended); await bounded(closed);
    expect(response.response.statusCode).toBe(503);
    expect(f.page).not.toHaveBeenCalled();
    expect(f.highWater).not.toHaveBeenCalled();
  });

  it("does not register a disconnected request after its pending source check", async () => {
    const f = fixture(); f.events.splice(0);
    const reading = deferred(); const release = deferred<void>(); const readDone = deferred();
    f.isTurnStreamDisclosable.mockImplementation(async () => {
      reading.resolve(); await release.promise; readDone.resolve(); return true;
    });
    const subscribe = vi.spyOn(turnStreamHub, "subscribe");
    const url = await start(f); const request = get(url); requests.push(request);
    request.on("error", () => undefined);
    await bounded(reading.promise); request.destroy(); await tick(); release.resolve();
    await bounded(readDone.promise); await tick(120);
    expect(subscribe).not.toHaveBeenCalled();
    expect(f.highWater).not.toHaveBeenCalled();
    expect(f.repo.requestCancelTurnAttempt).not.toHaveBeenCalled();
    await bounded(f.app.close());
  });

  it("closes on an empty replay page instead of looping on a stale high-water", async () => {
    const f = fixture(); f.attempts[0]!.status = "Completed";
    f.page.mockResolvedValue({ events: [], persistedDataBytes: 0, oversizedEvent: false });
    const url = await start(f); const request = get(url); requests.push(request);
    const closed = deferred(); request.on("error", () => closed.resolve());
    request.on("response", response => { response.resume(); response.on("close", () => closed.resolve()); });
    await bounded(closed.promise); expect(f.page).toHaveBeenCalledOnce();
    expect(f.highWater).toHaveBeenCalledOnce();
  });

  it("does not write a disclosure query result after the client disconnects", async () => {
    const f = fixture(); const reading = deferred(); const release = deferred();
    const write = vi.fn();
    f.eventForDisclosure.mockImplementationOnce(async () => {
      reading.resolve(); await release.promise; return f.events[0]!;
    });
    f.app.addHook("onRequest", async (_req, reply) => {
      const original = reply.raw.write.bind(reply.raw);
      reply.raw.write = ((frame: string) => { write(frame); return original(frame); }) as typeof reply.raw.write;
    });
    const request = get(await start(f)); requests.push(request);
    request.on("error", () => undefined);
    await bounded(reading.promise); request.destroy(); await tick(); release.resolve(); await tick(120);
    expect(write).not.toHaveBeenCalled();
    expect(f.eventForDisclosure).toHaveBeenCalledOnce();
    expect(f.repo.requestCancelTurnAttempt).not.toHaveBeenCalled();
    expect(f.attempts[0]!.status).toBe("Running");
  });

  it("closes a failed disclosure query without changing durable events or the Attempt", async () => {
    const f = fixture(); f.eventForDisclosure.mockRejectedValueOnce(new Error("synthetic_read_failure"));
    const request = get(await start(f)); requests.push(request);
    const closed = deferred(); request.on("error", () => closed.resolve());
    request.on("response", response => { response.resume(); response.on("close", () => closed.resolve()); });
    await bounded(closed.promise);
    expect(f.eventForDisclosure).toHaveBeenCalledOnce();
    expect(f.repo.requestCancelTurnAttempt).not.toHaveBeenCalled();
    expect(f.attempts[0]!.status).toBe("Running");
    expect(f.events.map(e => e.eventType)).toEqual(["delta", "delta", "delta"]);
  });
});
