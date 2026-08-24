/**
 * Aervox｜思隅 @aervox/api — 日记域路由（用户侧）
 *
 * 日记查询、计划主实体管理；生成/发布由 Worker 负责。
 */
import type { FastifyInstance } from "fastify";
import type { RepoContainer } from "../container.js";
import { resolveTenant } from "../tenant.js";

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerDiaryRoutes(app: FastifyInstance, c: RepoContainer): void {
  // 按日期查询日记
  app.get("/v1/diaries", async (req, reply) => {
    const { localDate } = req.query as { localDate?: string };
    if (!localDate) return reply.code(400).send({ error: "localDate is required" });
    const diary = await c.diary.getDiaryByDate(resolveTenant(req), localDate);
    if (!diary) return reply.code(404).send({ error: "diary not found" });
    return diary;
  });

  // 创建/查询日记计划
  app.post("/v1/diaries/schedules", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as {
      scheduleEpochId?: string;
      activeFrom?: string;
      initialWindowStart?: string;
      cutoffRule?: string;
      bufferMinutes?: number;
      contentScopes?: unknown;
      quietHours?: unknown;
    };
    if (!body.scheduleEpochId || !body.activeFrom || !body.initialWindowStart || !body.cutoffRule) {
      return reply.code(400).send({
        error: "scheduleEpochId, activeFrom, initialWindowStart and cutoffRule are required",
      });
    }
    const schedule = await c.diary.createDiarySchedule(tenant, {
      id: id("ds"),
      scheduleEpochId: body.scheduleEpochId,
      activeFrom: body.activeFrom,
      initialWindowStart: body.initialWindowStart,
      cutoffRule: body.cutoffRule,
      bufferMinutes: body.bufferMinutes,
      contentScopes: body.contentScopes,
      quietHours: body.quietHours,
    });
    return reply.code(201).send(schedule);
  });

  app.get("/v1/diaries/schedules/:scheduleId", async (req, reply) => {
    const { scheduleId } = req.params as { scheduleId: string };
    const schedule = await c.diary.getDiarySchedule(resolveTenant(req), scheduleId);
    if (!schedule) return reply.code(404).send({ error: "schedule not found" });
    return schedule;
  });
}
