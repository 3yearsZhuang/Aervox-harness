/**
 * Aervox｜思隅 @aervox/repositories/diary — 日记域可装载入口（WebView/原生可用）
 *
 * 只导出浏览器安全的依赖闭包：日记/周期仓储与素材采集端口。
 * 手机端与 API / Worker 共用同一份仓储实现，避免两套写入协议。
 */
export { SqliteDiaryRepository } from "./repositories/sqlite/diary-repository.js";
export { collectDiaryMaterial, createSqliteDiaryMaterialPort } from "./repositories/sqlite/diary-material-neutral.js";
export type { LocalContext } from "./local-context.js";
export type {
  DiaryCycleModel,
  DiaryMaterialBufferModel,
  DiaryModel,
  DiaryParagraphSourceModel,
  DiaryPublicationParams,
  DiaryScheduleModel,
  DiaryVersionModel,
  IDiaryRepository,
} from "./repositories/types/index.js";
