/**
 * Aervox｜思隅 @aervox/agent-loop — 上下文组装器
 *
 * 阶段 1 最小实现 + 阶段 5a Inbox 注入 + 阶段 5b（Skill 渐进式披露 / Context 压缩 seam）。
 * §7.1 Context 组装顺序：固定系统安全边界 → Profile/Persona → 安全历史 → 记忆/学习事实/Skill
 * → 工具 schema → 上级工具结果 → 可消费 inbox item；压缩 seam 对组装后的消息执行。
 * Skill 渐进披露：系统提示词仅注入技能「名称 + 描述」，模型按需读取 SKILL.md 全文（省 token）。
 */
import type {
  AgentInboxItem,
  ContextCompactionResult,
  PromptContext,
  PromptMessage,
  SkillDescriptor,
} from "./types.js";
import type { ContextBuilderPort, ContextCompactionPort } from "./ports.js";
import { buildBaseSystemPrompt, type BaseSystemPromptOptions } from "./base-prompt.js";

/** 默认 builder：仅透传原始输入（inbox 项不注入，由宿主按需开启） */
export const defaultContextBuilder: ContextBuilderPort = {
  build(input: {
    turnId: string;
    sessionId: string;
    messages: PromptMessage[];
    inboxItems?: AgentInboxItem[];
  }): PromptContext {
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
    build(input: {
      turnId: string;
      sessionId: string;
      messages: PromptMessage[];
      inboxItems?: AgentInboxItem[];
    }): PromptContext | Promise<PromptContext> {
      const inboxMessages = inboxItemsToMessages(input.inboxItems ?? []);
      const baseInput = {
        turnId: input.turnId,
        sessionId: input.sessionId,
        messages: [...inboxMessages, ...input.messages],
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
    build(input: {
      turnId: string;
      sessionId: string;
      messages: PromptMessage[];
      inboxItems?: AgentInboxItem[];
    }): PromptContext | Promise<PromptContext> {
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

/**
 * 内置规则式摘要压缩（纯粹函数，无外部依赖）。
 * 策略：当消息数 > maxMessages 时保留首 2 条 + 尾 2 条，中部摘要占位。
 * maxMessages 缺省 50，仅在超阈值时触发压缩。
 */
export function createSummaryCompaction(
  maxMessages = 50,
): ContextCompactionPort {
  return {
    async compact(input): Promise<ContextCompactionResult> {
      if (input.messages.length <= maxMessages) {
        return { messages: input.messages };
      }
      const head = input.messages.slice(0, 2);
      const tail = input.messages.slice(-2);
      const summary: PromptMessage = {
        role: "system",
        content: `[Context compaction: ${input.messages.length - 4} messages between the first two and last two were summarized. Total context: ${input.messages.length} messages → ${head.length + tail.length + 1} entries.]`,
      };
      return { messages: [...head, summary, ...tail] };
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
  /** 阶段 5b：Skill 清单（空数组或未提供=不注入） */
  skills?: SkillDescriptor[];
  /** 阶段 5b：压缩端口（未提供=透传） */
  compaction?: ContextCompactionPort;
}

/**
 * 统一组合 ContextBuilder。
 * 嵌套顺序（外层先执行）：compaction → inbox → skills → basePrompt → base。
 * 汇总得到的目标顺序：system(base + skills) 前置 → inbox 追加消息 → 原始历史，
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
    skills = [],
    compaction = defaultCompactionPort,
  } = options;

  let builder: ContextBuilderPort = base;

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

  // 2) 5b：Skill 渐进披露（追加在 Base Prompt 后面）
  if (skills.length > 0) {
    builder = createSkillAwareContextBuilder(skills, builder);
  }

  // 3) 5a：inbox 注入（把 inbox 追加消息置于 system 之后、历史之前）
  if (inbox) {
    builder = createInboxAwareContextBuilder(builder);
  }

  // 4) 5b：压缩 seam（最外层：对组装结果统一后处理）
  if (compaction !== defaultCompactionPort) {
    const inner = builder;
    builder = {
      build(input) {
        return Promise.resolve(inner.build(input)).then(async (ctx) => {
          const { messages } = await compaction.compact({
            turnId: ctx.turnId,
            sessionId: ctx.sessionId,
            messages: ctx.messages,
          });
          return { ...ctx, messages };
        });
      },
    };
  }

  return builder;
}