/**
 * Aervox｜思隅 @aervox/core — 上下文组装器
 *
 * 阶段 1 最小实现 + 阶段 5a Inbox 注入 + 阶段 5b（Skill 渐进式披露 / Context 压缩 seam）。
 * §7.1 Context 组装顺序：固定系统安全边界 → Profile/Persona → 安全历史 → 记忆/学习事实/Skill
 * → 工具 schema → 上级工具结果 → 可消费 inbox item；压缩 seam 对组装后的消息执行。
 * Skill 渐进披露：系统提示词仅注入技能「名称 + 描述」，模型按需读取 SKILL.md 全文（省 token）。
 */
import type {
  AgentInboxItem,
  ContextCompactionResult,
  ContextProjectionOptions,
  GroundingFacts,
  PromptContext,
  PromptMessage,
  SkillDescriptor,
} from "./types.js";
import type { ContextBuilderPort, ContextCompactionPort } from "./ports.js";
import { buildBaseSystemPrompt, type BaseSystemPromptOptions } from "./base-prompt.js";
import { awaitWithSignal } from "./abortable.js";
import { CompactionError } from "./errors.js";
import { createGroundingFactsContextBuilder } from "./grounding-facts.js";
import {
  groupMessagesByToolBoundary,
  projectContextToModelVisible,
} from "./context-projection.js";

/** 默认 builder：仅透传原始输入（inbox 项不注入，由宿主按需开启） */
export const defaultContextBuilder: ContextBuilderPort = {
  build(input: Parameters<ContextBuilderPort["build"]>[0]): PromptContext {
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      messages: input.messages,
    };
  },
};

/** 从 inbox 项构造追加输入消息（§7.1 第 7 项；附来源与用途标注） */
export function inboxItemsToMessages(items: AgentInboxItem[]): PromptMessage[] {
  const messages: PromptMessage[] = [];
  for (const item of items) {
    const prefix = `[inbox:${item.type}@${item.sourceActor}]`;
    let content = `${prefix} ${typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload)}`;
    if (item.type === "steer") content = `${content}\n（这用于调整当前任务的下一步方向。）`;
    messages.push({ role: "user", content });
  }
  return messages;
}

/**
 * 阶段 5a：启用 Inbox 注入的 builder。
 * - 透传 base 的组装逻辑；
 * - 在构建时将本次 Step 可消费的 inbox 项作为追加 user 消息（§7.1 第 7 项）注入。
 * 使用方（宿主）负责 claim/ack 与幂等边界。
 */
export function createInboxAwareContextBuilder(
  base: ContextBuilderPort = defaultContextBuilder,
): ContextBuilderPort {
  return {
    build(input: Parameters<ContextBuilderPort["build"]>[0]): PromptContext | Promise<PromptContext> {
      const inboxMessages = inboxItemsToMessages(input.inboxItems ?? []);
      const baseInput = {
        turnId: input.turnId,
        sessionId: input.sessionId,
        messages: [...inboxMessages, ...input.messages],
        signal: input.signal,
      };
      return base.build(baseInput);
    },
  };
}

// ============ 阶段 5b：Skill 渐进式披露 ============

/** Skill 渐进式披露提示词构建（§7.1 第 4 项「Skill 和外部来源」）。
 *  系统提示词仅注入「名称 + 描述」，模型决定使用某技能时按需读取 SKILL.md 全文。 */
