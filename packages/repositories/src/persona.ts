/**
 * Aervox｜思隅 @aervox/repositories/persona — 人格域可装载入口（WebView/原生可用）
 *
 * 与 ./conversation、./learning 一致：只导出浏览器安全的依赖闭包（drizzle + @aervox/schema），
 * 不引 node: 内置模块，便于手机端装配同一份寄存真源。
 */
export { SqlitePersonaRepository } from "./repositories/sqlite/persona-repository.js";
export type { LocalContext } from "./local-context.js";
export type {
  ActivePersonaSelectionModel,
  IPersonaRepository,
  PersonaMemoryScopeModel,
  PersonaModel,
  PersonaRevisionModel,
  PersonaSwitchLogModel,
  PersonaTurnContextModel,
} from "./repositories/types/index.js";
