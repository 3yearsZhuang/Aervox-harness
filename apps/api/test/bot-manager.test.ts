import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImmediate as nextTask } from "node:timers/promises";
import {
  createInMemoryDatabase, createProactiveVaultCipher, SqliteConversationRepository,
  botInbox, botDeliveries, type AervoxDatabase,
} from "@aervox/repositories";
import type { BotAdapterContext, BotAdapterContribution, BotMessage, BotSendReceipt } from "@aervox/host-plugin-api";
import { SqliteBotRepository } from "@aervox/repositories";
import { BotManager } from "@aervox/host-runtime/modules/ecosystem/bots/manager";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@aervox/host-runtime/modules/companion/conversation/index", () => ({
  recoverApiOwnedTurn: async (repo: SqliteConversationRepository, turnId: string) =>
    (await import("@aervox/host-runtime/modules/companion/conversation/api-owned-recovery")).recoverApiOwnedTurn(repo, turnId),
  acceptConversationTurn: (repo: SqliteConversationRepository, ctx: object, input: never) => repo.acceptTurn(ctx as never, input),
  executeAcceptedConversationTurn: execute,
}));
const local = { workspaceId: "local", subjectUserId: "local" };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const message = (id: string, senderId = "member", text = "hello"): BotMessage => ({
  id, accountId: "bot", senderId, text, mentions: ["bot"], receivedAt: new Date().toISOString(),
  address: { kind: "group", conversationId: "group", senderId },
});

