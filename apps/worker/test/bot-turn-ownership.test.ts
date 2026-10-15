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
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, client, cleanup } = await createInMemoryDatabase());
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
  });
  afterEach(() => cleanup());

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
    const handler = createTurnConsumerHandler({ repo, execute: async () => { await provider(); await recall(); } });
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
    expect(await runAttemptRecoveryCycle({ db, client, workerId: "bot-recovery-test" })).toBe(0);
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
    await runAttemptRecoveryCycle({ db, client, workerId: "bot-orphan-test" });
    expect((await repo.getTurn(local, "bot-group-member-v1"))?.status).toBe("Created");
    expect((await repo.getTurn(local, "local-v1"))?.status).toBe("Interrupted");
  });
});
