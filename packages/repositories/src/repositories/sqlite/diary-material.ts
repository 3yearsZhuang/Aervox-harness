/** Node compatibility wrapper; native composition supplies its own crypto port. */
import type { DiaryMaterial, DiaryMaterialPort, LocalContext } from "@aervox/contracts";
import type { AervoxDatabase } from "../../database.js";
import { nodeConversationCrypto } from "../../conversation-crypto-node.js";
import { collectDiaryMaterial as collect, createSqliteDiaryMaterialPort as create } from "./diary-material-neutral.js";
export function createSqliteDiaryMaterialPort(db: AervoxDatabase): DiaryMaterialPort {
  return create(db, nodeConversationCrypto);
}
export function collectDiaryMaterial(db: AervoxDatabase, ctx: LocalContext, window: { startIso: string; endIso: string }): Promise<DiaryMaterial> {
  return collect(db, ctx, window, nodeConversationCrypto);
}
