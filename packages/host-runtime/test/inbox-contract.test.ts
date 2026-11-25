/**
 * Aervox｜思隅 @aervox/host-runtime — SqliteAgentInboxRepository 跑内核 InboxPort 契约套件
 *
 * 与 `packages/core/test/inbox-contract.test.ts`（内存实现）使用**同一份**用例，
 * 两侧通过即证明换实现不换 claim/ack 语义。
 */
import { beforeEach, describe, it } from "vitest";
import { inboxContract } from "@aervox/core/test-contract";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteAgentInboxRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { createTenantInboxPort } from "../src/modules/companion/inbox/port.js";

const ctx: LocalContext = { workspaceId: "ws_inbox", subjectUserId: "usr_inbox" };

describe("SqliteAgentInboxRepository 满足 InboxPort 共享契约", () => {
  let repo: SqliteAgentInboxRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    const db: AervoxDatabase = res.db;
    const client: Client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteAgentInboxRepository(db);
  });

  for (const contractCase of inboxContract()) {
    it(contractCase.name, async () => {
      await contractCase.run(createTenantInboxPort(repo, ctx), {
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
      });
    });
  }
});
