/**
 * Aervox｜思隅 @aervox/worker — 后台任务入口
 *
 * 当前：Outbox 消费 / 复习到期提醒 / 日记生成 / 删除传播。按 WORKER_TICK_MS 轮询。
 * 规则依据：docs/contracts/DATABASE.md §14 + ADR-004 + ADR-011。
 */
import {
  createDatabase,
  initDatabaseSchema,
  SqliteOutboxRepository,
  SqlitePlatformRepository,
  SqliteDiaryRepository,
  SqlitePrivacyRepository,
} from "@aervox/database";
import { runOutboxCycle } from "./outbox-worker.js";
import { runReviewNotificationCycle } from "./review-notifier.js";
import { runDiaryGenerationCycle } from "./diary-generator.js";
import { runDeletionCycle } from "./deletion-worker.js";

const { db, client } = await createDatabase();
await initDatabaseSchema(client);

const workerId = process.env.WORKER_ID ?? `worker_${Date.now().toString(36)}`;
const tickMs = Number(process.env.WORKER_TICK_MS ?? 5000);

const outboxRepo = new SqliteOutboxRepository(db);
const platformRepo = new SqlitePlatformRepository(db);
const diaryRepo = new SqliteDiaryRepository(db);
const privacyRepo = new SqlitePrivacyRepository(db);

const runTick = async (): Promise<void> => {
  const outbox = await runOutboxCycle({ outboxRepo, platformRepo, workerId });
  const review = await runReviewNotificationCycle({ db, platformRepo, workerId });
  const diary = await runDiaryGenerationCycle({ db, diaryRepo, platformRepo, outboxRepo, workerId });
  const deletion = await runDeletionCycle({ db, privacyRepo, platformRepo, workerId });
  if (outbox + review + diary + deletion > 0) {
    console.log(
      `[worker:${workerId}] outbox=${outbox} review_notified=${review} diary=${diary} deletion=${deletion}`,
    );
  }
};

const loop = async (): Promise<void> => {
  try {
    await runTick();
  } catch (err) {
    console.error(`[worker:${workerId}] tick failed:`, err);
  }
};

// 首次立即执行，随后按间隔轮询
await loop();
setInterval(() => {
  void loop();
}, tickMs);
