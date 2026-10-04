/**
 * Aervox｜思隅 plugins/focus-mode — 专注模式回合插件（CAP-002 / CAP-007 / CAP-016）
 *
 * CR-060：自 `apps/api/src/modules/ecosystem/plugins/turn-plugins/focus-mode.ts` 迁入。
 *
 * 设计要点：
 * 1. 只依赖 `@aervox/host-plugin-api` 的窄端口，不接触仓储、本地上下文或宿主实时总线；
 * 2. 模式语义（是否专注、是否出题）由本插件自行判定与承载，通过 `state` 传给后置切面，
 *    不使用宿主的通用协议字段；
 * 3. 不保留 `study-mode` / `quiz-mode` 历史别名，主 id 唯一为 `focus-mode`。
 */
import type { ServerTurnPlugin, TurnPluginContext } from "@aervox/host-plugin-api";
import { buildFocusModePrompt, QUIZ_SESSION_PROMPT } from "./prompt.js";
import { extractTerms } from "./terms-extractor.js";

/** 插件运行时配置（键名对齐 plugins/focus-mode/config.schema.json） */
export interface FocusModeRuntimeConfig {
  autoEnableFocusMode?: boolean;
  strictAntiSpoiler?: boolean;
  scaffoldingSteps?: number;
  maxExtractedTerms?: number;
  enableJudgePass?: boolean;
  defaultExploreKind?: "child" | "related" | "branch";
}

/** Config Schema 规范默认值 */
export const DEFAULT_FOCUS_MODE_CONFIG: Required<FocusModeRuntimeConfig> = {
  autoEnableFocusMode: true,
  strictAntiSpoiler: true,
  scaffoldingSteps: 3,
  maxExtractedTerms: 8,
  enableJudgePass: true,
  defaultExploreKind: "child",
};

/** 解析宿主传入的插件配置；缺失或非法字段回退默认值 */
export function parseFocusConfig(values?: Record<string, unknown> | null): FocusModeRuntimeConfig {
  if (!values) return { ...DEFAULT_FOCUS_MODE_CONFIG };
  const bool = (key: keyof FocusModeRuntimeConfig, fallback: boolean): boolean =>
    typeof values[key] === "boolean" ? (values[key] as boolean) : fallback;
  const num = (key: keyof FocusModeRuntimeConfig, fallback: number): number =>
    typeof values[key] === "number" ? (values[key] as number) : fallback;
  const explore = values.defaultExploreKind;
  return {
    autoEnableFocusMode: bool("autoEnableFocusMode", DEFAULT_FOCUS_MODE_CONFIG.autoEnableFocusMode),
    strictAntiSpoiler: bool("strictAntiSpoiler", DEFAULT_FOCUS_MODE_CONFIG.strictAntiSpoiler),
    scaffoldingSteps: num("scaffoldingSteps", DEFAULT_FOCUS_MODE_CONFIG.scaffoldingSteps),
    maxExtractedTerms: num("maxExtractedTerms", DEFAULT_FOCUS_MODE_CONFIG.maxExtractedTerms),
    enableJudgePass: bool("enableJudgePass", DEFAULT_FOCUS_MODE_CONFIG.enableJudgePass),
    defaultExploreKind:
      explore === "child" || explore === "related" || explore === "branch"
        ? explore
        : DEFAULT_FOCUS_MODE_CONFIG.defaultExploreKind,
  };
}

/** 出题意图的自然语言触发词 */
export const QUIZ_TRIGGER_KEYWORDS = /来几道题|来几道|刷题|出几道题|考考我|出题/;

/**
 * 判定当前回合是否处于专注模式。
 *
 * CR-060：唯一判据是 Turn `metadata.mode === "focus"`，由本插件 UI 经宿主通用消息变换
 * 管道自述。不保留文本前缀等旁路通道：它们已无生产者，且会让"开关状态"与"出站语义"
 * 两处漂移（详见 CR-060 §1 减量证据与 §2 出站模式语义行）。
 */
export function isFocusModeMessage(metadata?: Record<string, unknown> | null): boolean {
  return metadata?.mode === "focus";
}

/**
 * 判定当前回合是否触发出题/答题闭环。
 * 结构化意图（`metadata.intent === "quiz"`）优先；否则在专注模式下按自然语言触发词判定。
 */
export function isQuizTriggered(
  userMessage?: string | null,
  metadata?: Record<string, unknown> | null,
): boolean {
  if (metadata?.intent === "quiz") return true;
  if (!userMessage) return false;
  return isFocusModeMessage(metadata) && QUIZ_TRIGGER_KEYWORDS.test(userMessage);
}

/** 后置状态键：本轮是否为专注模式且非出题 */
const STATE_QUIZ_ACTIVE = "quizActive";
const STATE_IS_FOCUS = "isFocusMode";
const STATE_CONFIG = "focusConfig";

/** 回合后置：抽取助手回复中的概念术语并作为插件事件写入回合流 */
export async function extractFocusTerms(
  ctx: TurnPluginContext,
  config: FocusModeRuntimeConfig,
): Promise<void> {
  const events = await ctx.stream.readEvents(ctx.turnId, 0);
  let fullAssistantText = "";
  let lastMessageId: string | undefined;

  for (const event of events) {
    const data = (event.data ?? {}) as { messageId?: string; text?: string };
    if (event.eventType === "message" && data.messageId) lastMessageId = data.messageId;
    if (event.eventType === "delta" && typeof data.text === "string") fullAssistantText += data.text;
  }

  const extractOptions = {
    llm: ctx.llm ?? undefined,
    maxTerms: config.maxExtractedTerms,
    enableJudgePass: config.enableJudgePass,
  };

  let terms =
    fullAssistantText.trim().length > 0 ? await extractTerms(fullAssistantText, extractOptions) : [];
  if (terms.length === 0 && ctx.userMessage) {
    terms = await extractTerms(ctx.userMessage, extractOptions);
  }
  if (terms.length === 0) return;

  await ctx.stream.appendEvent({
    eventType: "terms_extracted",
    payloadVersion: 1,
    data: { turnId: ctx.turnId, messageId: lastMessageId, terms },
  });
}

export const focusModeTurnPlugin: ServerTurnPlugin = {
  id: "focus-mode",
  name: "专注学习模式",

  beforeTurn(ctx, configRaw) {
    const isFocus = isFocusModeMessage(ctx.metadata);
    const quizActive = isQuizTriggered(ctx.userMessage, ctx.metadata);
    if (!isFocus && !quizActive) return;

    const config = parseFocusConfig(configRaw);
    const prompt = quizActive
      ? QUIZ_SESSION_PROMPT
      : buildFocusModePrompt({
          strictAntiSpoiler: config.strictAntiSpoiler,
          scaffoldingSteps: config.scaffoldingSteps,
        });

    return {
      extraSections: [prompt],
      state: { [STATE_IS_FOCUS]: isFocus, [STATE_QUIZ_ACTIVE]: quizActive, [STATE_CONFIG]: config },
    };
  },

  async afterTurn(ctx, configRaw, beforeResult) {
    if (ctx.status !== "Completed") return;
    const state = beforeResult?.state;
    if (!state?.[STATE_IS_FOCUS] || state[STATE_QUIZ_ACTIVE]) return;

    const config = (state[STATE_CONFIG] as FocusModeRuntimeConfig | undefined) ?? parseFocusConfig(configRaw);
    try {
      await extractFocusTerms(ctx, config);
    } catch {
      // 术语抽取属增强后处理：失败不得影响回合最终完成态
    }
  },
};
