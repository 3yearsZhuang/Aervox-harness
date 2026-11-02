/**
 * Aervox｜思隅 @aervox/repositories/learning — 学习域中性执行入口（WebView/原生可装载）
 *
 * 与 ./conversation 一致：不装配连接与平台回退，宿主注入可信同步原语
 * （ConversationCryptoPort）。Node 组合继续经 SqliteLearningRepository
 * 包装类取得 node:crypto 默认值；本入口的依赖闭包不得引入 node: 内置模块。
 */
export { LearningRepository } from "./repositories/sqlite/learning-repository-neutral.js";
export { canonicalAnswerRequest } from "./repositories/sqlite/learning-answer-store.js";
export type { ConversationCryptoPort } from "./conversation-host-port.js";
export type { LocalContext } from "./local-context.js";
export type {
  ILearningRepository,
  LearningAnswerPolicy,
  LearningAnswerCommand,
  LearningAnswerResult,
  AnswerNextStep,
  ReviewItemModel,
  KnowledgeItemModel,
} from "./repositories/types/index.js";
