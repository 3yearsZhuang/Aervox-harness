/**
 * Aervox｜思隅 @aervox/worker — 后台任务入口
 *
 * 规则依据：docs/reference/DATABASE.md §14 + ADR-004 + ADR-011。
 *
 * 调度模型（缺陷4修正）：每类任务独立节拍器（interval），互不阻塞：
 * - 独立频率：每任务可用 WORKER_INTERVAL_<NAME>_MS 覆盖，缺省回退 WORKER_TICK_MS（默认 5000ms）；
 * - 不重叠：上一轮未结束则跳过本轮（防任务自重叠/堆积），而非排队串行；
 * - 隔离失败：单任务抛错只记录自身日志，不拖垮其它任务与后续轮次。
 */
import { createDatabase,
  initDatabaseSchema,
  SqliteAgentInboxRepository,
  SqliteOutboxRepository,
  SqlitePlatformRepository,
  SqliteDiaryRepository,
  SqliteLLMConfigRepository,
  SqlitePrivacyRepository,
  SqliteLearningRepository,
  SqliteMemoryCompactionRepository,
  SqliteMemoryEmbeddingRepository,
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveProfileRepository,
  createProactiveVaultDatabase,
  loadProactiveVaultCipher,
} from "@aervox/database";
import { loadWorkerConfig } from "@aervox/config";
import { runOutboxCycle } from "./outbox-worker.js";
import { runReviewNotificationCycle } from "./review-notifier.js";
import { runDiaryGenerationCycle } from "./diary-generator.js";
import { runDeletionCycle } from "./deletion-worker.js";
import { runCompactionMarkerCycle } from "./compaction-marker.js";
import { runEmbeddingMigrationCycle } from "./embedding-migration.js";
import { runAttemptRecoveryCycle } from "./attempt-recovery.js";
import { runInboxExpiryCycle } from "./inbox-expiry.js";
import { createRuleBasedProactiveDistiller } from "./proactive-distiller.js";
import { runProactiveProfileCycle } from "./proactive-profile-worker.js";
import { runProactiveIntelligenceCycle } from "./proactive-intelligence-worker.js";

// 缺陷 E：集中类型化配置（WORKER_ID / WORKER_TICK_MS / WORKER_INTERVAL_<NAME>_MS；启动期校验）
const config = loadWorkerConfig();

const { db, client } = await createDatabase();
await initDatabaseSchema(client);
const { db: proactiveDb, client: proactiveClient } = await createProactiveVaultDatabase();
await initDatabaseSchema(proactiveClient);
const proactiveCipher = await loadProactiveVaultCipher();

const workerId = config.workerId;
const defaultTickMs = config.tickMs;

const outboxRepo = new SqliteOutboxRepository(db);
const platformRepo = new SqlitePlatformRepository(db);
const diaryRepo = new SqliteDiaryRepository(db);
const llmConfigRepo = new SqliteLLMConfigRepository(db);
const privacyRepo = new SqlitePrivacyRepository(db);
const learningRepo = new SqliteLearningRepository(db);
const compactionRepo = new SqliteMemoryCompactionRepository(db);
const embeddingRepo = new SqliteMemoryEmbeddingRepository(db);
const inboxRepo = new SqliteAgentInboxRepository(db);
const proactiveRepo = new SqliteProactiveProfileRepository(proactiveDb, proactiveCipher);
const proactiveIntelligenceRepo = new SqliteProactiveIntelligenceRepository(proactiveDb, proactiveCipher);
const proactiveDistiller = createRuleBasedProactiveDistiller();

/** 每任务独立调频：WORKER_INTERVAL_<NAME>_MS 覆盖（由 @aervox/config 解析），缺省 WORKER_TICK_MS */
function taskInterval(name: string): number {
  return config.intervalOverrides[name] ?? defaultTickMs;
}

interface WorkerTask {
  name: string;
  intervalMs: number;
  run(): Promise<number>;
}

const tasks: WorkerTask[] = [
  {
    name: "outbox",
    intervalMs: taskInterval("outbox"),
    run: () => runOutboxCycle({ outboxRepo, platformRepo, workerId }),
  },
  {
    name: "review",
    intervalMs: taskInterval("review"),
    run: () => runReviewNotificationCycle({ db, platformRepo, learningRepo, workerId }),
  },
  {
    name: "diary",
    intervalMs: taskInterval("diary"),
    run: () => runDiaryGenerationCycle({ db, diaryRepo, llmConfigRepo, platformRepo, outboxRepo, workerId }),
  },
  {
    name: "deletion",
    intervalMs: taskInterval("deletion"),
    run: () => runDeletionCycle({ db, privacyRepo, platformRepo, workerId }),
  },
  {
    name: "compaction",
    intervalMs: taskInterval("compaction"),
    run: () => runCompactionMarkerCycle({ outboxRepo, compactionRepo, workerId }),
  },
  {
    name: "embedding",
    intervalMs: taskInterval("embedding"),
    run: () => runEmbeddingMigrationCycle({ db, client, embeddingRepo, workerId }),
  },
  {
    name: "attempt-recovery",
    intervalMs: taskInterval("attempt-recovery"),
    run: () => runAttemptRecoveryCycle({ db, client, workerId }),
  },
  {
    name: "inbox-expiry",
    intervalMs: taskInterval("inbox-expiry"),
    run: () => runInboxExpiryCycle({ inboxRepo }),
  },
  {
    name: "proactive-profile",
    intervalMs: taskInterval("proactive-profile"),
    run: async () => {
      const result = await runProactiveProfileCycle({
        db: proactiveDb,
        repo: proactiveRepo,
        distiller: proactiveDistiller,
        workerId,
      });
      if (result.failed > 0) {
        console.warn(`[worker:${workerId}] proactive-profile failed=${result.failed}`);
      }
      return result.distilled + result.purged;
    },
  },
  {
    name: "proactive-intelligence",
    intervalMs: taskInterval("proactive-intelligence"),
    run: async () => {
      const result = await runProactiveIntelligenceCycle({
        db: proactiveDb,
        profileRepo: proactiveRepo,
        intelligenceRepo: proactiveIntelligenceRepo,
        platformRepo,
        workerId,
      });
      return result.timeline + result.projects + result.workflows + result.triggers +
        result.verifications + result.conflicts + result.preparations + result.attention +
        result.drift + result.relationships + result.scenes + result.reviews;
    },
  },
];

// 每任务独立节拍器：首次立即执行一次，随后按各自 interval 轮询；
// 运行中跳过（不重叠）、单任务异常隔离。
for (const task of tasks) {
  let running = false;
  const runOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const processed = await task.run();
      if (processed > 0) {
        console.log(`[worker:${workerId}] ${task.name}=${processed}`);
      }
    } catch (err) {
      console.error(`[worker:${workerId}] ${task.name} tick failed:`, err);
    } finally {
      running = false;
    }
  };
  void runOnce();
  setInterval(() => {
    void runOnce();
  }, task.intervalMs);
}
