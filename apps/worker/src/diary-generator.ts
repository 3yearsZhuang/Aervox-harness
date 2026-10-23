import type { DiaryGenerationService } from "@aervox/diary";
import { generateDiaryId, localDateToday } from "@aervox/diary";
import { publishGeneratedDiary } from "@aervox/host-runtime/modules/learning/diary/index";
import type { IDiaryRepository, SqlitePlatformRepository, LocalContext } from "@aervox/repositories";

export interface DiaryGeneratorContext {
  diaryRepo: Pick<IDiaryRepository, "listDueSchedules" | "advanceSchedule" | "getDiaryByDate" | "publishGeneratedDiary">;
  generation: DiaryGenerationService;
  platformRepo: Pick<SqlitePlatformRepository, "createAuditRecord">;
  workerId: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 单次日记生成扫描；返回生成的日记数量 */
export async function runDiaryGenerationCycle(ctx: DiaryGeneratorContext): Promise<number> {
  const now = new Date().toISOString();

  const schedules = await ctx.diaryRepo.listDueSchedules(now);

  if (schedules.length === 0) return 0;

  let generated = 0;
  for (const schedule of schedules) {
    const tenant: LocalContext = { workspaceId: "local", subjectUserId: "local" };
    // 服务器本地日期（与按需路径同一日期语义，避免同日错位）
    const localDate = localDateToday(new Date());

    try {
      // 0. 同日已存在（按需路径可能已生成）→ 跳过并推进游标，避免唯一索引冲突
      const existingDiary = await ctx.diaryRepo.getDiaryByDate(tenant, localDate);
      if (existingDiary) {
        await ctx.diaryRepo.advanceSchedule(schedule.id, new Date(Date.now() + DAY_MS).toISOString(), now);
        continue;
      }

      const { cycle, draft } = await publishGeneratedDiary(ctx, tenant, {
        localDate, scheduleEpochId: schedule.scheduleEpochId, trigger: "scheduled",
        window: { startIso: schedule.lastCutoffAt ?? schedule.activeFrom, endIso: now },
        advance: { scheduleId: schedule.id, nextRunAt: new Date(Date.now() + DAY_MS).toISOString(), lastCutoffAt: now },
      });
      await ctx.platformRepo.createAuditRecord(tenant, {
        id: generateDiaryId("aud"),
        actorType: "system",
        actorId: `diary:${ctx.workerId}`,
        action: "diary.generated",
        subjectType: "diary_cycle",
        subjectId: cycle.id,
        metadata: { localDate, materialCount: draft.materialCount, generatedBy: draft.generatedBy },
      });
      generated += 1;
    } catch (err) {
      console.error(`[diary-generator] schedule ${schedule.id} failed:`, err);
    }
  }
  return generated;
}
