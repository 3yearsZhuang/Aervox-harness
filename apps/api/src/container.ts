/**
 * Aervox｜思隅 @aervox/api — 仓储容器
 *
 * 集中实例化所有 SQLite 仓储，路由通过容器解耦具体仓储实现（可替换为 PG 适配器）。
 */
import {
  SqliteConversationRepository,
  SqliteLearningRepository,
  SqliteFeedbackRepository,
  SqliteDiaryRepository,
  SqlitePlatformRepository,
  SqlitePrivacyRepository,
  SqliteAnalyticsRepository,
  SqliteContentRepository,
  SqliteProvenanceRepository,
  type AervoxDatabase,
} from "@aervox/database";

export interface RepoContainer {
  conversation: SqliteConversationRepository;
  learning: SqliteLearningRepository;
  feedback: SqliteFeedbackRepository;
  diary: SqliteDiaryRepository;
  platform: SqlitePlatformRepository;
  privacy: SqlitePrivacyRepository;
  analytics: SqliteAnalyticsRepository;
  content: SqliteContentRepository;
  provenance: SqliteProvenanceRepository;
}

/** 组装仓储容器 */
export function buildContainer(db: AervoxDatabase): RepoContainer {
  return {
    conversation: new SqliteConversationRepository(db),
    learning: new SqliteLearningRepository(db),
    feedback: new SqliteFeedbackRepository(db),
    diary: new SqliteDiaryRepository(db),
    platform: new SqlitePlatformRepository(db),
    privacy: new SqlitePrivacyRepository(db),
    analytics: new SqliteAnalyticsRepository(db),
    content: new SqliteContentRepository(db),
    provenance: new SqliteProvenanceRepository(db),
  };
}
