/**
 * B1 回归：`createTurnWithOutbox` 不得在 `client.transaction()` 之外重试事务 BEGIN。
 *
 * 背景（评审阻断项 B1）：
 * - `write-retry.ts` 的边界说明要求 BEGIN 阶段的 SQLITE_BUSY **直接抛出**，因为 libsql@0.4.7
 *   在 BEGIN 竞争失败后会残留语句状态，重试会破坏后续 commit（见 write-retry.test.ts 的
 *   「事务 BEGIN 被写锁占用时直接打回 SQLITE_BUSY」用例）；
 * - 本 PR 曾在 `createTurnWithOutbox` 外层再包一层 `runWithBusyRetry`，等于重新引入被禁止的
 *   BEGIN 重试：每次尝试都会耗尽 `busy_timeout`，把同步 POST /v1/sessions/:id/turns 路径的
 *   最坏等待放大数倍（实测 ~57s），并把连接终态错误误判为可重试的写锁竞争。
 *
 * 本用例把 `busy_timeout` 设为 0，使单次尝试立即返回 SQLITE_BUSY：旧实现会用 9 次退避
 * （50/100/200/400/800/1000×4 ≈ 5.5s）才失败，修复后应在首次失败时立即抛出。
 *
 * 注意：libsql@0.4.7 上 BEGIN 竞争失败后该连接会进入「无法提交后续事务」的状态，这是 T-01
 * 重试层已有的上游限制（本 PR 不再对它做级联重试，从而不再放大停顿），恢复手段是重建连接，
 * 不在本用例的断言范围内。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  createDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type LocalContext,
} from "../src/index.js";

const ctx: LocalContext = { workspaceId: "ws_begin_contention", subjectUserId: "usr_begin_contention" };

describe("B1 事务 BEGIN 竞争：createTurnWithOutbox 立即失败而非级联重试", () => {
  let dbFile: string;
  let writer: { db: AervoxDatabase; client: Client };
  let owner: Client;

  beforeEach(async () => {
    dbFile = path.join(
      os.tmpdir(),
      `aervox_begin_contention_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`,
    );
    writer = await createDatabase({ url: `file:${dbFile}`, busyTimeoutMs: 0 });
    await initDatabaseSchema(writer.client);
    owner = createClient({ url: `file:${dbFile}` });
    await owner.execute("PRAGMA busy_timeout = 0");
  });

  afterEach(() => {
    try {
      writer.client.close();
    } catch {
      // 忽略
    }
    try {
      owner.close();
    } catch {
      // 忽略
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (fs.existsSync(dbFile + suffix)) fs.unlinkSync(dbFile + suffix);
      } catch {
        // 忽略
      }
    }
  });

  it("写锁被占用时在首次尝试内抛出 SQLITE_BUSY，不做退避重试", async () => {
    const repo = new SqliteConversationRepository(writer.db);
    await repo.getOrCreateSession(ctx, "ses_begin_contention", "BEGIN 竞争");

    // 另一连接持有写锁
    await owner.execute("BEGIN IMMEDIATE");

    const startedAt = Date.now();
    await expect(
      repo.createTurnWithOutbox(
        ctx,
        {
          id: "turn_begin_contention",
          sessionId: "ses_begin_contention",
          idempotencyKey: "idem_begin_contention",
        },
        { id: "msg_begin_contention", content: "hello" },
        {
          id: "ob_begin_contention",
          eventType: "turn.created",
          idempotencyKey: "idem_ob_begin_contention",
          payload: { turnId: "turn_begin_contention" },
        },
      ),
    ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    const elapsedMs = Date.now() - startedAt;

    await owner.execute("ROLLBACK");

    // 旧实现外层 runWithBusyRetry（attempts=10）的退避合计约 5.5s，此处必然超出。
    expect(elapsedMs).toBeLessThan(1_500);
  }, 30_000);

  it("被禁止的 BEGIN 重试不会写入任何部分数据（事务原子性）", async () => {
    const repo = new SqliteConversationRepository(writer.db);
    await repo.getOrCreateSession(ctx, "ses_begin_atomic", "BEGIN 原子性");

    await owner.execute("BEGIN IMMEDIATE");
    await expect(
      repo.createTurnWithOutbox(
        ctx,
        {
          id: "turn_begin_atomic",
          sessionId: "ses_begin_atomic",
          idempotencyKey: "idem_begin_atomic",
        },
        { id: "msg_begin_atomic", content: "must not persist" },
      ),
    ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    await owner.execute("ROLLBACK");

    const rows = await owner.execute(
      "SELECT COUNT(*) AS c FROM turns WHERE id = 'turn_begin_atomic'",
    );
    expect(Number(rows.rows[0]!.c)).toBe(0);
    const messages = await owner.execute(
      "SELECT COUNT(*) AS c FROM message_versions WHERE turn_id = 'turn_begin_atomic'",
    );
    expect(Number(messages.rows[0]!.c)).toBe(0);
  }, 30_000);
});
