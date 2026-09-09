/**
 * Aervox｜思隅 @aervox/api — 专注模式服务端回合插件 (Focus Mode Turn Plugin)
 *
 * 完整统一专注模式（CAP-002 启发式教学 / CAP-007 概念探索 / CAP-016 现场刷题）：
 * 1. 模式统一：刷题（Quiz）为专注模式下的交互式练习能力，不再作为独立顶层模式；
 * 2. 结构化元数据识别 (`metadata.mode === 'focus' | 'study' | 'quiz'`)；
 * 3. 兼容文本前缀识别 (`[模式：专注模式]`、`[模式：刷题模式]` 等)；
 * 4. 前置切面 (beforeTurn)：注入苏格拉底教学系统提示词与刷题模式决策；
 * 5. 后置切面 (afterTurn)：回合完成后的术语提取与 terms_extracted 事件派发。
 */
import type {
  IExtensionRepository,
  IPluginConfigRepository,
  SqliteConversationRepository,
  TenantContext,
} from "@aervox/database";
import { extractTerms, type LLMCallable } from "@aervox/practice-review";
import {
  buildFocusModePrompt,
  type FocusModeConfigOptions,
} from "@aervox/agent-loop";
import type { ServerTurnPlugin } from "./types.js";
import { defaultServerTurnPluginRegistry } from "./registry.js";

export interface FocusModeRuntimeConfig {
  autoEnableFocusMode?: boolean;
  autoEnableStudyMode?: boolean;
  strictAntiSpoiler?: boolean;
  scaffoldingSteps?: number;
  maxExtractedTerms?: number;
  enableJudgePass?: boolean;
  defaultExploreKind?: "socratic" | "child" | "related" | "branch";
  showTermTips?: boolean;
}

/** 向后兼容类型别名 */
export type StudyModeRuntimeConfig = FocusModeRuntimeConfig;

/** 专注模式 Schema 规范默认值（对齐 plugins/focus-mode/config.schema.json） */
export const DEFAULT_FOCUS_MODE_CONFIG: Required<FocusModeRuntimeConfig> = {
  autoEnableFocusMode: true,
  autoEnableStudyMode: true,
  strictAntiSpoiler: true,
  scaffoldingSteps: 3,
  maxExtractedTerms: 3,
  defaultExploreKind: "socratic",
  showTermTips: true,
  enableJudgePass: false,
};

export const DEFAULT_STUDY_MODE_CONFIG = DEFAULT_FOCUS_MODE_CONFIG;

export function parseFocusConfig(values?: Record<string, unknown> | null): FocusModeRuntimeConfig {
  if (!values) return { ...DEFAULT_FOCUS_MODE_CONFIG };
  return {
    autoEnableFocusMode:
      typeof values.autoEnableFocusMode === "boolean"
        ? values.autoEnableFocusMode
        : typeof values.autoEnableStudyMode === "boolean"
          ? values.autoEnableStudyMode
          : DEFAULT_FOCUS_MODE_CONFIG.autoEnableFocusMode,
    autoEnableStudyMode:
      typeof values.autoEnableStudyMode === "boolean"
        ? values.autoEnableStudyMode
        : typeof values.autoEnableFocusMode === "boolean"
          ? values.autoEnableFocusMode
          : DEFAULT_FOCUS_MODE_CONFIG.autoEnableStudyMode,
    strictAntiSpoiler:
      typeof values.strictAntiSpoiler === "boolean"
        ? values.strictAntiSpoiler
        : DEFAULT_FOCUS_MODE_CONFIG.strictAntiSpoiler,
    scaffoldingSteps:
      typeof values.scaffoldingSteps === "number"
        ? values.scaffoldingSteps
        : DEFAULT_FOCUS_MODE_CONFIG.scaffoldingSteps,
    maxExtractedTerms:
      typeof values.maxExtractedTerms === "number"
        ? values.maxExtractedTerms
        : DEFAULT_FOCUS_MODE_CONFIG.maxExtractedTerms,
    enableJudgePass:
      typeof values.enableJudgePass === "boolean"
        ? values.enableJudgePass
        : DEFAULT_FOCUS_MODE_CONFIG.enableJudgePass,
    defaultExploreKind:
      typeof values.defaultExploreKind === "string"
        ? (values.defaultExploreKind as FocusModeRuntimeConfig["defaultExploreKind"])
        : DEFAULT_FOCUS_MODE_CONFIG.defaultExploreKind,
    showTermTips:
      typeof values.showTermTips === "boolean"
        ? values.showTermTips
        : DEFAULT_FOCUS_MODE_CONFIG.showTermTips,
  };
}

