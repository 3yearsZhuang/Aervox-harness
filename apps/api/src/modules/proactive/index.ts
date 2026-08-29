/**
 * Aervox｜思隅 @aervox/api — CAP-033 主动智能模式模块入口。
 *
 * 生产装配应注入独立的本地 proactive vault 数据库与 cipher；未注入时回退
 * 到 ctx.db 仅用于本地开发/测试，调用方不应把该回退当作远程安全边界。
 */
import { timingSafeEqual } from "node:crypto";
import type { AervoxDatabase, ProactiveVaultCipher } from "@aervox/database";
import type { ModuleContext } from "../context.js";
import { SqlitePrivacyRepository, SqliteProactiveProfileRepository } from "@aervox/database";
import { registerProactiveRoutes } from "./routes.js";
import { ProactiveActionAuthorizer } from "./action-authorizer.js";

export interface ProactiveModuleOptions {
  db?: AervoxDatabase;
  cipher?: ProactiveVaultCipher;
  accessToken?: string | null;
}

export interface ProactiveModuleServices {
  repository: SqliteProactiveProfileRepository;
  actionAuthorizer: ProactiveActionAuthorizer;
}

export function registerProactiveModule(ctx: ModuleContext, options: ProactiveModuleOptions = {}): ProactiveModuleServices {
  const repository = new SqliteProactiveProfileRepository(
    options.db ?? ctx.proactiveDb ?? ctx.db,
    options.cipher ?? ctx.proactiveCipher,
  );
  const actionAuthorizer = new ProactiveActionAuthorizer(repository);
  const privacyRepository = new SqlitePrivacyRepository(options.db ?? ctx.proactiveDb ?? ctx.db);
  ctx.proactiveRepository = repository;
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
  return { repository, actionAuthorizer };
}
