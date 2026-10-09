import type { LocalContext } from "./local-context.js";

export interface DiaryMaterialMessage {
  role: "user" | "assistant";
  content: string;
  occurredAt: string;
}

export interface DiaryMaterialMemory {
  layer: string;
  category: string;
  content: string;
  createdAt: string;
}

export interface DiaryMaterial {
  /** 当日窗口内的聊天消息（时间升序，截断上限 200 条） */
  messages: DiaryMaterialMessage[];
  /** 当日窗口内留存的记忆（时间升序，截断上限 50 条） */
  memories: DiaryMaterialMemory[];
  /** 进行中的学习目标（topic/level/status） */
  goals: Array<{ topic: string; level: string; status: string }>;
  /** 当日练习统计 */
  attemptsToday: { total: number; correct: number };
}

export interface DiaryMaterialPort {
  collect(context: LocalContext, window: { startIso: string; endIso: string }): Promise<DiaryMaterial>;
}