export function buildSkillsPrompt(skills: SkillDescriptor[]): string {
  if (skills.length === 0) return "";

  const lines = skills.map(
    (skill) =>
      `- **${skill.name}**: ${skill.description || "Read SKILL.md for details."}`,
  );

  return [
    "## Skills",
    "",
    "You have specialized skills — reusable instruction bundles stored in `SKILL.md`",
    "files. Each skill has a **name** and a **description** that tells you what it",
    "does and when to use it.",
    "",
    "### Available skills",
    "",
    ...lines,
    "",
    "### Skill rules",
    "",
    "1. **Discovery** — The list above is the complete skill inventory for this",
    "   session. Full instructions live in the referenced `SKILL.md` file.",
    "2. **When to trigger** — Use a skill if the user names it explicitly, or if the",
    "   task clearly matches the skill's description. Never silently skip a matching",
    "   skill — either use it or briefly explain why you chose not to.",
    "3. **Mandatory grounding** — Before executing any skill you MUST first fetch its",
    "   `SKILL.md` via `GET /v1/skills/:name/content`. Never rely on memory or",
    "   assumptions about a skill's content.",
    "4. **Progressive disclosure** — Load only what is directly referenced from",
    "   `SKILL.md`. If `scripts/` or `assets/` exist, reuse them over rewriting.",
    "5. **Coordination** — When multiple skills apply, pick the minimal set needed.",
    "   Announce which skill(s) you are using and why (one short line).",
    "6. **Failure handling** — If a skill cannot be applied, state the issue clearly",
    "   and continue with the best alternative.",
    "",
  ].join("\n");
}

/** 创建 Skill 感知的 ContextBuilder（§7.1 第 4 项：Skill 清单注入 system）。 */
export function createSkillAwareContextBuilder(
  skills: SkillDescriptor[],
  base: ContextBuilderPort = defaultContextBuilder,
): ContextBuilderPort {
  const skillSystemPrompt = buildSkillsPrompt(skills);
  return {
    build(input: Parameters<ContextBuilderPort["build"]>[0]): PromptContext | Promise<PromptContext> {
      const msgs = input.messages;
      const messages: PromptMessage[] = [{ role: "system" as const, content: skillSystemPrompt }, ...msgs];
      return base.build({ ...input, messages });
    },
  };
}

// ============ 阶段 5b：Context 压缩 seam ============

/**
 * 默认透传压缩端口：不压缩、不截断，行为与既有完全一致。
 * 生产可注入 LLM 摘要实现或规则式策略。
 */
export const defaultCompactionPort: ContextCompactionPort = {
  async compact(input): Promise<ContextCompactionResult> {
    return { messages: input.messages };
  },
};

/** 真实摘要生成器函数签名 */
export type SummaryGenerator = (
  omittedMessages: PromptMessage[],
  options?: { signal?: AbortSignal; sessionId?: string; turnId?: string },
) => Promise<string>;

export interface SummaryCompactionOptions {
  /** 最大保留消息数/组数（默认 50） */
  maxMessages?: number;
  /** 真实摘要生成器（提供时调用生成真实摘要，未提供时使用规则占位通知） */
  summarizer?: SummaryGenerator;
  /** 摘要失败时的行为："fallback_notice"（默认，降级为包含失败信息的系统说明）或 "throw"（PI-01 阻塞式失败可见） */
  onFailure?: "fallback_notice" | "throw";
  /** 超大工具结果截断阈值（默认 16384 字符） */
  maxToolResultChars?: number;
  /** 上下文投影选项 */
  projection?: ContextProjectionOptions;
}

/**
 * 规则式与真实摘要上下文压缩端口（ITER-032 / 阶段 5b）。
 * 支持消息条数或配置对象入参，对非系统消息成组保护，超阈值裁剪时按需调用 summarizer。
 */
