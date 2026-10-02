/**
 * Aervox｜思隅 @aervox/api — 回合插件契约本地出口
 *
 * CR-060：契约已上移至 `@aervox/host-plugin-api`，本文件只做出口聚合，
 * **不再定义**任何插件领域字段（原 `allowQuizTrigger` / `quizMode` 已删除，
 * 插件私有语义经 `BeforeTurnResult.state` 与 Turn `metadata` 自行承载）。
 *
 * 宿主以窄端口 `TurnStreamPort` 向插件提供回合流读写，插件不接触仓储与实时总线。
 */
export type {
  AfterTurnContext,
  BeforeTurnResult,
  ServerTurnPlugin,
  TurnLlmPort,
  TurnPluginContext,
  TurnPluginRegistryPort,
  TurnStreamAppendInput,
  TurnStreamEventFrame,
  TurnStreamPort,
} from "@aervox/host-plugin-api";

import type { ServerTurnPlugin } from "@aervox/host-plugin-api";

/** 服务端通用插件接口，当前与 ServerTurnPlugin 保持兼容 */
export type ServerPlugin = ServerTurnPlugin;
