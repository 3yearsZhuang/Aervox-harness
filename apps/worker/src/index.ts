/**
 * Aervox｜思隅 @aervox/worker — 后台任务入口
 *
 * 当前：Outbox 消费 / 复习到期提醒 / 日记生成 / 删除传播 / 压缩标记异步落库 / 记忆向量迁移。
 * 按 WORKER_TICK_MS 轮询。规则依据：docs/reference/DATABASE.md §14 + ADR-004 + ADR-011。
 */
import {
  createDatabase,
  initDatabaseSchema,
  SqliteOutboxRepository,
  SqlitePlatformRepository,
  SqliteDiaryRepository,
  SqlitePrivacyRepository,
  SqliteLearningRepository,
  SqliteMemoryCompactionRepository,
  SqliteMemoryEmbeddingRepository,
} from "@aervox/database";
import { runOutboxCycle } from "./outbox-worker.js";
import { runReviewNotificationCycle } from "./review-notifier.js";
import { runDiaryGenerationCycle } from "./diary-generator.js";
import { runDeletionCycle } from "./deletion-worker.js";
import { runCompactionMarkerCycle } from "./compaction-marker.js";
import { runEmbeddingMigrationCycle } from "./embedding-migration.js";

const { db, client } = await createDatabase();
await initDatabaseSchema(client);

const workerId = process.env.WORKER_ID ?? `worker_${Date.now().toString(36)}`;
const tickMs = Number(process.env.WORKER_TICK_MS ?? 5000);

const outboxRepo = new SqliteOutboxRepository(db);
const platformRepo = new SqlitePlatformRepository(db);
const diaryRepo = new SqliteDiaryRepository(db);
const privacyRepo = new SqlitePrivacyRepository(db);
const learningRepo = new SqliteLearningRepository(db);
const compactionRepo = new SqliteMemoryCompactionRepository(db);
const embeddingRepo = new SqliteMemoryEmbeddingRepository(db);

const runTick = async (): Promise<void> => {
  const outbox = await runOutboxCycle({ outboxRepo, platformRepo, workerId });
  const review = await runReviewNotificationCycle({ db, platformRepo, learningRepo, workerId });
  const diary = await runDiaryGenerationCycle({ db, diaryRepo, platformRepo, outboxRepo, workerId });
  const deletion = await runDeletionCycle({ db, privacyRepo, platformRepo, workerId });
  const compaction = await runCompactionMarkerCycle({ outboxRepo, compactionRepo, workerId });
  const embeddingMigration = await runEmbeddingMigrationCycle({
    db,
    client,
    embeddingRepo,
    workerId,
    // embedding provider 未注入：生产接入真实服务后在此传入即可（当前诚实跳过）
  });
  if (outbox + review + diary + deletion + compaction + embeddingMigration > 0) {
    console.log(
      `[worker:${workerId}] outbox=${outbox} review_notified=${review} diary=${diary} deletion=${deletion} ` +
        `compaction_markers=${compaction} embedding_migrated=${embeddingMigration}`,
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