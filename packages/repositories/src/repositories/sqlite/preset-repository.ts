/**
 * Aervox｜思隅 @aervox/repositories — 「至多一行激活的预设表」通用 CRUD 实现。
 *
 * 语音输出、语音输入、在线语音与模型四组配置表共享同一套语义：可存多个预设、
 * 至多一行 `isActive=1`、首次创建自动激活、删除激活行后回落到最早一行。这四份
 * 仓储此前逐行同构，只有表对象、id 前缀、行映射与字段映射不同；改一处规则必须
 * 记得改四处，否则某类配置的激活语义会单独漂移。
 *
 * 这里只抽出**没有业务差异**的部分：取值顺序、save 的「有则更新 / 无则插入」、
 * 首个预设自动激活、按 created_at 排序。业务字段映射仍留在各自仓储的 `toRow`，
 * 因为布尔转 0/1、数组序列化、默认值填充等差异属表契约，不该被基类抹平。
 */
import { and, asc, eq } from "drizzle-orm";
import type { llmConfigs, voiceConfigs, voiceInputConfigs, voiceRemoteConfigs } from "@aervox/schema";
import { activePresetOrder, activatePreset, deletePreset } from "./preset-lifecycle.js";
import type { AervoxDatabase } from "../../client.js";
import type { LocalContext } from "../../local-context.js";

/** 四张预设配置表的并集；与 `preset-lifecycle.ts` 使用同一组表。 */
export type PresetTable = typeof llmConfigs | typeof voiceConfigs | typeof voiceInputConfigs | typeof voiceRemoteConfigs;

const DEFAULT_PRESET_NAME = "默认配置";

/** 生成一段带前缀的短 id；时间在前保证同毫秒内按创建顺序可排序。 */
function newPresetId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface PresetCrudOptions<TTable extends PresetTable, TModel, TInput> {
  db: AervoxDatabase;
  /** 该预设组的表对象。 */
  table: TTable;
  /** 新预设 id 前缀（`vc`、`vic`、`vrc`、`llm`）。 */
  idPrefix: string;
  /** 表行 → 领域模型；显式字段列表是 schema 变更的编译期护栏，故由调用方提供。 */
  toModel: (row: TTable["$inferSelect"]) => TModel;
  /** 保存输入 → 待写入列；负责该表特有的类型转换与默认值。 */
  toRow: (input: TInput) => Record<string, unknown>;
}

export interface PresetCrud<TModel, TInput> {
  getConfig(ctx: LocalContext): Promise<TModel | null>;
  saveConfig(ctx: LocalContext, input: TInput): Promise<TModel>;
  listPresets(ctx: LocalContext): Promise<TModel[]>;
  createPreset(ctx: LocalContext, name: string, input: TInput): Promise<TModel>;
  updatePreset(ctx: LocalContext, presetId: string, input: TInput): Promise<TModel | null>;
  activatePreset(ctx: LocalContext, presetId: string): Promise<TModel | null>;
  deletePreset(ctx: LocalContext, presetId: string): Promise<boolean>;
}

/**
 * 构造一组预设 CRUD 方法。
 *
 * 返回对象与四个仓储此前的公开方法一一对应，各仓储只需转发一层，
 * 对外接口（`types/*.ts` 中的 Port）保持不变。
 */
export function createPresetCrud<TTable extends PresetTable, TModel, TInput>(
  options: PresetCrudOptions<TTable, TModel, TInput>,
): PresetCrud<TModel, TInput> {
  const { db, table, idPrefix, toModel, toRow } = options;

  const read = (row: unknown): TModel => toModel(row as TTable["$inferSelect"]);

  async function listPresets(ctx: LocalContext): Promise<TModel[]> {
    void ctx;
    const rows = await db.select().from(table).orderBy(asc(table.createdAt));
    return rows.map(read);
  }

  async function getConfig(ctx: LocalContext): Promise<TModel | null> {
    void ctx;
    const rows = await db.select().from(table).orderBy(...activePresetOrder(table)).limit(1);
    const first = rows[0];
    return first === undefined ? null : read(first);
  }

  async function insertRow(
    input: TInput, name: string, id: string, now: string, isActive: 0 | 1,
  ): Promise<TModel> {
    const [created] = await db
      .insert(table)
      .values({ id, name, isActive, ...toRow(input), createdAt: now, updatedAt: now } as never)
      .returning();
    return read(created);
  }

  async function saveConfig(ctx: LocalContext, input: TInput): Promise<TModel> {
    const now = new Date().toISOString();
    const active = await getConfig(ctx);
    if (active) {
      const [updated] = await db
        .update(table)
        .set({ ...toRow(input), updatedAt: now } as never)
        .where(eq(table.id, (active as unknown as { id: string }).id))
        .returning();
      return read(updated);
    }
    return insertRow(input, DEFAULT_PRESET_NAME, newPresetId(idPrefix), now, 1);
  }

  async function createPreset(ctx: LocalContext, name: string, input: TInput): Promise<TModel> {
    // 首个预设必须激活，否则列表中已有内容但 getConfig 返回 null。
    const isFirst = (await listPresets(ctx)).length === 0;
    return insertRow(
      input,
      name.trim() || DEFAULT_PRESET_NAME,
      newPresetId(idPrefix),
      new Date().toISOString(),
      isFirst ? 1 : 0,
    );
  }

  async function updatePreset(ctx: LocalContext, presetId: string, input: TInput): Promise<TModel | null> {
    void ctx;
    const [updated] = await db
      .update(table)
      .set({ ...toRow(input), updatedAt: new Date().toISOString() } as never)
      .where(and(eq(table.id, presetId)))
      .returning();
    return updated === undefined ? null : read(updated);
  }

  async function activate(ctx: LocalContext, presetId: string): Promise<TModel | null> {
    void ctx;
    return activatePreset(db, table, presetId, async (tx) => {
      const [row] = await tx.select().from(table).where(eq(table.id, presetId)).limit(1);
      return row === undefined ? null : read(row);
    });
  }

  async function remove(ctx: LocalContext, presetId: string): Promise<boolean> {
    void ctx;
    return deletePreset(db, table, presetId);
  }

  return {
    getConfig, saveConfig, listPresets, createPreset, updatePreset,
    activatePreset: activate, deletePreset: remove,
  };
}
