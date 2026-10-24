import { loadExecutionConfig } from "@aervox/config";
import { createConversationApplication } from "@aervox/host-runtime-test/modules/companion/conversation/application";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { createReplayProvider } from "@aervox/core";
import {
  createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, SqliteOutboxRepository, SqlitePlatformRepository,
  type AervoxDatabase, type ConversationExecutionPolicy,
} from "@aervox/repositories";
import { createTurnConsumerHandler } from "../src/turn-consumer.js";
import { runOutboxCycle } from "../src/outbox-worker.js";
import { runAttemptRecoveryCycle } from "../src/attempt-recovery.js";

const local = { workspaceId: "local", subjectUserId: "local" };

describe("Bot turns remain owned by the API across Worker cycles", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;
  let application: ReturnType<typeof createConversationApplication>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, client, cleanup } = await createInMemoryDatabase());
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    application = createConversationApplication(repo, { executionConfig: loadExecutionConfig() }, undefined, { client });
  });
  afterEach(async () => { await application.close(); await cleanup(); });

  async function accept(policy: ConversationExecutionPolicy) {
    await repo.createSession(local, policy, { id: policy, executionPolicy: policy });
    return repo.acceptTurn(local, {
      turnId: `turn_${policy}`, sessionId: policy, idempotencyKey: policy,
      execution: "worker",
      attemptId: `attempt_${policy}`, message: { id: `message_${policy}`, content: policy }, consumeInbox: false,
    });
  }

  it("skips Bot Outbox events without reading personal memory, constructing a provider, or calling tools", async () => {
    await accept("bot-owner-v1");
    await accept("bot-group-member-v1");
    const provider = vi.fn(async () => createReplayProvider([{ type: "text", delta: "PRIVATE_MODEL_SECRET" }]));
    const recall = vi.fn();
    const handler = createTurnConsumerHandler(createConversationApplication(repo, {executionConfig: loadExecutionConfig()}, async () => { await provider(); await recall(); }));
    expect(await runOutboxCycle({
      outboxRepo: new SqliteOutboxRepository(db), platformRepo: new SqlitePlatformRepository(db), workerId: "bot-ownership-test",
      handlers: { "agent.turn.requested": handler },
    })).toBe(2);
    expect(provider).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
    for (const policy of ["bot-owner-v1", "bot-group-member-v1"]) {
      expect((await repo.getTurn(local, `turn_${policy}`))?.status).toBe("Created");
      expect(await repo.getStreamEvents(local, `turn_${policy}`)).toEqual([]);
      expect((await repo.listTurnAttempts(local, `turn_${policy}`))[0]?.status).toBe("Running");
    }
  });

  it("never resumes or interrupts API-owned attempts, including those with committed tool results", async () => {
    for (const policy of ["bot-owner-v1", "bot-group-member-v1"] as const) {
      await accept(policy);
      await repo.reserveToolExecution(local, {
        turnId: `turn_${policy}`, attemptId: `attempt_${policy}`, invocationId: `inv_${policy}`, name: "private_tool", arguments: {},
      });
      await repo.updateToolExecutionResult(local, {
        turnId: `turn_${policy}`, attemptId: `attempt_${policy}`, invocationId: `inv_${policy}`, status: "executed", output: "PRIVATE_TOOL_SECRET",
      });
    }
    await client.execute("UPDATE turn_attempts SET lease_expires_at = '2000-01-01T00:00:00.000Z', started_at = '2000-01-01T00:00:00.000Z'");
    expect(await repo.findResumeCandidates(client)).toEqual([]);
    expect(await runAttemptRecoveryCycle({ commands: application.commands, workerId: "bot-recovery-test" })).toBe(0);
    for (const policy of ["bot-owner-v1", "bot-group-member-v1"] as const) {
      expect((await repo.getTurn(local, `turn_${policy}`))?.executionPolicy).toBe(policy);
      expect((await repo.listTurnAttempts(local, `turn_${policy}`))[0]).toMatchObject({ status: "Running", fencingToken: 0 });
      expect(await repo.getStreamEvents(local, `turn_${policy}`)).toEqual([]);
    }
  });

  it("leaves orphan Bot turns for the API while recovering local orphans", async () => {
    for (const policy of ["bot-group-member-v1", "local-v1"] as const) {
      await repo.createSession(local, policy, { id: policy, executionPolicy: policy });
      await repo.createTurnWithOutbox(local, { id: policy, sessionId: policy, idempotencyKey: policy }, { id: `message_${policy}`, content: policy });
    }
    await client.execute("UPDATE turns SET created_at = '2000-01-01T00:00:00.000Z'");
    await runAttemptRecoveryCycle({ commands: application.commands, workerId: "bot-orphan-test" });
    expect((await repo.getTurn(local, "bot-group-member-v1"))?.status).toBe("Created");
    expect((await repo.getTurn(local, "local-v1"))?.status).toBe("Interrupted");
  });

  it("does not clean terminal API or Bot reservations when a local expired Attempt triggers recovery", async () => {
    async function pending(id: string, policy: ConversationExecutionPolicy, execution: "api" | "worker", status: "Running" | "Interrupted" | "Failed" | "Cancelled") {
      await repo.createSession(local, id, { id, executionPolicy: policy });
      await repo.acceptTurn(local, { turnId: id, sessionId: id, idempotencyKey: id,
        attemptId: `attempt_${id}`, execution, message: { id: `message_${id}`, content: id }, consumeInbox: false });
      await repo.reserveToolExecution(local, { turnId: id, attemptId: `attempt_${id}`, invocationId: `inv_${id}`, name: "notes_search", arguments: {} });
      // Local inline execution is still a default-owned Turn. Explicitly seed
      // this legacy/mismatched api owner rather than confusing Outbox intent
      // with the durable dispatch_target used by recovery.
      if (policy === "local-v1" && execution === "api") {
        await client.execute({ sql: "UPDATE turns SET dispatch_target = 'api' WHERE id = ?", args: [id] });
      }
      await client.execute({ sql: "UPDATE turn_attempts SET status = ?, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", args: [status, `attempt_${id}`] });
    }
    await pending("expired-local", "local-v1", "worker", "Running");
    await pending("terminal-local", "local-v1", "worker", "Interrupted");
    await pending("terminal-api", "local-v1", "api", "Failed");
    await pending("terminal-bot-owner", "bot-owner-v1", "api", "Cancelled");
    await pending("terminal-bot-group", "bot-group-member-v1", "api", "Interrupted");
    // Legacy writers can associate an invocation with inconsistent Turn and
    // Attempt identities. Neither recovery phase may claim that foreign row.
    await repo.reserveToolExecution(local, { turnId: "terminal-bot-owner", attemptId: "attempt_expired-local",
      invocationId: "mismatched-owner", name: "notes_search", arguments: {} });
    const excluded = ["terminal-api", "terminal-bot-owner", "terminal-bot-group"];
    const snapshots = await Promise.all(excluded.map(async id => ({
      attempts: await repo.listTurnAttempts(local, id), tools: await repo.listToolExecutionsByTurn(local, id),
      events: await repo.getStreamEvents(local, id),
    })));
    expect(await runAttemptRecoveryCycle({ commands: application.commands, workerId: "mixed-owner-recovery" })).toBe(1);
    for (let i = 0; i < excluded.length; i++) {
      const id = excluded[i];
      expect({ attempts: await repo.listTurnAttempts(local, id), tools: await repo.listToolExecutionsByTurn(local, id),
        events: await repo.getStreamEvents(local, id) }).toEqual(snapshots[i]);
    }
    for (const id of ["expired-local", "terminal-local"]) {
      expect((await repo.listToolExecutionsByTurn(local, id))[0].status).toBe("outcome_unknown");
    }
    expect((await repo.listTurnAttempts(local, "expired-local"))[0]).toMatchObject({ status: "Interrupted", fencingToken: 1 });
    expect((await repo.getStreamEvents(local, "expired-local")).filter(event => event.eventType === "done")).toHaveLength(1);
  });
});
