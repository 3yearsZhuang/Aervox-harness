/**
 * Aervox｜思隅 @aervox/api — 通知域路由（用户侧）
 */
import type { FastifyInstance } from "fastify";
import type { SqlitePlatformRepository } from "@aervox/repositories";
import { resolveLocalContext } from "../../shared/local-context.js";

export function registerNotificationRoutes(
  app: FastifyInstance,
  platformRepo: SqlitePlatformRepository,
): void {
  app.get("/v1/notifications", async (req) => {
    const { limit } = req.query as { limit?: string };
    return { items: await platformRepo.listNotifications(resolveLocalContext(req), Number(limit ?? 50)) };
  });
}