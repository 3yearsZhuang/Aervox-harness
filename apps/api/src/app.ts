/**
 * Aervox｜思隅 @aervox/api — Fastify 应用工厂
 *
 * 允许注入内存/临时数据库用于集成测试；不负责 listen（由入口或测试调用方控制）。
 * 按 ADR-014 演进式模块化单体组织：注册 8 个领域模块，各自实例化仓储。
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { openApiDocument } from "@aervox/contracts";
import {
  createDatabase,
  initDatabaseSchema,
  type AervoxDatabase,
} from "@aervox/database";
import type { Client } from "@libsql/client";
import { registerConversationModule } from "./modules/conversation/index.js";
import { registerLearningModule } from "./modules/learning/index.js";
import { registerFeedbackModule } from "./modules/feedback/index.js";
import { registerDiaryModule } from "./modules/diary/index.js";
import { registerContentModule } from "./modules/content/index.js";
import { registerNotificationModule } from "./modules/notification/index.js";
import { registerPrivacyModule } from "./modules/privacy/index.js";
import { registerAnalyticsModule } from "./modules/analytics/index.js";
import { registerMemoryModule } from "./modules/memory/index.js";
import { registerKnowledgeModule } from "./modules/knowledge/index.js";
import { registerBranchModule } from "./modules/branch/index.js";
import { registerToolsModule } from "./modules/tools/index.js";
import { registerPluginsModule } from "./modules/plugins/index.js";
import { registerPersonaModule } from "./modules/persona/index.js";
import { registerSkillsModule } from "./modules/skills/index.js";

export interface BuildAppOptions {
  /** 注入既有数据库（如内存库）；缺省时使用 createDatabase() */
  db?: AervoxDatabase;
  client?: Client;
  /** Skill 内容落盘根目录（测试注入临时目录；缺省 <repo>/data/skills） */
  skillsRoot?: string;
  /** 插件 Page Bundle 落盘根目录（测试注入临时目录；缺省 <repo>/data/plugins） */
  pluginsRoot?: string;
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

  // CORS：允许本地 Web/移动端跨源访问（生产环境按部署配置收紧 origin）
  await app.register(cors, { origin: true });

  // 契约骨架：暴露由 @aervox/contracts 生成的 OpenAPI 3.1 文档
  app.get("/openapi.json", async () => openApiDocument);

  // 注册领域模块（每个模块自管仓储实例化）
  registerConversationModule(app, db);
  registerLearningModule(app, db);
  registerFeedbackModule(app, db);
  registerDiaryModule(app, db);
  registerContentModule(app, db);
  registerNotificationModule(app, db);
  registerPrivacyModule(app, db);
  registerAnalyticsModule(app, db);
  registerMemoryModule(app, db, client);
  registerKnowledgeModule(app, db);
  registerBranchModule(app, db);
  const toolRuntime = registerToolsModule(app, db, client);
  registerPluginsModule(app, db, { skillsRoot: options.skillsRoot, pluginsRoot: options.pluginsRoot });
  registerPersonaModule(app, db);
  registerSkillsModule(app, db, { skillsRoot: options.skillsRoot, toolRuntime });

  return { app, db, client };
}