export function createSummaryCompaction(
  config: number | SummaryCompactionOptions = 50,
): ContextCompactionPort {
  const options: SummaryCompactionOptions =
    typeof config === "number" ? { maxMessages: config } : config;

  const maxMessages = options.maxMessages ?? 50;
  const onFailure = options.onFailure ?? "fallback_notice";

  return {
    async compact(input): Promise<ContextCompactionResult> {
      // 1. 先进行投影与超大结果截断
      const projected = projectContextToModelVisible(input.messages, {
        maxToolResultChars: options.maxToolResultChars,
        ...options.projection,
      });

      const systems = projected.filter((m) => m.role === "system");
      const nonSystems = projected.filter((m) => m.role !== "system");

      // 按工具边界分组（包含 toolCalls 的 assistant 与其 tools 作为一个不可分割原子组）
      const groups = groupMessagesByToolBoundary(nonSystems);

      const totalCount = systems.length + nonSystems.length;
      if (totalCount <= maxMessages) {
        return {
          messages: projected,
          pruningReport: {
            initialMessageCount: totalCount,
            finalMessageCount: totalCount,
            omittedMessageCount: 0,
            omittedGroupsCount: 0,
            pruningTrigger: "none",
            summaryStatus: "skipped",
          },
        };
      }

      // 从后往前保留消息组，确保总消息数（含 systems + 1 条总结说明）不超过 maxMessages
      const keptGroups: PromptMessage[][] = [];
      let count = systems.length + 1; // 预留 1 条通知消息

      for (let i = groups.length - 1; i >= 0; i--) {
        const group = groups[i]!;
        if (count + group.length > maxMessages && keptGroups.length > 0) {
          break;
        }
        keptGroups.unshift(group);
        count += group.length;
      }

      // 确定被省略的消息组
      const keptFlat = keptGroups.flat();
      const omittedGroups = groups.slice(0, groups.length - keptGroups.length);
      const omittedMessages = omittedGroups.flat();

      if (omittedMessages.length === 0) {
        return {
          messages: projected,
          pruningReport: {
            initialMessageCount: totalCount,
            finalMessageCount: totalCount,
            omittedMessageCount: 0,
            omittedGroupsCount: 0,
            pruningTrigger: "none",
            summaryStatus: "skipped",
          },
        };
      }

      const estimateChars = (msgs: PromptMessage[]) =>
        msgs.reduce((acc, m) => acc + (typeof m.content === "string" ? m.content.length : 0), 0);

      const basePruningReport = {
        initialMessageCount: totalCount,
        finalMessageCount: systems.length + 1 + keptFlat.length,
        omittedMessageCount: omittedMessages.length,
        omittedGroupsCount: omittedGroups.length,
        pruningTrigger: "message_count_limit" as const,
        attribution: {
          systemPromptChars: estimateChars(systems),
          omittedChars: estimateChars(omittedMessages),
          keptChars: estimateChars(keptFlat),
        },
      };

      // 2. 真实摘要 vs 规则省略说明
      if (options.summarizer) {
        try {
          input.signal?.throwIfAborted();
          const summaryText = await awaitWithSignal(
            options.summarizer(omittedMessages, {
              signal: input.signal,
              sessionId: input.sessionId,
              turnId: input.turnId,
            }),
            input.signal,
          );

          const summary = summaryText.trim();
          if (!summary) throw new Error("Summary generator returned an empty summary");
          const notice: PromptMessage = {
            role: "system",
            content: `## 会话历史摘要 (Authoritative Context Summary)\n以下为被压缩省略的历史对话真实摘要：\n${summary}`,
          };

          return {
            messages: [...systems, notice, ...keptFlat],
            summary,
            pruningReport: {
              ...basePruningReport,
              summaryStatus: "generated",
            },
          };
        } catch (err) {
          input.signal?.throwIfAborted();
          if (onFailure === "throw") {
            throw new CompactionError(
              `Context compaction summarization failed: ${err instanceof Error ? err.message : String(err)}`,
              err,
            );
          }
          const failMsg = err instanceof Error ? err.message : String(err);
          const notice: PromptMessage = {
            role: "system",
            content: `[Context compaction: ${omittedMessages.length} earlier messages omitted. Summary generation failed (${failMsg}); do not infer missing facts.]`,
          };
          return {
            messages: [...systems, notice, ...keptFlat],
            pruningReport: {
              ...basePruningReport,
              summaryStatus: "failed",
              summaryError: failMsg,
            },
          };
        }
      }

      // 未配置 summarizer 时的标准明确省略通知
      const notice: PromptMessage = {
        role: "system",
        content: `[Context compaction: ${omittedMessages.length} earlier messages omitted. No summary was generated; do not infer missing facts.]`,
      };

      return {
        messages: [...systems, notice, ...keptFlat],
        pruningReport: {
          ...basePruningReport,
          summaryStatus: "rule_notice",
        },
      };
    },
  };
}