describe("Bot manager transport durability and lifetime", () => {
  let db: AervoxDatabase;
  let cleanup: () => Promise<void>;
  let store: SqliteBotRepository;
  let conversations: SqliteConversationRepository;
  let manager: BotManager;
  let managers: BotManager[];
  let contexts: BotAdapterContext[];
  let receivers: Array<(message: BotMessage) => Promise<void>>;
  let sends: Array<{ text: string; address: unknown }>;
  let startGate: ReturnType<typeof deferred<void>> | undefined;
  let sendGate: ReturnType<typeof deferred<BotSendReceipt>> | undefined;
  let failStart: boolean;
  let enabled: boolean;
  let descriptor: BotAdapterContribution;

  beforeEach(async () => {
    ({ db, cleanup } = await createInMemoryDatabase());
    store = new SqliteBotRepository(db);
    conversations = new SqliteConversationRepository(db);
    managers = []; contexts = []; receivers = []; sends = []; startGate = undefined; sendGate = undefined; failStart = false; enabled = true;
    descriptor = {
      id: "fake", platform: "test", displayName: "Fake", capabilities: { directMessages: true, groupMessages: true, login: true, maxTextLength: 4 },
      create(context) {
        contexts.push(context);
        return {
          async start(receive) {
            receivers.push(receive);
            if (startGate) await Promise.race([startGate.promise, new Promise<void>((_, reject) => context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
            if (failStart) throw new Error("SECRET_START_FAILURE");
            await context.setState("connected", { accountId: "bot" });
          },
          async send(address, text) { sends.push({ address, text }); return sendGate ? sendGate.promise : { status: "accepted", messageId: String(sends.length) }; },
          async stop() {},
        };
      },
    };
    execute.mockReset();
    execute.mockImplementation(async (repo: SqliteConversationRepository, ctx, input) => {
      await repo.appendStreamEvent(ctx, { id: `reply_${input.turnId}`, turnId: input.turnId, attemptId: input.attemptId, sequence: 1,
        eventType: "delta", safetyDecision: "approved", data: { text: "abcdefgh", messageId: `reply_${input.turnId}` } });
      await repo.finalizeTurnAttempt(ctx, { turnId: input.turnId, attemptId: input.attemptId, status: "Completed" });
      await repo.updateTurnStatus(ctx, input.turnId, "Completed");
    });
    manager = makeManager();
  });
  afterEach(async () => {
    startGate?.resolve(); sendGate?.resolve({ status: "unknown" });
    await Promise.all(managers.map(current => current.close()));
    await cleanup();
  });
  function makeManager() {
    const current = new BotManager({ store, conversations, conversationDeps: {}, adapters: () => [{ pluginId: "test", adapter: descriptor }],
      pluginEnabled: async () => enabled, cipher: async () => createProactiveVaultCipher(new Uint8Array(32), "test") });
    managers.push(current);
    return current;
  }
  async function connection() {
    const row = await manager.create({ adapterId: "fake", displayName: "Test", enabled: true, config: { allowedGroupIds: ["group"] } });
    await manager.settle();
    return row;
  }
  async function drain(current = manager) { for (let round = 0; round < 4; round++) await current.settle(); }

  it.each(["cancel_requested", "terminal_gap", "expired_tool"])("recovers %s atomically and unblocks the following member request without replay", async (mode) => {
    const row = await connection();
    await receivers[0]!(message("crashed"));
    const item = (await store.listPending(row.id))[0]!;
    await conversations.acceptTurn(local, { turnId: "crashed-turn", sessionId: item.sessionId, idempotencyKey: `bot:${item.id}`,
      attemptId: "crashed-attempt", message: { id: "crashed-message", content: "hello" } });
    await store.updateInbox(item.id, { state: "processing", turnId: "crashed-turn" });
    await conversations.updateTurnStatus(local, "crashed-turn", "Running");
    const claim = await conversations.claimTurnAttempt(local, { turnId: "crashed-turn", attemptId: "crashed-attempt",
      expectedFencingToken: 0, leaseId: "dead-host", ttlMs: -1000 });
    if (mode === "cancel_requested") {
      await conversations.requestCancelTurnAttempt(local, { turnId: "crashed-turn", attemptId: "crashed-attempt" });
    } else if (mode === "terminal_gap") {
      await conversations.finalizeTurnAttempt(local, { turnId: "crashed-turn", attemptId: "crashed-attempt", status: "Completed", expectedFencingToken: claim.fencingToken });
    } else {
      await conversations.reserveToolExecution(local, { turnId: "crashed-turn", attemptId: "crashed-attempt", invocationId: "uncertain-write", name: "write" });
    }
    await receivers[0]!(message("followup"));
    await drain();
    await drain();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[2]?.turnId).not.toBe("crashed-turn");
    expect((await store.getInbox(item.id))?.state).toBe("done");
    const expected = mode === "terminal_gap" ? "Completed" : mode === "cancel_requested" ? "Cancelled" : "Interrupted";
    expect((await conversations.getTurn(local, "crashed-turn"))?.status).toBe(expected);
    const [attempt] = await conversations.listTurnAttempts(local, "crashed-turn");
    expect(attempt).toMatchObject({ status: expected, fencingToken: mode === "terminal_gap" ? claim.fencingToken : claim.fencingToken + 1 });
    expect((await conversations.getStreamEvents(local, "crashed-turn")).filter(event => event.eventType === "done")).toHaveLength(1);
    if (mode === "expired_tool") {
      expect((await conversations.listToolExecutionsByTurn(local, "crashed-turn"))[0]).toMatchObject({ status: "outcome_unknown", error: "recovery_outcome_unknown" });
      expect(await conversations.finalizeTurnAttempt(local, { turnId: "crashed-turn", attemptId: "crashed-attempt", status: "Completed", expectedFencingToken: claim.fencingToken })).toBeNull();
    }
  });

  it("does not hold management requests behind an adapter's network startup", async () => {
    startGate = deferred<void>();
    let returned = false;
    const creation = manager.create({ adapterId: "fake", displayName: "slow", enabled: true, config: {} }).then(row => { returned = true; return row; });
    await vi.waitFor(() => expect(receivers).toHaveLength(1));
    await nextTask();
    expect(returned).toBe(true);
    startGate.resolve();
    await creation;
  });

  it("persists a sanitized startup failure visible to management", async () => {
    failStart = true;
    const row = await manager.create({ adapterId: "fake", displayName: "broken", enabled: true, config: {} });
    await manager.settle();
    const [visible] = await manager.list();
    expect(visible).toMatchObject({ id: row.id, state: "error", lastError: "bot_adapter_start_failed" });
    expect(JSON.stringify(visible)).not.toContain("SECRET");
  });

  it("admits duplicate events once and serializes each member independently", async () => {
    const row = await connection();
    await Promise.all([receivers[0]!(message("one")), receivers[0]!(message("one"))]);
    await receivers[0]!(message("two", "other"));
    await receivers[0]!(message("three"));
    await drain();
    expect(execute).toHaveBeenCalledTimes(3);
    const inbox = await db.select().from(botInbox);
    expect(inbox).toHaveLength(3);
    expect(new Set(inbox.map(item => item.sessionId)).size).toBe(2);
    expect(inbox.every(item => item.state === "done")).toBe(true);
    expect((await store.getConnection(row.id))?.leaseOwner).toBeTruthy();
  });

  it("overlaps model waits across members while preserving each member's Turn order", async () => {
    const first = deferred<void>();
    const other = deferred<void>();
    const started: string[] = [];
    const complete = execute.getMockImplementation()!;
    execute.mockImplementation(async (...args) => {
      const content = args[2].userMessage;
      started.push(content);
      if (content === "first") await first.promise;
      if (content === "other") await other.promise;
      return complete(...args);
    });
    try {
      await connection();
      await receivers[0]!(message("one", "member", "first"));
      await receivers[0]!(message("two", "member", "second"));
      await receivers[0]!(message("three", "another", "other"));
      await manager.reconcile();
      await vi.waitFor(() => expect(started).toEqual(["first", "other"]));
      other.resolve();
      await vi.waitFor(async () => expect((await db.select().from(botInbox)).filter(item => item.state === "done")).toHaveLength(1));
      expect(started).toEqual(["first", "other"]);
      first.resolve();
      await drain();
      expect(started).toEqual(["first", "other", "second"]);
    } finally { first.resolve(); other.resolve(); }
  });

  it("only one host may activate a connection, and a disabled generation rejects late events", async () => {
    const row = await connection();
    const other = makeManager();
    await other.settle();
    expect(receivers).toHaveLength(1);
    await manager.update(row.id, { revision: (await store.getConnection(row.id))!.revision, enabled: false });
    await receivers[0]!(message("late"));
    await contexts[0]!.setState("connected", { accountId: "attacker" });
    expect(await db.select().from(botInbox)).toEqual([]);
    expect((await store.getConnection(row.id))?.state).toBe("stopped");
  });

  it("keeps an uncertain first segment and its later segments unsent after restart", async () => {
    const row = await connection();
    await receivers[0]!(message("one"));
    const item = (await store.listPending(row.id))[0]!;
    await store.updateInbox(item.id, { state: "responding" });
    await store.addDeliveries([
      { id: "part0", connectionId: row.id, inboxId: item.id, partIndex: 0, text: "first", status: "sending", createdAt: "2000" },
      { id: "part1", connectionId: row.id, inboxId: item.id, partIndex: 1, text: "second", status: "queued", createdAt: "2000" },
    ]);
    await manager.close();
    const restarted = makeManager();
    await drain(restarted);
    expect(sends).toEqual([]);
    expect((await store.deliveryParts(item.id)).map(part => part.status)).toEqual(["unknown", "queued"]);
    await restarted.retry(row.id, "part0");
    await drain(restarted);
    expect(sends.map(part => part.text)).toEqual(["first", "second"]);
  });

  it("requires an explicit pairing candidate and discards it on credential replacement", async () => {
    const row = await connection();
    const stranger = message("stranger", "stranger"); stranger.address.kind = "direct";
    await receivers[0]!(stranger);
    expect((await store.getConnection(row.id))?.ownerSenderId).toBeNull();
    const pairing = await manager.beginPairing(row.id);
    const candidate = message("candidate", "owner", pairing.code); candidate.address.kind = "direct";
    await receivers[0]!(candidate);
    expect((await manager.pairing(row.id)).candidateSenderId).toBe("owner");
    await manager.update(row.id, { revision: (await store.getConnection(row.id))!.revision, secretValues: { token: "new-secret" } });
    await drain();
    await expect(manager.confirmPairing(row.id, "owner")).rejects.toThrow("bot_pairing_invalid_or_expired");
  });

  it("account changes invalidate pending messages and pairing for the previous account", async () => {
    const row = await connection();
    await receivers[0]!(message("old"));
    const revision = (await store.getConnection(row.id))!.revision;
    await contexts[0]!.setState("connected", { accountId: "replacement" });
    expect((await store.getConnection(row.id))!.revision).toBeGreaterThan(revision);
    await contexts[0]!.setState("connected", { accountId: "bot" });
    await drain();
    expect(execute).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
  });

  it("close waits for in-flight work and never accepts a late receipt after stop", async () => {
    const row = await connection();
    sendGate = deferred<BotSendReceipt>();
    await receivers[0]!(message("one"));
    await manager.reconcile();
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await nextTask(); await nextTask();
    expect(closed).toBe(false);
    sendGate.resolve({ status: "accepted", messageId: "late" });
    await closing;
    const item = (await store.listPending(row.id))[0]!;
    expect((await store.deliveryParts(item.id))[0]?.status).toBe("unknown");
  });

  it("does not recreate reply copies after the underlying session is deleted", async () => {
    const row = await connection();
    await receivers[0]!(message("one"));
    const item = (await store.listPending(row.id))[0]!;
    await conversations.deleteSession(local, item.sessionId);
    await store.addDeliveries([{ id: "late", connectionId: row.id, inboxId: item.id, partIndex: 0, text: "DELETED_SECRET", createdAt: "2000" }]);
    await receivers[0]!(message("one"));
    await drain();
    expect(await db.select().from(botDeliveries)).toEqual([]);
    expect((await store.getInbox(item.id))?.state).toBe("deleted");
  });

  it("uses durable insertion order for same-millisecond messages", async () => {
    const row = await connection();
    const common = { connectionId: row.id, sessionId: "session", messageJson: "{}", connectionRevision: row.revision, createdAt: "2000" };
    await store.enqueue({ ...common, id: "z_first" });
    await store.enqueue({ ...common, id: "a_second" });
    expect((await store.listPending(row.id)).map(item => item.id)).toEqual(["z_first", "a_second"]);
  });

  it("reports token expiry without exposing retained account credentials", async () => {
    const row = await connection();
    await contexts[0]!.secrets.write({ token: "SECRET_TOKEN", accountId: "bot", contextToken: "SECRET_CONTEXT" });
    expect((await manager.list())[0]?.hasCredentials).toBe(true);
    await contexts[0]!.secrets.write({ accountId: "bot", contextToken: "SECRET_CONTEXT" });
    const visible = (await manager.list())[0];
    expect(visible?.hasCredentials).toBe(false);
    expect(JSON.stringify(visible)).not.toContain("SECRET");
    expect(visible?.id).toBe(row.id);
  });

  it("accepts just one pairing candidate and invalidates codes on enable changes", async () => {
    const row = await connection();
    const pairing = await manager.beginPairing(row.id);
    const candidate = (id: string) => ({ ...message(id, id, pairing.code), address: { kind: "direct" as const, conversationId: id, senderId: id } });
    await receivers[0]!(candidate("bot"));
    expect((await manager.pairing(row.id)).candidateSenderId).toBeUndefined();
    await Promise.all([receivers[0]!(candidate("alice")), receivers[0]!(candidate("bob"))]);
    const winner = (await manager.pairing(row.id)).candidateSenderId;
    expect(["alice", "bob"]).toContain(winner);
    await receivers[0]!(candidate(winner === "alice" ? "bob" : "alice"));
    expect((await manager.pairing(row.id)).candidateSenderId).toBe(winner);
    await manager.update(row.id, { revision: (await store.getConnection(row.id))!.revision, enabled: false });
    await manager.update(row.id, { revision: (await store.getConnection(row.id))!.revision, enabled: true });
    await manager.settle();
    await expect(manager.confirmPairing(row.id, winner!)).rejects.toThrow("bot_pairing_invalid_or_expired");
  });

  it("bounds admission atomically and rejects expired host generations", async () => {
    const row = await connection();
    const current = (await store.getConnection(row.id))!;
    const fence = { connectionId: row.id, revision: current.revision, owner: current.leaseOwner! };
    const common = { connectionId: row.id, sessionId: "bounded", messageJson: "{}", connectionRevision: current.revision, createdAt: "2000" };
    const admitted = await Promise.allSettled(Array.from({ length: 21 }, (_, index) => store.enqueue({ ...common, id: `bounded_${index}` }, fence)));
    expect(admitted.filter(result => result.status === "fulfilled")).toHaveLength(20);
    expect(admitted.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await store.enqueue({ ...common, id: "bounded_0" }, fence)).toBeNull();
    await store.updateConnection(row.id, current.revision, { enabled: false });
    expect(await store.enqueue({ ...common, id: "stale", sessionId: "elsewhere" }, fence)).toBeNull();
    expect(await store.updateInbox("bounded_0", { state: "done" }, fence)).toBeNull();
  });

  it("rejects unusable adapter segment limits and reports missing plugins", async () => {
    descriptor.capabilities.maxTextLength = 0;
    await expect(manager.create({ adapterId: "fake", displayName: "invalid" })).rejects.toThrow("bot_adapter_invalid_capabilities");
    descriptor.capabilities.maxTextLength = 4;
    enabled = false;
    const row = await manager.create({ adapterId: "fake", displayName: "unavailable", enabled: true });
    expect(row).toMatchObject({ enabled: true, state: "error", lastError: "bot_plugin_unavailable" });
    await manager.settle();
    expect((await manager.list())[0]?.revision).toBe(row.revision);
    expect(receivers).toEqual([]);
  });

  it("binds an explicitly confirmed owner and admits only that direct sender", async () => {
    const row = await connection();
    const pairing = await manager.beginPairing(row.id);
    const candidate = { ...message("pair", "owner", pairing.code), address: { kind: "direct" as const, conversationId: "owner", senderId: "owner" } };
    await receivers[0]!(candidate);
    await expect(manager.confirmPairing(row.id, "owner")).resolves.toEqual({ confirmed: true });
    await manager.settle();
    const receive = receivers.at(-1)!;
    await receive({ ...candidate, id: "owner-message", text: "hello" });
    await receive({ ...candidate, id: "stranger-message", senderId: "stranger", text: "hello", address: { ...candidate.address, senderId: "stranger" } });
    await drain();
    expect(execute).toHaveBeenCalledTimes(1);
    const item = (await db.select().from(botInbox))[0]!;
    expect((await conversations.getSession(local, item.sessionId))?.executionPolicy).toBe("bot-owner-v1");
    expect((await manager.pairing(row.id)).confirmed).toBe(true);
  });

  it("finishes an admitted cancel command after restart without a model turn", async () => {
    const row = await connection();
    await receivers[0]!(message("placeholder"));
    const item = (await store.listPending(row.id))[0]!;
    await store.updateInbox(item.id, { state: "responding", messageJson: JSON.stringify(message("cancel", "member", "/cancel")) });
    await manager.close();
    const restarted = makeManager();
    await drain(restarted);
    expect(execute).not.toHaveBeenCalled();
    expect((await store.getInbox(item.id))?.state).toBe("done");
    expect(sends.map(part => part.text).join("")).toBe("已请求取消本会话当前回合。");
  });

  it("admits cancellation when the member queue is full and suppresses every earlier input", async () => {
    const row = await connection();
    for (let index = 0; index < 20; index++) await receivers[0]!(message(`queued-${index}`));
    await expect(receivers[0]!(message("over-capacity"))).rejects.toThrow("bot_inbox_full");
    await receivers[0]!(message("cancel", "member", " /cancel "));
    await receivers[0]!(message("cancel", "member", " /cancel "));
    const rows = await db.select().from(botInbox);
    expect(rows).toHaveLength(21);
    expect(rows.filter(item => item.state === "cancelled")).toHaveLength(20);
    expect(await store.listPending(row.id)).toHaveLength(1);
    await drain();
    expect(execute).not.toHaveBeenCalled();
    expect(sends.map(part => part.text).join("")).toBe("已请求取消本会话当前回合。");
  });

  it("bounds pending control commands per member and connection while retaining duplicate tombstones", async () => {
    const row = await connection();
    const common = { connectionId: row.id, connectionRevision: row.revision, createdAt: "2000",
      messageJson: JSON.stringify(message("control", "member", "/cancel")), state: "queued" };
    await store.enqueue({ ...common, id: "control-0", sessionId: "member-0" }, undefined, true);
    await expect(store.enqueue({ ...common, id: "duplicate-member", sessionId: "member-0" }, undefined, true)).rejects.toThrow("bot_inbox_full");
    for (let index = 1; index < 100; index++) {
      await store.enqueue({ ...common, id: `control-${index}`, sessionId: `member-${index}` }, undefined, true);
    }
    await expect(store.enqueue({ ...common, id: "control-100", sessionId: "member-100" }, undefined, true)).rejects.toThrow("bot_inbox_full");
    expect(await store.enqueue({ ...common, id: "control-0", sessionId: "member-0" }, undefined, true)).toBeNull();
    expect(await store.listPendingControls(row.id)).toHaveLength(100);
  });

  it("recovers a durable cancellation before its predecessors and preserves later messages", async () => {
    const row = await connection();
    await receivers[0]!(message("before-one"));
    await receivers[0]!(message("before-two"));
    const predecessors = await store.listPending(row.id);
    await store.enqueue({ id: "crash-control", connectionId: row.id, connectionRevision: row.revision,
      sessionId: predecessors[0]!.sessionId, createdAt: "2000", state: "queued",
      messageJson: JSON.stringify(message("crash-control", "member", "/cancel")) }, undefined, true);
    await receivers[0]!(message("after-control", "member", "later request"));
    await manager.close();
    const restarted = makeManager();
    await drain(restarted);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ userMessage: "later request" });
    for (const item of predecessors) expect((await store.getInbox(item.id))?.state).toBe("cancelled");
    expect((await store.getInbox("crash-control"))?.state).toBe("done");
    expect(sends.map(part => part.text).join("")).toBe("已请求取消本会话当前回合。abcdefgh");
  });

  it("cancels a committed unclaimed Turn even before its inbox Turn link is persisted", async () => {
    const row = await connection();
    await receivers[0]!(message("accepted"));
    const item = (await store.listPending(row.id))[0]!;
    await conversations.acceptTurn(local, { turnId: "accepted-turn", sessionId: item.sessionId, idempotencyKey: `bot:${item.id}`,
      attemptId: "accepted-attempt", message: { id: "accepted-message", content: "hello" } });
    expect((await store.getInbox(item.id))?.turnId).toBeNull();
    await receivers[0]!(message("cancel", "member", "/cancel"));
    expect((await conversations.getTurn(local, "accepted-turn"))?.status).toBe("Cancelled");
    expect((await conversations.listTurnAttempts(local, "accepted-turn"))[0]?.status).toBe("Cancelled");
    expect(await store.updateInbox(item.id, { state: "processing", turnId: "accepted-turn" })).toBeNull();
    await drain();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps a cancelled in-flight receipt unknown and prevents later segments or manual retries", async () => {
    const row = await connection();
    await receivers[0]!(message("responding"));
    const item = (await store.listPending(row.id))[0]!;
    await store.updateInbox(item.id, { state: "responding" });
    await store.addDeliveries([
      { id: "cancel-first", connectionId: row.id, inboxId: item.id, partIndex: 0, text: "old-first", status: "sending", createdAt: "2000" },
      { id: "cancel-second", connectionId: row.id, inboxId: item.id, partIndex: 1, text: "old-second", status: "queued", createdAt: "2000" },
    ]);
    await receivers[0]!(message("cancel", "member", "/cancel"));
    expect((await store.deliveryParts(item.id)).map(part => part.status)).toEqual(["unknown", "failed"]);
    expect(await store.updateDelivery("cancel-first", { status: "accepted", platformMessageId: "late" }, "sending")).toBeNull();
    await expect(manager.retry(row.id, "cancel-first")).rejects.toThrow("bot_binding_changed");
    await drain();
    expect(sends.map(part => part.text).join("")).toBe("已请求取消本会话当前回合。");
  });

  it("revokes the current revision even when a concurrent configuration update follows its snapshot", async () => {
    const row = await connection();
    await contexts[0]!.secrets.write({ token: "SECRET" });
    const list = store.listConnections.bind(store);
    vi.spyOn(store, "listConnections").mockImplementationOnce(async () => {
      const snapshot = await list();
      await store.updateConnection(row.id, snapshot[0]!.revision, { enabled: true, displayName: "Concurrent update" });
      return snapshot;
    });
    await manager.stopPlugin("test", true);
    expect(await store.getConnection(row.id)).toMatchObject({ enabled: false, revision: row.revision + 2, secretCipher: null,
      checkpointCipher: null, ownerSenderId: null });
    await receivers[0]!(message("revoked"));
    await drain();
    expect(await db.select().from(botInbox)).toEqual([]);
    expect(receivers).toHaveLength(1);
  });

  it("deletes activation durably before transport shutdown and cancels accepted work", async () => {
    const create = descriptor.create;
    let staleUpdate: unknown;
    descriptor.create = context => {
      const instance = create(context);
      return { ...instance, stop: async () => {
        staleUpdate = await store.updateConnection(context.connectionId, 0, { enabled: true });
      } };
    };
    const row = await connection();
    await receivers[0]!(message("accepted"));
    const item = (await store.listPending(row.id))[0]!;
    await conversations.acceptTurn(local, { turnId: "removed-turn", sessionId: item.sessionId, idempotencyKey: `bot:${item.id}`,
      attemptId: "removed-attempt", message: { id: "removed-message", content: "hello" } });
    await manager.remove(row.id);
    expect(staleUpdate).toBeNull();
    expect(await store.getConnection(row.id)).toBeNull();
    expect((await conversations.getTurn(local, "removed-turn"))?.status).toBe("Cancelled");
    expect((await conversations.listTurnAttempts(local, "removed-turn"))[0]?.status).toBe("Cancelled");
    await receivers[0]!(message("late"));
    expect(await db.select().from(botInbox)).toEqual([]);
  });
});