export const parseStudyConfig = parseFocusConfig;

/**
 * 加载并解析 focus-mode 插件配置（自动回退 study-mode）。
 */
export async function loadFocusModeRuntimeConfig(
  tenantOrRepo: TenantContext | IExtensionRepository | SqliteConversationRepository,
  configRepoOrTenant?: IPluginConfigRepository | TenantContext | null,
  maybeConfigRepo?: IPluginConfigRepository | null,
): Promise<FocusModeRuntimeConfig> {
  let tenant: TenantContext;
  let configRepo: IPluginConfigRepository | null | undefined;

  if (
    configRepoOrTenant &&
    typeof (configRepoOrTenant as IPluginConfigRepository).getConfig === "function"
  ) {
    tenant = tenantOrRepo as TenantContext;
    configRepo = configRepoOrTenant as IPluginConfigRepository;
  } else {
    tenant = configRepoOrTenant as TenantContext;
    configRepo = maybeConfigRepo;
  }

  const defaults = { ...DEFAULT_FOCUS_MODE_CONFIG };
  if (!configRepo) return defaults;

  try {
    let model = await configRepo.getConfig(tenant, "focus-mode").catch(() => null);
    if (!model?.valuesJson) {
      model = await configRepo.getConfig(tenant, "study-mode").catch(() => null);
    }
    if (!model?.valuesJson) return defaults;
    const stored =
      typeof model.valuesJson === "string"
        ? JSON.parse(model.valuesJson)
        : model.valuesJson;
    if (!stored || typeof stored !== "object") return defaults;
    return {
      ...defaults,
      ...stored,
    };
  } catch {
    return defaults;
  }
}

export const loadStudyModeRuntimeConfig = loadFocusModeRuntimeConfig;

/** 刷题意图自然语言关键词 */
export const QUIZ_TRIGGER_KEYWORDS = /来几道题|来几道|刷题|出几道题|考考我|出题/;

/** 识别当前消息是否带专注模式标识（元数据或前缀） */
export function isFocusModeMessage(
  userMessage?: string | null,
  metadata?: Record<string, unknown> | null,
): boolean {
  if (
    metadata?.mode === "focus" ||
    metadata?.mode === "focus-mode" ||
    metadata?.mode === "study"
  ) {
    return true;
  }
  if (!userMessage) return false;
  return (
    userMessage.includes("[模式：专注模式]") ||
    userMessage.includes("[模式：陪学讲解]") ||
    userMessage.includes("[模式：深度拆解]")
  );
}

export const isStudyModeMessage = isFocusModeMessage;

/** 识别当前消息是否触发刷题出题/答题闭环 */
export function isQuizTriggered(
  userMessage?: string | null,
  metadata?: Record<string, unknown> | null,
): boolean {
  if (metadata?.intent === "quiz" || metadata?.mode === "quiz") return true;
  if (!userMessage) return false;
  if (userMessage.includes("[模式：刷题模式]")) return true;
  return isFocusModeMessage(userMessage, metadata) && QUIZ_TRIGGER_KEYWORDS.test(userMessage);
}

export const isQuizModeMessage = isQuizTriggered;

/**
 * CAP-007 / CAP-002：专注模式 Turn 完成后的增强后处理——抽取文本中的术语
 */
