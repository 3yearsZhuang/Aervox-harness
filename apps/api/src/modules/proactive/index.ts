/**
 * Aervox｜思隅 @aervox/api — CAP-033 主动智能模式模块入口。
 *
 * 生产装配应注入独立的本地 proactive vault 数据库与 cipher；未注入时回退
 * 到 ctx.db 仅用于本地开发/测试，调用方不应把该回退当作远程安全边界。
 */
import { timingSafeEqual } from "node:crypto";
import type { AervoxDatabase, ProactiveVaultCipher } from "@aervox/database";
import type { ModuleContext } from "../context.js";
import {
  SqlitePrivacyRepository,
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveProfileRepository,
} from "@aervox/database";
import { registerProactiveRoutes } from "./routes.js";
import { ProactiveActionAuthorizer } from "./action-authorizer.js";
import { registerProactiveIntelligenceRoutes } from "./intelligence-routes.js";
import { registerProactiveIntegrationRoutes } from "./integration-routes.js";
import { ProactiveIntegrationManager } from "./integration-manager.js";
import { registerProactiveIntegrationTools } from "./integration-tools.js";

export interface ProactiveModuleOptions {
  db?: AervoxDatabase;
  cipher?: ProactiveVaultCipher;
  accessToken?: string | null;
}

export interface ProactiveModuleServices {
  repository: SqliteProactiveProfileRepository;
  intelligenceRepository: SqliteProactiveIntelligenceRepository;
  actionAuthorizer: ProactiveActionAuthorizer;
  integrationManager: ProactiveIntegrationManager;
}

export function registerProactiveModule(ctx: ModuleContext, options: ProactiveModuleOptions = {}): ProactiveModuleServices {
  const repository = new SqliteProactiveProfileRepository(
    options.db ?? ctx.proactiveDb ?? ctx.db,
    options.cipher ?? ctx.proactiveCipher,
  );
  const actionAuthorizer = new ProactiveActionAuthorizer(repository);
  const localDb = options.db ?? ctx.proactiveDb ?? ctx.db;
  const privacyRepository = new SqlitePrivacyRepository(localDb);
  const intelligenceRepository = new SqliteProactiveIntelligenceRepository(
    localDb,
    options.cipher ?? ctx.proactiveCipher,
  );
  const integrationManager = new ProactiveIntegrationManager(intelligenceRepository, repository);
  ctx.proactiveRepository = repository;
  ctx.proactiveIntelligenceRepository = intelligenceRepository;
  ctx.proactiveActionAuthorizer = actionAuthorizer;
  const accessToken = options.accessToken ?? ctx.proactiveAccessToken;
  if (accessToken) {
    const expected = Buffer.from(accessToken, "utf8");
    ctx.app.addHook("preHandler", async (req, reply) => {
      if (!req.url.startsWith("/v1/proactive")) return;
      const raw = req.headers["x-aervox-proactive-token"];
      const candidate = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.alloc(0);
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
        return reply.code(401).send({ error: "proactive_device_auth_required" });
      }
    });
  }
  registerProactiveRoutes(ctx.app, { repository, privacyRepository });
  registerProactiveIntelligenceRoutes(ctx.app, {
    intelligenceRepo: intelligenceRepository,
    profileRepo: repository,
  });
  registerProactiveIntegrationRoutes(ctx.app, {
    intelligenceRepo: intelligenceRepository,
    profileRepo: repository,
    actionAuthorizer,
    manager: integrationManager,
  });
  if (ctx.toolRuntime) {
    registerProactiveIntegrationTools({
      runtime: ctx.toolRuntime,
      repo: intelligenceRepository,
      manager: integrationManager,
      authorizer: actionAuthorizer,
    });
  }
  ctx.app.addHook("onReady", async () => integrationManager.start());
  ctx.app.addHook("onClose", async () => integrationManager.stop());
  return { repository, intelligenceRepository, actionAuthorizer, integrationManager };
}
