/**
 * Aervox｜思隅 @aervox/api — 通知域路由（用户侧）
 */
import type { FastifyInstance } from "fastify";
import type { RepoContainer } from "../container.js";
import { resolveTenant } from "../tenant.js";

export function registerNotificationRoutes(app: FastifyInstance, c: RepoContainer): void {
  app.get("/v1/notifications", async (req) => {
    const { limit } = req.query as { limit?: string };
    return { items: await c.platform.listNotifications(resolveTenant(req), Number(limit ?? 50)) };
  });
}