export async function extractFocusTerms(
  repo: SqliteConversationRepository,
  tenant: TenantContext,
  input: { turnId: string; userMessage: string; metadata?: Record<string, unknown> | null },
  focusConfig?: FocusModeRuntimeConfig | null,
  llm?: LLMCallable | null,
): Promise<void> {
  if (!isFocusModeMessage(input.userMessage, input.metadata)) return;
  try {
    const events = await repo.getStreamEvents(tenant, input.turnId, 0);
    let fullAssistantText = "";
    let lastSeq = 0;
    let lastMessageId: string | undefined;

    for (const ev of events) {
      if (ev.sequence > lastSeq) lastSeq = ev.sequence;
      if (ev.eventType === "message" && (ev.data as { messageId?: string }).messageId) {
        lastMessageId = (ev.data as { messageId?: string }).messageId;
      }
      if (ev.eventType === "delta" && typeof (ev.data as { text?: string }).text === "string") {
        fullAssistantText += (ev.data as { text?: string }).text;
      }
    }

    const extractOptions = {
      llm: llm ?? undefined,
      maxTerms: focusConfig?.maxExtractedTerms ?? DEFAULT_FOCUS_MODE_CONFIG.maxExtractedTerms,
      enableJudgePass: focusConfig?.enableJudgePass ?? DEFAULT_FOCUS_MODE_CONFIG.enableJudgePass,
    };

    let terms =
      fullAssistantText.trim().length > 0
        ? await extractTerms(fullAssistantText, extractOptions)
        : [];
    if (terms.length === 0 && input.userMessage) {
      terms = await extractTerms(input.userMessage, extractOptions);
    }
    if (terms.length > 0) {
      await repo.appendStreamEvent(tenant, {
        id: `tme_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        turnId: input.turnId,
        sequence: lastSeq + 1,
        eventType: "terms_extracted",
        payloadVersion: 1,
        data: {
          turnId: input.turnId,
          messageId: lastMessageId,
          terms,
        },
      });
    }
  } catch {
    // 术语抽取属于增强后处理，吞掉异常防止影响 Turn 最终完成态
  }
}

export const extractStudyTerms = extractFocusTerms;

export const focusModeTurnPlugin: ServerTurnPlugin = {
  id: "focus-mode",

  beforeTurn(ctx, configRaw) {
    const isFocus = isFocusModeMessage(ctx.userMessage, ctx.metadata);
    const quizActive = isQuizTriggered(ctx.userMessage, ctx.metadata);
    if (!isFocus && !quizActive) {
      return;
    }

    const cfg = parseFocusConfig(configRaw);
    const prompt = quizActive
      ? `【专注模式·出题与即时判定模式】
你正在以苏格拉底教学法出题检验用户的掌握程度。
1. 若用户在请求出题，请根据上下文或其指定的知识点，立即出 1~3 道具有代表性的题目（包含选择题或简答题），不要直接给答案，等待用户作答。
2. 若用户正在回答上一轮题目，请即时判定正误，给出透彻且鼓励的解析；若答错，指出关键概念并再出一道变式题巩固。
3. 保持启发性与耐心，严禁在出题阶段剧透答案。`
      : buildFocusModePrompt(
          cfg
            ? {
                strictAntiSpoiler: cfg.strictAntiSpoiler,
                scaffoldingSteps: cfg.scaffoldingSteps,
              }
            : undefined,
        );

    return {
      extraSections: [prompt],
      allowQuizTrigger: true,
      quizMode: quizActive,
      state: {
        isFocusMode: isFocus,
        isStudyMode: isFocus,
        focusConfig: cfg,
        quizActive,
      },
    };
  },

  async afterTurn(ctx, configRaw, beforeResult) {
    if (ctx.status !== "Completed") return;
    if (beforeResult?.state?.quizActive) return;
    if (!beforeResult?.state?.isFocusMode && !beforeResult?.state?.isStudyMode) return;

    const cfg =
      (beforeResult.state.focusConfig as FocusModeRuntimeConfig) ??
      parseFocusConfig(configRaw);
    await extractFocusTerms(
      ctx.repo,
      ctx.tenant,
      { turnId: ctx.turnId, userMessage: ctx.userMessage, metadata: ctx.metadata },
      cfg,
      ctx.llm,
    );
  },
};

/** 向后兼容导出 studyModeTurnPlugin 与 quizModeTurnPlugin */
export const studyModeTurnPlugin: ServerTurnPlugin = {
  ...focusModeTurnPlugin,
  id: "study-mode",
};

export const quizModeTurnPlugin: ServerTurnPlugin = {
  id: "quiz-mode",
  beforeTurn(ctx) {
    if (!isQuizTriggered(ctx.userMessage, ctx.metadata)) return;
    return {
      quizMode: true,
      state: { isQuizMode: true },
    };
  },
};

// 自动注册专注模式主插件至默认服务回合插件注册表（别名由 Registry.get 与 Runner 自适应处理）
defaultServerTurnPluginRegistry.register(focusModeTurnPlugin);
