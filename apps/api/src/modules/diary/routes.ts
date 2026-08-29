/**
 * Aervox｜思隅 @aervox/api — 日记域路由（用户侧）
 *
 * 日记查询/回看、每日按需生成、计划主实体管理；定时兜底生成由 Worker 负责
 * （POST /v1/diaries/generate-today 会懒创建租户默认每日计划激活定时链路）。
 */
import type { FastifyInstance } from "fastify";
import type { SqliteDiaryRepository } from "@aervox/database";
import { resolveTenant } from "../../shared/tenant.js";
import type { DiaryApplicationService } from "./application.js";

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerDiaryRoutes(
  app: FastifyInstance,
  deps: { diaryRepo: SqliteDiaryRepository; service: DiaryApplicationService },
): void {
  const { diaryRepo, service } = deps;

  // 按日期查询日记；无 localDate 时返回历史列表（历史回看）
  app.get("/v1/diaries", async (req, reply) => {
    const { localDate, limit } = req.query as { localDate?: string; limit?: string };
    if (localDate) {
      const diary = await diaryRepo.getDiaryByDate(resolveTenant(req), localDate);
      if (!diary) return reply.code(404).send({ error: "diary not found" });
      return diary;
    }
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 30;
    const items = await diaryRepo.listDiaries(
      resolveTenant(req),
      Number.isFinite(parsedLimit) ? parsedLimit : 30,
    );
    return { items };
  });

  // 每日按需生成/取回：默认只建（当日已有则原样返回）；rewrite=true 时改写
  app.post("/v1/diaries/generate-today", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as { rewrite?: boolean; focus?: string };
    await service.ensureDefaultSchedule(tenant);
    const result = body.rewrite
      ? await service.rewriteTodayDiary(tenant, body.focus)
      : await service.ensureTodayDiary(tenant, body.focus);
    return { ...result };
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
    const schedule = await diaryRepo.createDiarySchedule(tenant, {
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
    const schedule = await diaryRepo.getDiarySchedule(resolveTenant(req), scheduleId);
    if (!schedule) return reply.code(404).send({ error: "schedule not found" });
    return schedule;
  });
}