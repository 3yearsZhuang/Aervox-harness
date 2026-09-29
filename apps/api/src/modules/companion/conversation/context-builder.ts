/**
 * Aervox｜思隅 @aervox/api — 回合上下文构建与记忆装配 (Context Builder Assembly)
 *
 * 依据 ADR-020 / ITER-026：
 * 将会话历史检索、记忆召回、渐进式 Skill 披露、主动智能画像注入与规则压缩
 * 从 agent-executor.ts 编排主循环中解耦，形成独立的上下文构建装配器。
 */
import {
  createComposedContextBuilder,
  createSummaryCompaction,
  type ContextBuilderPort,
  type SkillDescriptor,
  type ToolSpec,
} from "@aervox/agent-loop";
import { loadApiConfig } from "@aervox/config";
import type {
  LocalContext,
  SqliteConversationRepository,
} from "@aervox/repositories";
import { buildMemoryContext, type MemoryRecallPort } from "./memory-recall.js";

export interface ConversationContextBuilderOptions {
  repo: SqliteConversationRepository;
  tenant: LocalContext;
  input: {
    sessionId: string;
    turnId: string;
    userMessage: string;
  };
  tools?: { tools?: ToolSpec[] };
  persona?: {
    name?: string;
    prompt?: string;
    allowedSkillNames?: string[];
  };
  skills?: SkillDescriptor[];
  memoryRecall?: MemoryRecallPort;
  proactiveProfilePrompt?: string;
  extraSections?: string[];
}

/**
 * 组装单回合 Agent Loop 的 ContextBuilderPort：
 * 1. 历史检索 (getSessionHistory) 与记忆召回 (memoryRecall) 并行化加载；
 * 2. 注入基础系统提示词 (baseSystemPrompt) 与当前角色设定 (persona)；
 * 3. 技能根据人格白名单渐进披露 (skills)；
 * 4. 规则压缩 (rule-based compaction)；
 * 5. 主动智能画像动态提示词切面注入。
 */
export function assembleConversationContextBuilder(
  options: ConversationContextBuilderOptions,
): ContextBuilderPort {
  const {
    repo,
    tenant,
    input,
    tools,
    persona,
    skills,
    memoryRecall,
    proactiveProfilePrompt,
    extraSections,
  } = options;

  const personaAllowedSkills = persona?.allowedSkillNames;
  const disclosedSkills =
    personaAllowedSkills && skills
      ? skills.filter((s) => personaAllowedSkills.includes(s.name))
      : skills;

  let history: ReturnType<SqliteConversationRepository["getSessionHistory"]> | undefined;
  let memoryContext: Promise<string | null> | undefined;

  let contextBuilder = createComposedContextBuilder({
    base: {
      async build(context) {
        history ??= repo.getSessionHistory(tenant, {
          sessionId: input.sessionId,
          beforeTurnId: input.turnId,
        });
        memoryContext ??= memoryRecall
          ? memoryRecall
              .recall(tenant, input.userMessage)
              .then(buildMemoryContext)
              .catch(() => null)
          : Promise.resolve(null);
        const [previous, recalled] = await Promise.all([history, memoryContext]);
        const index = context.messages.findIndex((message) => message.role !== "system");
        const insertion = index < 0 ? context.messages.length : index;
        return {
          turnId: context.turnId,
          sessionId: context.sessionId,
          messages: [
            ...context.messages.slice(0, insertion),
            ...previous,
            ...(recalled ? [{ role: "system" as const, content: recalled }] : []),
            ...context.messages.slice(insertion),
          ],
        };
      },
    },
    baseSystemPrompt: {
      assistantName: persona?.name || "思隅 (Aervox)",
      personaPrompt: persona?.prompt,
      activeTools: tools?.tools,
      extraSections: extraSections ?? [],
    },
    skills: disclosedSkills,
    ...(loadApiConfig().loopCompaction === "rule"
      ? { compaction: createSummaryCompaction() }
      : {}),
  });

  if (proactiveProfilePrompt) {
    const inner = contextBuilder;
    contextBuilder = {
      async build(builderInput) {
        const context = await inner.build(builderInput);
        const messages = [...context.messages];
        const insertionIndex = messages.findIndex((message) => message.role !== "system");
        messages.splice(insertionIndex < 0 ? messages.length : insertionIndex, 0, {
          role: "system",
          content: proactiveProfilePrompt,
        });
        return { ...context, messages };
      },
    };
  }

  return contextBuilder;
}
