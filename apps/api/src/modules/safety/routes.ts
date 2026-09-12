/**
 * Aervox｜思隅 @aervox/api — 安全路由模块
 *
 * 规则依据：PRD §4.3、§6.5、SRS FR-SAFE-001、AI_QUALITY_SAFETY.md §7。
 * 暴露危机求助热线资源与安全事件审计记录接口。
 */
import type { FastifyInstance } from "fastify";
import { resolveLocalContext } from "../../shared/local-context.js";
import type { SafetyService } from "./service.js";

export function registerSafetyRoutes(app: FastifyInstance, service: SafetyService): void {
  // GET /v1/safety/resources — 获取危机干预与求助热线资源列表
  app.get("/v1/safety/resources", async (req) => {
    const query = req.query as { region?: string };
    const helplines = service.getHelplines(query.region);
    return {
      policyVersion: service.getPolicyVersion(),
      helplines,
    };
  });

  // GET /v1/safety/incidents — 获取安全事件审计记录列表（按租户隔离）
  app.get("/v1/safety/incidents", async (req) => {
    const tenant = resolveLocalContext(req);
    const query = req.query as { limit?: string | number };
    const limit = query.limit ? Math.min(Math.max(1, Number(query.limit)), 100) : 50;
    const incidents = await service.listIncidents(tenant, limit);
    return {
      items: incidents,
    };
  });
}
