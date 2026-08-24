/**
 * Aervox｜思隅 @aervox/api — 埋点路由（用户侧）
 *
 * analyticsSubjectId 使用伪名化标识，不保存无必要正文。
 */
import type { FastifyInstance } from "fastify";
import type { RepoContainer } from "../container.js";
import { resolveTenant } from "../tenant.js";

let seq = 0;
const id = (): string => `ae_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerAnalyticsRoutes(app: FastifyInstance, c: RepoContainer): void {
  app.post("/v1/analytics/events", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as {
      eventName?: string;
      eventSchemaVersion?: number;
      occurredAt?: string;
      analyticsSubjectId?: string;
      context?: unknown;
      privacyClass?: string;
    };
    if (!body.eventName) {
      return reply.code(400).send({ error: "eventName is required" });
    }
    const event = await c.analytics.recordEvent(tenant, {
      id: id(),
      eventName: body.eventName,
      eventSchemaVersion: body.eventSchemaVersion,
      occurredAt: body.occurredAt,
      analyticsSubjectId: body.analyticsSubjectId ?? tenant.subjectUserId,
      context: body.context,
      privacyClass: body.privacyClass,
    });
    return reply.code(201).send(event);
  });
}
