import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  SqliteOutboxRepository,
  SqlitePlatformRepository,
} from "@aervox/repositories";
import { buildHostRuntime } from "@aervox/host-runtime";
import { runOutboxCycle } from "../src/outbox-worker.js";
import { runDelegatedTurnCycle } from "../src/turn-consumer.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const completedResponse = () => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: "已完成。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const whileAnotherOwnerIsActive = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("duplicate_poll_waited_for_live_owner")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
};

/** File SQLite and separate connections make committed state observable across host reopen. */
async function createFileFixture() {
  const root = await mkdtemp(join(tmpdir(), "avx-turn-dispatch-"));
  const url = `file:${join(root, "main.db")}`;
  const apiConnection = await createDatabase({ url });
  let workerConnection: Awaited<ReturnType<typeof createDatabase>> | undefined;
  let api: Awaited<ReturnType<typeof buildHostRuntime>> | undefined;
  let worker: Awaited<ReturnType<typeof buildHostRuntime>> | undefined;
  const options = { skillsRoot: join(root, "skills"), pluginsRoot: join(root, "plugins"), embeddingProvider: null };
  const openWorker = async () => {
    workerConnection = await createDatabase({ url });
    worker = await buildHostRuntime({ ...options, db: workerConnection.db, client: workerConnection.client, role: "worker" });
    await worker.app.ready();
  };
  const closeWorker = async () => {
    await worker?.app.close();
    workerConnection?.client.close();
    worker = undefined;
    workerConnection = undefined;
  };
  try {
    await initDatabaseSchema(apiConnection.client);
    api = await buildHostRuntime({ ...options, db: apiConnection.db, client: apiConnection.client });
    await api.app.ready();
    await openWorker();
  } catch (error) {
    await closeWorker();
    await api?.app.close();
    apiConnection.client.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const repo = new SqliteConversationRepository(apiConnection.db);
  return {
    repo,
    client: apiConnection.client,
    get worker() { return worker!; },
    get outboxRepo() { return new SqliteOutboxRepository(workerConnection!.db); },
    get platformRepo() { return new SqlitePlatformRepository(workerConnection!.db); },
    async accept(marker: string) {
      const response = await api!.app.inject({
        method: "POST", url: `/v1/sessions/${marker}/turns`,
        headers: { "idempotency-key": `request_${marker}` },
        payload: {
          message: { content: marker, contentType: "text" },
          clientVersion: "dispatch-test", references: [], metadata: {}, toolApprovalMode: "ask",
        },
      });
      if (response.statusCode !== 201) throw new Error(response.body);
      return response.json().turnId as string;
    },
    async reopenWorker() { await closeWorker(); await openWorker(); },
    async close() {
      await closeWorker();
      await api!.app.close();
      apiConnection.client.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("bounded delegated turns with file SQLite", () => {
  let fixture: Awaited<ReturnType<typeof createFileFixture>>;
  beforeEach(async () => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "llm");
    vi.stubEnv("AERVOX_LOOP_DISPATCH", "worker");
    vi.stubEnv("AERVOX_TURN_EXECUTION", "background");
    vi.stubEnv("AERVOX_LOOP_RESUME", "off");
    fixture = await createFileFixture();
  });
  afterEach(async () => {
    await fixture?.close();
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  });

  it("completes a second turn and ordinary Outbox work while the first model is blocked, keeping excess turns durable", async () => {
    const gate = deferred();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const request = String(init?.body);
      const marker = ["DISPATCH_TASK_A", "DISPATCH_TASK_B", "DISPATCH_TASK_C"].find(value => request.includes(value));
      if (!marker) throw new Error("Unexpected model input");
      requests.push(marker);
      if (marker === "DISPATCH_TASK_A") await gate.promise;
      return completedResponse();
    }));
    const first = await fixture.accept("DISPATCH_TASK_A");
    const second = await fixture.accept("DISPATCH_TASK_B");
    const queued = await fixture.accept("DISPATCH_TASK_C");
    const outboxRepo = fixture.outboxRepo;
    const work = runDelegatedTurnCycle({ outboxRepo, workerId: "bounded-test", host: fixture.worker.conversation, concurrency: 2 });
    void work.catch(() => undefined);
    let finished = false;
    void work.then(() => { finished = true; }, () => { finished = true; });
    try {
      await vi.waitFor(async () => expect((await fixture.repo.getTurn(local, second))?.status).toBe("Completed"), { timeout: 5_000 });
      expect([...requests].sort()).toEqual(["DISPATCH_TASK_A", "DISPATCH_TASK_B"]);
      expect(finished).toBe(false);
      expect((await fixture.repo.listTurnAttempts(local, first))[0]).toMatchObject({ status: "Running", fencingToken: 1 });
      expect((await fixture.repo.listTurnAttempts(local, queued))[0]).toMatchObject({ status: "Running", fencingToken: 0, leaseId: null });
      expect(await outboxRepo.getEventById(`outbox_${first}`)).toMatchObject({ status: "pending", retryCount: 0 });
      expect(await outboxRepo.getEventById(`outbox_${queued}`)).toMatchObject({ status: "pending", retryCount: 0 });
      await outboxRepo.insertEvent(local, { id: "ordinary_event", idempotencyKey: "ordinary_event", eventType: "dispatch.probe", payload: {} });
      await runOutboxCycle({ outboxRepo, platformRepo: fixture.platformRepo, workerId: "ordinary-test" });
      expect(await outboxRepo.getEventById("ordinary_event")).toMatchObject({ status: "published" });
      expect(await outboxRepo.getEventById(`outbox_${first}`)).toMatchObject({ status: "pending", retryCount: 0 });
      expect(await outboxRepo.getEventById(`outbox_${queued}`)).toMatchObject({ status: "pending", retryCount: 0 });
    } finally {
      gate.resolve();
      await work;
    }
    expect(await outboxRepo.getEventById(`outbox_${first}`)).toMatchObject({ status: "published" });
    await runDelegatedTurnCycle({ outboxRepo, workerId: "next-batch", host: fixture.worker.conversation, concurrency: 2 });
    expect([...requests].sort()).toEqual(["DISPATCH_TASK_A", "DISPATCH_TASK_B", "DISPATCH_TASK_C"]);
    expect((await fixture.repo.getTurn(local, queued))?.status).toBe("Completed");
    expect(await outboxRepo.getEventById(`outbox_${queued}`)).toMatchObject({ status: "published" });
  });

  it("keeps an active delivery pending without repeating model work during repeated polling", async () => {
    const gate = deferred();
    const fetch = vi.fn(async () => { await gate.promise; return completedResponse(); });
    vi.stubGlobal("fetch", fetch);
    const turnId = await fixture.accept("REPEATED_DISPATCH_TASK");
    const outboxRepo = fixture.outboxRepo;
    const work = runDelegatedTurnCycle({ outboxRepo, workerId: "first-poll", host: fixture.worker.conversation, concurrency: 2 });
    void work.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      for (let poll = 0; poll < 3; poll++) {
        await whileAnotherOwnerIsActive(runDelegatedTurnCycle({ outboxRepo, workerId: `duplicate-${poll}`, host: fixture.worker.conversation, concurrency: 2 }));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(await outboxRepo.getEventById(`outbox_${turnId}`)).toMatchObject({ status: "pending", retryCount: 0 });
      }
      expect(await fixture.repo.listTurnAttempts(local, turnId)).toHaveLength(1);
    } finally { gate.resolve(); await work; }
    expect(await outboxRepo.getEventById(`outbox_${turnId}`)).toMatchObject({ status: "published", retryCount: 0 });
  });

  it("reconciles a committed terminal attempt after an acknowledgement failure and Worker reopen without calling the model again", async () => {
    const fetch = vi.fn(async () => completedResponse());
    vi.stubGlobal("fetch", fetch);
    const turnId = await fixture.accept("ACK_FAILURE_TASK");
    const outboxRepo = fixture.outboxRepo;
    const failure = vi.spyOn(outboxRepo, "markPublished").mockRejectedValueOnce(new Error("test_ack_unavailable"));
    try {
      try {
        await runDelegatedTurnCycle({ outboxRepo, workerId: "before-reopen", host: fixture.worker.conversation, concurrency: 2 });
      } catch (error) { expect(String(error)).toContain("test_ack_unavailable"); }
      expect((await fixture.repo.getTurn(local, turnId))?.status).toBe("Completed");
      expect((await fixture.repo.listTurnAttempts(local, turnId))[0]).toMatchObject({ status: "Completed", attempt: 1 });
      expect(await outboxRepo.getEventById(`outbox_${turnId}`)).toMatchObject({ status: "pending", retryCount: 0 });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { failure.mockRestore(); }
    await fixture.reopenWorker();
    await runDelegatedTurnCycle({ outboxRepo: fixture.outboxRepo, workerId: "after-reopen", host: fixture.worker.conversation, concurrency: 2 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await fixture.repo.listTurnAttempts(local, turnId)).toHaveLength(1);
    expect(await fixture.outboxRepo.getEventById(`outbox_${turnId}`)).toMatchObject({ status: "published" });
  });

  it("does not claim or acknowledge durable work when the batch is already cancelled", async () => {
    const fetch = vi.fn(async () => completedResponse());
    vi.stubGlobal("fetch", fetch);
    const turnId = await fixture.accept("CANCELLED_BATCH_TASK");
    const controller = new AbortController(); controller.abort();
    await runDelegatedTurnCycle({ outboxRepo: fixture.outboxRepo, workerId: "cancelled", host: fixture.worker.conversation, concurrency: 2, signal: controller.signal });
    expect(fetch).not.toHaveBeenCalled();
    expect((await fixture.repo.listTurnAttempts(local, turnId))[0]).toMatchObject({ status: "Running", fencingToken: 0, leaseId: null });
    expect(await fixture.outboxRepo.getEventById(`outbox_${turnId}`)).toMatchObject({ status: "pending", retryCount: 0 });
  });

  it.each(["changed-intent", "soft-deleted"])("dead-letters a bound %s receipt and then safely retires its previously protected queued Attempt", async reason => {
    const fetch = vi.fn(async () => completedResponse()); vi.stubGlobal("fetch", fetch);
    const turnId = await fixture.accept(`INVALID_RECEIPT_${reason}`);
    const eventId = `outbox_${turnId}`;
    const originalHash = (await fixture.repo.getTurn(local, turnId))?.requestHash;
    await fixture.client.execute({ sql: "UPDATE turn_attempts SET started_at = ? WHERE turn_id = ?", args: ["2000-01-01T00:00:00.000Z", turnId] });
    expect(await fixture.repo.recoverExpiredAttempts(fixture.client, { dispatchTarget: "default", unclaimedTimeoutMs: 1 })).toBe(0);
    if (reason === "changed-intent") {
      await fixture.client.execute({
        sql: "UPDATE outbox_events SET payload = json_set(payload, '$.intent.message.content', ?) WHERE id = ?",
        args: ["different accepted intent", eventId],
      });
    } else {
      const inputs = await fixture.client.execute({ sql: "SELECT message_id FROM message_versions WHERE turn_id = ? AND role = 'user' AND version = 1", args: [turnId] });
      expect(inputs.rows).toHaveLength(1);
      expect(await fixture.repo.softDeleteMessage(local, String(inputs.rows[0].message_id))).not.toBeNull();
    }
    // The locator still binds to the original hash; it cannot prove that the
    // accepted intent and source input are currently eligible for execution.
    expect((await fixture.repo.getTurn(local, turnId))?.requestHash).toBe(originalHash);
    expect(await fixture.repo.hasWorkerDelegation(turnId, eventId)).toBe(true);
    expect(await fixture.repo.recoverExpiredAttempts(fixture.client, { dispatchTarget: "default", unclaimedTimeoutMs: 1 })).toBe(0);
    await runDelegatedTurnCycle({ outboxRepo: fixture.outboxRepo, workerId: "invalid-source", host: fixture.worker.conversation, concurrency: 2 });
    expect(fetch).not.toHaveBeenCalled();
    expect(await fixture.outboxRepo.getEventById(eventId)).toMatchObject({ status: "dead_letter", retryCount: 0 });
    expect(await fixture.repo.recoverExpiredAttempts(fixture.client, { dispatchTarget: "default", unclaimedTimeoutMs: 1 })).toBe(1);
    expect((await fixture.repo.getTurn(local, turnId))?.status).toBe("Interrupted");
    expect((await fixture.repo.listTurnAttempts(local, turnId))[0]).toMatchObject({ status: "Interrupted", fencingToken: 1 });
    expect(await fixture.repo.recoverExpiredAttempts(fixture.client, { dispatchTarget: "default", unclaimedTimeoutMs: 1 })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("isolates malformed raw Outbox payloads so a subsequent valid Turn still executes through the real host", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => completedResponse()); vi.stubGlobal("fetch", fetch);
    const bad = await fixture.accept("MALFORMED_FIRST_TASK");
    const good = await fixture.accept("VALID_NEXT_TASK");
    await fixture.client.execute({ sql: "UPDATE outbox_events SET payload = ? WHERE id = ?", args: ["{broken", `outbox_${bad}`] });
    await runDelegatedTurnCycle({ outboxRepo: fixture.outboxRepo, workerId: "malformed-isolation", host: fixture.worker.conversation, concurrency: 2 });
    const badEvent = await fixture.client.execute({ sql: "SELECT status, retry_count FROM outbox_events WHERE id = ?", args: [`outbox_${bad}`] });
    expect(badEvent.rows[0]).toMatchObject({ status: "dead_letter", retry_count: 0 });
    expect((await fixture.repo.getTurn(local, good))?.status).toBe("Completed");
    expect(await fixture.outboxRepo.getEventById(`outbox_${good}`)).toMatchObject({ status: "published", retryCount: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][1]?.body)).toContain("VALID_NEXT_TASK");
    expect((await fixture.repo.listTurnAttempts(local, bad))[0]).toMatchObject({ status: "Running", fencingToken: 0, leaseId: null });
  });

  it("aborts an active model and awaits its durable terminal state while leaving an unclaimed candidate pending", async () => {
    let modelSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      modelSignal = init.signal;
      modelSignal!.addEventListener("abort", () => reject(modelSignal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const active = await fixture.accept("ABORT_ACTIVE_TASK");
    const queued = await fixture.accept("ABORT_QUEUED_TASK");
    const work = runDelegatedTurnCycle({ outboxRepo: fixture.outboxRepo, workerId: "abort-test", host: fixture.worker.conversation, concurrency: 1 });
    void work.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(modelSignal).toBeDefined());
    } finally { fixture.worker.conversation.abort(); await work; }
    expect(modelSignal?.aborted).toBe(true);
    expect(["Completed", "Failed", "Interrupted", "Cancelled"]).toContain((await fixture.repo.listTurnAttempts(local, active))[0].status);
    expect(await fixture.outboxRepo.getEventById(`outbox_${active}`)).toMatchObject({ status: "published" });
    expect((await fixture.repo.listTurnAttempts(local, queued))[0]).toMatchObject({ status: "Running", fencingToken: 0, leaseId: null });
    expect(await fixture.outboxRepo.getEventById(`outbox_${queued}`)).toMatchObject({ status: "pending", retryCount: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
