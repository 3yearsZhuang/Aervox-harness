import { asc, desc, eq } from "drizzle-orm";
import type { llmConfigs, voiceConfigs, voiceInputConfigs, voiceRemoteConfigs } from "@aervox/schema";
import type { AervoxDatabase } from "../../client.js";

type PresetTable = typeof llmConfigs | typeof voiceConfigs | typeof voiceInputConfigs | typeof voiceRemoteConfigs;
type Transaction = Parameters<Parameters<AervoxDatabase["transaction"]>[0]>[0];

/** Select the active preset before applying a limit; ties have a stable fallback. */
export function activePresetOrder(table: PresetTable) {
  return [desc(table.isActive), asc(table.createdAt), asc(table.id)];
}

export function activatePreset<T>(
  db: AervoxDatabase, table: PresetTable, id: string,
  read: (tx: Transaction) => Promise<T | null>,
): Promise<T | null> {
  return db.transaction(async tx => {
    const [target] = await tx.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
    if (!target) return null;
    const updatedAt = new Date().toISOString();
    await tx.update(table).set({ isActive: 0, updatedAt });
    await tx.update(table).set({ isActive: 1, updatedAt }).where(eq(table.id, id));
    return read(tx);
  });
}

export function deletePreset(db: AervoxDatabase, table: PresetTable, id: string): Promise<boolean> {
  return db.transaction(async tx => {
    const [target] = await tx.select({ isActive: table.isActive }).from(table).where(eq(table.id, id)).limit(1);
    if (!target) return false;
    await tx.delete(table).where(eq(table.id, id));
    if (target.isActive === 1) {
      const [first] = await tx.select({ id: table.id }).from(table)
        .orderBy(asc(table.createdAt), asc(table.id)).limit(1);
      if (first) await tx.update(table).set({ isActive: 1, updatedAt: new Date().toISOString() }).where(eq(table.id, first.id));
    }
    return true;
  });
}