// ============ 阶段 5b：统一组合 composer ============

export interface ContextBuilderOptions {
  /** 基础 builder（缺省 defaultContextBuilder） */
  base?: ContextBuilderPort;
  /** 阶段 5a：Inbox 注入 */
  inbox?: boolean;
  /** 基础系统根提示词配置（包含工具使用指引与人设） */
  baseSystemPrompt?: BaseSystemPromptOptions;
  /** ITER-032：伴学保真事实清单（学习目标、错因、偏好、承诺） */
  groundingFacts?: GroundingFacts;
  /** 阶段 5b：Skill 清单（空数组或未提供=不注入） */
  skills?: SkillDescriptor[];
  /** ITER-032：上下文投影配置（隐藏消息、超大工具结果截断、配对防腐） */
  projection?: ContextProjectionOptions;
  /** 阶段 5b：压缩端口（未提供=透传） */
  compaction?: ContextCompactionPort;
}

/**
 * 统一组合 ContextBuilder。
 * 嵌套顺序（外层先执行）：compaction → inbox → skills → groundingFacts → basePrompt → projection/base。
 * 汇总得到的目标顺序：system(base + grounding + skills) 前置 → inbox 追加消息 → 原始历史，
 * 符合 §7.1 Context 组装顺序（根提示词与 Skill 在前，inbox 作为追加输入在后）；
 * 压缩 seam 对全部组装后消息执行。各层可选，缺省零行为倒退。
 */
export function createComposedContextBuilder(
  options: ContextBuilderOptions = {},
): ContextBuilderPort {
  const {
    base = defaultContextBuilder,
    inbox = false,
    baseSystemPrompt,
    groundingFacts,
    skills = [],
    projection,
    compaction = defaultCompactionPort,
  } = options;

  let builder: ContextBuilderPort = base;

  // Base may load authoritative history, so project its complete result.
  if (projection) {
    const inner = builder;
    builder = {
      async build(input) {
        input.signal?.throwIfAborted();
        const context = await awaitWithSignal(Promise.resolve(inner.build(input)), input.signal);
        input.signal?.throwIfAborted();
        return { ...context, messages: projectContextToModelVisible(context.messages, projection) };
      },
    };
  }

  // 1) 基础 System Prompt 注入（最内层，位于 skills 之前）
  if (baseSystemPrompt) {
    const promptText = buildBaseSystemPrompt(baseSystemPrompt);
    const inner = builder;
    builder = {
      build(input) {
        const msgs = input.messages;
        const messages: PromptMessage[] = [{ role: "system", content: promptText }, ...msgs];
        return inner.build({ ...input, messages });
      },
    };
  }

  // 2) ITER-032：保真事实清单（追加在 Base Prompt 后面）
  if (groundingFacts) {
    builder = createGroundingFactsContextBuilder(groundingFacts, builder);
  }

  // 3) 5b：Skill 渐进披露（追加在事实清单后面）
  if (skills.length > 0) {
    builder = createSkillAwareContextBuilder(skills, builder);
  }

  // 4) 5a：inbox 注入（把 inbox 追加消息置于 system 之后、历史之前）
  if (inbox) {
    builder = createInboxAwareContextBuilder(builder);
  }

  // 5) 5b：压缩 seam（最外层：对组装结果统一后处理）
  if (compaction !== defaultCompactionPort) {
    const inner = builder;
    builder = {
      async build(input) {
        input.signal?.throwIfAborted();
        const ctx = await awaitWithSignal(Promise.resolve(inner.build(input)), input.signal);
        input.signal?.throwIfAborted();
        const { messages, pruningReport } = await awaitWithSignal(compaction.compact({
          turnId: ctx.turnId,
          sessionId: ctx.sessionId,
          messages: ctx.messages,
          signal: input.signal,
        }), input.signal);
        return { ...ctx, messages, pruningReport };
      },
    };
  }

  return builder;
}
