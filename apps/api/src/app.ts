/**
 * Aervox｜思隅 @aervox/api — Fastify 应用工厂
 *
 * 允许注入内存/临时数据库用于集成测试；不负责 listen（由入口或测试调用方控制）。
 */
import Fastify from "fastify";
import { openApiDocument } from "@aervox/contracts";
import {
  createDatabase,
  initDatabaseSchema,
  type AervoxDatabase,
} from "@aervox/database";
import type { Client } from "@libsql/client";
import { buildContainer } from "./container.js";
import { registerConversationRoutes } from "./routes/conversation.js";
import { registerLearningRoutes } from "./routes/learning.js";
import { registerFeedbackRoutes } from "./routes/feedback.js";
import { registerDiaryRoutes } from "./routes/diary.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerNotificationRoutes } from "./routes/notification.js";
import { registerPrivacyRoutes } from "./routes/privacy.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";

export interface BuildAppOptions {
  /** 注入既有数据库（如内存库）；缺省时使用 createDatabase() */
  db?: AervoxDatabase;
  client?: Client;
}

export interface BuildAppResult {
  app: ReturnType<typeof Fastify>;
  db: AervoxDatabase;
  client: Client;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuildAppResult> {
  const app = Fastify({ logger: false });
  const { db, client } =
    options.db && options.client ? { db: options.db, client: options.client } : await createDatabase();
  await initDatabaseSchema(client);
  const container = buildContainer(db);

  // 契约骨架：暴露由 @aervox/contracts 生成的 OpenAPI 3.1 文档
  app.get("/openapi.json", async () => openApiDocument);

  // 注册业务路由
  registerConversationRoutes(app, container);
  registerLearningRoutes(app, container);
  registerFeedbackRoutes(app, container);
  registerDiaryRoutes(app, container);
  registerContentRoutes(app, container);
  registerNotificationRoutes(app, container);
  registerPrivacyRoutes(app, container);
  registerAnalyticsRoutes(app, container);

  return { app, db, client };
}
