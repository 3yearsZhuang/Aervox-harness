/**
 * Aervox｜思隅 @aervox/host-agent — SqliteExecutionStore 跑内核共享契约套件
 *
 * 与 `packages/core/test/execution-store-contract.test.ts`（内存实现）使用**同一份**
 * 用例，两侧通过即证明换 store 不换行为。套件由 `@aervox/core/test-contract` 以
 * 框架无关形式提供，此处的适配只负责种子数据与断言桥接。
 */
import { beforeEach, describe, it } from "vitest";
import { executionStoreContract } from "@aervox/core/test-contract";
import type { AttemptStatus } from "@aervox/core/ports";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { SqliteExecutionStore } from "../src/index.js";

const ctx: LocalContext = { workspaceId: "ws_contract", subjectUserId: "usr_contract" };

describe("SqliteExecutionStore 满足 ExecutionStorePort 共享契约", () => {
  let repo: SqliteConversationRepository;
  let store: SqliteExecutionStore;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    const db: AervoxDatabase = res.db;
    const client: Client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    store = new SqliteExecutionStore(repo, ctx);
  });

  for (const contractCase of executionStoreContract()) {
    it(contractCase.name, async () => {
      await contractCase.run(store, {
        assert: {
          equal(actual, expected, message) {
            if (actual !== expected) {
              throw new Error(`${message ?? "assertion failed"}: expected ${String(expected)}, got ${String(actual)}`);
            }
          },
          ok(value, message) {
            if (!value) throw new Error(message ?? "assertion failed: value is falsy");
          },
        },
        async seedAttempt({ turnId, attemptId, status }) {
          const sessionId = `ses_contract_${turnId}`;
          await repo.getOrCreateSession(ctx, sessionId, "contract");
          await repo.createTurnWithOutbox(
            ctx,
            { id: turnId, sessionId, idempotencyKey: `idem_${turnId}`, status: "Created" },
            { id: `msg_${turnId}`, content: "x" },
            {
              id: `ob_${turnId}`,
              eventType: "turn.created",
              idempotencyKey: `idem_ob_${turnId}`,
              payload: { turnId, sessionId },
            },
          );
          await repo.createTurnAttempt(ctx, turnId, { id: attemptId, attempt: 1 });
          // The port has no "seed as terminal" hook; a non-Running seed is only
          // used by cases asserting rejection, and those never claim.
          if (status && status !== "Running") {
            await repo.finalizeTurnAttempt(ctx, {
              turnId, attemptId, status, expectedFencingToken: 0,
            }).catch(() => null);
          }
        },
        async attemptStatus({ turnId, attemptId }) {
          const status = await repo.getTurnAttemptStatus(ctx, { turnId, attemptId });
          return (status ?? undefined) as AttemptStatus | undefined;
        },
      });
    });
  }
});
