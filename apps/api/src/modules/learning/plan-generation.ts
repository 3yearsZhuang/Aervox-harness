/**
 * Aervox｜思隅 @aervox/api — 学习规划生成核心（参考 OpenMAIC planner 单次结构化生成）
 *
 * 单次 LLM 调用产出完整「规划 + 里程碑 + 任务」路线图：
 * 一次调用 → JSON 解析 → 结构校验（gaps）→ 带 gaps 重试一次 → hydrate（分配 id/order/status）→ 落库。
 * Provider 缝隙：PlanModelPort 由装配层注入——llm 模式走 OpenAI 兼容 provider，
 * replay/scripted 等非 LLM 模式走确定性模板（诚实降级，输出标注 template）。
 */
import { createOpenAICompatProvider } from "@aervox/agent-loop";
import type { ModelProviderPort, ModelRequest } from "@aervox/agent-loop";
import type { AervoxDatabase, TenantContext, LearningPlanModel } from "@aervox/database";
import type { ILearningRepository } from "@aervox/database";
import type { LLMConfigService } from "../llm/service.js";

/** 单次规划生成的模型端口（宿主注入；测试注入确定性实现） */
export interface PlanModelPort {
  generate(input: {
    tenant: TenantContext;
    system: string;
    user: string;
  }): Promise<string>;
}

/** LLM 模式端口：租户配置 → OpenAI 兼容 provider，消费流式输出拼接全文 */
export function createLlmPlanModelPort(llmConfigService: LLMConfigService): PlanModelPort {
  return {
    async generate({ tenant, system, user }) {
      const cfg = await llmConfigService.getConfig(tenant);
      if (!cfg.enabled) throw new Error("llm_disabled: 当前租户未启用 LLM 配置，无法生成学习规划");
      if (cfg.providerType === "anthropic") {
        throw new Error("anthropic_unsupported: 学习规划生成仅支持 OpenAI 兼容协议");
      }
      const provider: ModelProviderPort = createOpenAICompatProvider({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        modelId: cfg.modelId,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      });
      const request: ModelRequest = {
        turnId: "plan_generation",
        attemptId: `plan_${Date.now().toString(36)}`,
        step: 1,
        context: {
          turnId: "plan_generation",
          sessionId: "plan_generation",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
      };
      let text = "";
      for await (const chunk of provider.stream(request)) {
        text += chunk.text ?? "";
      }
      if (!text.trim()) throw new Error("llm_empty_output: 模型未返回学习规划内容");
      return text;
    },
  };
}

const LEVEL_LABELS: Record<string, string> = {
  beginner: "入门（零基础或刚接触）",
  intermediate: "进阶（有基础，想系统提升）",
  advanced: "熟练（扎实基础，想精进突破）",
};

/** 构建规划系统提示词（移植 OpenMAIC planner-system 核心规则并中文化） */
export function buildPlanSystemPrompt(topic: string, level: string, dailyMinutes: number): string {
  const levelLabel = LEVEL_LABELS[level] ?? LEVEL_LABELS.beginner;
  return [
    `你是一位项目式学习（PBL）规划师，为用户设计一份可执行的学习路线图。`,
    `学习主题：${topic}`,
    `用户水平：${levelLabel}`,
    `每日可用学习时间：约 ${dailyMinutes} 分钟（任务粒度要匹配这个时长，单个任务专注 10-30 分钟为宜）。`,
    ``,
    `必须遵守的规则：`,
    `1. 紧扣用户给的主题设计项目与任务，禁止套用与主题无关的通用模板。`,
    `2. 里程碑是「做项目的阶段」（如调研 → 动手实现 → 整合收尾），不是教材章节目录；2-6 个为宜，逐级递进。`,
    `3. 每个里程碑包含 2-4 个任务，任务要具体可做、前后递进，避免空泛（如「了解一下」）。`,
    `4. 每个任务可给 1-3 条 hints：引导思考的提示，不直接给出答案、不代做。`,
    `5. 最后一个里程碑必须是收尾整合阶段（总结产出、串联所学）。`,
    `6. gains 是 3-5 条「完成这份规划能收获什么能力」的面向学习者的表述。`,
    `7. 所有内容使用简体中文，贴合用户水平：入门少术语多类比，熟练可深入细节。`,
    ``,
    `输出格式：只输出一个 JSON 对象，不要任何解释文字、不要代码围栏。结构如下：`,
    `{`,
    `  "title": "项目式学习规划标题",`,
    `  "description": "这个学习项目是什么、为什么这样设计（2-4 句）",`,
    `  "learningObjective": "一句话学习目标",`,
    `  "gains": ["能力收获 1", "能力收获 2", "能力收获 3"],`,
    `  "milestones": [`,
    `    {`,
    `      "title": "里程碑标题",`,
    `      "description": "这个阶段做什么",`,
    `      "briefing": "开始前的简要说明",`,
    `      "completionCriteria": "怎样算完成这个阶段",`,
    `      "debrief": "结束后的回顾要点",`,
    `      "tasks": [`,
    `        { "title": "任务标题", "description": "具体做什么", "hints": ["提示 1"] }`,
    `      ]`,
    `    }`,
    `  ]`,
    `}`,
  ].join("\n");
}

/** 构建规划用户提示词（附结构自检清单，对齐 OpenMAIC single-call 模式） */
export function buildPlanUserPrompt(topic: string, level: string, dailyMinutes: number): string {
  return [
    `请现在为上述主题设计学习路线图，只输出系统提示词描述的单个 JSON 对象——不要散文、不要代码围栏。`,
    ``,
    `输出前对照以下结构自检：`,
    `- title / description / learningObjective 非空，gains 为 3-5 条非空表述`,
    `- milestones 为 2-6 个非空数组，每个含 title、briefing、completionCriteria、debrief 和 2-4 个任务`,
    `- 每个任务有非空 title；最后一个里程碑是收尾整合阶段`,
    ``,
    `主题：${topic}｜水平：${level}｜每日 ${dailyMinutes} 分钟。`,
  ].join("\n");
}

/** 模型输出的 JSON 结构（仅模型决定的字段；id/order/status 由代码 hydrate） */
export interface PlanLLMOutput {
  title?: string;
  description?: string;
  learningObjective?: string;
  gains?: string[];
  milestones?: Array<{
    title?: string;
    description?: string;
    briefing?: string;
    completionCriteria?: string;
    debrief?: string;
    tasks?: Array<{
      title?: string;
      description?: string;
      hints?: string[];
    }>;
  }>;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(toText).filter(Boolean);
}

/** 从模型原始输出提取 JSON：剥离 ```json 围栏，截取首个平衡的 {...} */
export function extractJsonObject(raw: string): unknown {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) text = fenceMatch[1].trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 结构校验：返回人类可读的 gaps 数组（空 = 合法） */
export function validatePlanOutput(parsed: unknown): string[] {
  const gaps: string[] = [];
  if (!parsed || typeof parsed !== "object") {
    return ["输出不是 JSON 对象"];
  }
  const output = parsed as PlanLLMOutput;
  if (!toText(output.title)) gaps.push("title 为空");
  if (!toText(output.description)) gaps.push("description 为空");
  if (!toText(output.learningObjective)) gaps.push("learningObjective 为空");
  const gains = toStringList(output.gains);
  if (gains.length < 3 || gains.length > 5) {
    gaps.push("gains 必须是 3-5 条非空的能力收获");
  }
  const milestones = Array.isArray(output.milestones) ? output.milestones : [];
  if (milestones.length < 2 || milestones.length > 6) {
    gaps.push("milestones 必须是 2-6 个");
  }
  milestones.forEach((m, i) => {
    const label = toText(m?.title) || `#${i + 1}`;
    if (!toText(m?.title)) gaps.push(`里程碑 ${label}: title 为空`);
    if (!toText(m?.briefing)) gaps.push(`里程碑 ${label}: briefing 为空`);
    if (!toText(m?.completionCriteria)) gaps.push(`里程碑 ${label}: completionCriteria 为空`);
    if (!toText(m?.debrief)) gaps.push(`里程碑 ${label}: debrief 为空`);
    const tasks = Array.isArray(m?.tasks) ? m.tasks : [];
    if (tasks.length < 2 || tasks.length > 4) {
      gaps.push(`里程碑 ${label}: 任务数量必须是 2-4 个`);
    }
    tasks.forEach((t, j) => {
      if (!toText(t?.title)) gaps.push(`里程碑 ${label} 任务 #${j + 1}: title 为空`);
    });
  });
  return gaps;
}

let planSeq = 0;
const planId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++planSeq).toString(36)}`;

/** hydrate：分配 id / order / 初始状态（首里程碑 active，其余 locked；任务全 todo） */
export function hydratePlan(
  parsed: PlanLLMOutput,
  input: { topic: string; level: string; dailyMinutes: number },
): {
  id: string;
  topic: string;
  level: string;
  title: string;
  description: string;
  learningObjective: string;
  gains: string[];
  dailyAvailableMinutes: number;
  milestones: Array<{
    id: string;
    title: string;
    description?: string;
    briefing?: string;
    completionCriteria?: string;
    debrief?: string;
    tasks: Array<{ id: string; title: string; description?: string; hints?: string[] }>;
  }>;
} {
  return {
    id: planId("plan"),
    topic: input.topic,
    level: input.level,
    title: toText(parsed.title),
    description: toText(parsed.description),
    learningObjective: toText(parsed.learningObjective),
    gains: toStringList(parsed.gains),
    dailyAvailableMinutes: input.dailyMinutes,
    milestones: (Array.isArray(parsed.milestones) ? parsed.milestones : []).map((m) => ({
      id: planId("ms"),
      title: toText(m?.title),
      description: toText(m?.description) || undefined,
      briefing: toText(m?.briefing) || undefined,
      completionCriteria: toText(m?.completionCriteria) || undefined,
      debrief: toText(m?.debrief) || undefined,
      tasks: (Array.isArray(m?.tasks) ? m.tasks : []).map((t) => ({
        id: planId("mt"),
        title: toText(t?.title),
        description: toText(t?.description) || undefined,
        hints: toStringList(t?.hints),
      })),
    })),
  };
}

/** 非 LLM 模式（replay/scripted）确定性模板规划：3 里程碑 × 2 任务，不冒充模型生成 */
export function renderTemplatePlan(
  input: { topic: string; level: string; dailyMinutes: number },
): PlanLLMOutput {
  const topic = input.topic;
  return {
    title: `${topic} 项目式学习`,
    description: `围绕「${topic}」的项目式学习路线：先认识与准备，再动手实践，最后整合收尾。按每日约 ${input.dailyMinutes} 分钟的节奏推进。`,
    learningObjective: `通过完成一个小项目，建立「${topic}」的完整知识框架并产出可展示的成果。`,
    gains: [
      `掌握「${topic}」的核心概念与常用方法`,
      "获得把想法拆解为可执行小任务的习惯",
      "积累一个可展示的完整项目成果",
    ],
    milestones: [
      {
        title: "阶段一：认识与准备",
        description: "了解主题全貌，准备所需环境与资料。",
        briefing: "先弄清楚要学什么、用什么工具，不急着动手。",
        completionCriteria: "能用自己的话说清主题的核心概念，并搭好学习环境。",
        debrief: "回顾：哪些概念还模糊？记下来带到下一阶段。",
        tasks: [
          {
            title: `调研「${topic}」：它解决什么问题、包含哪些核心概念`,
            description: "阅读入门资料，整理 5-8 个关键概念的清单。",
            hints: ["优先找面向初学者的概述材料", "用一句话解释每个概念"],
          },
          {
            title: "准备学习环境与实践素材",
            description: "安装所需工具，收集后续动手阶段要用的资料或数据。",
            hints: ["列出工具清单逐项核对", "找一个最小可用的练习素材"],
          },
        ],
      },
      {
        title: "阶段二：动手实践",
        description: "以小任务推进核心练习，遇到卡点及时记录。",
        briefing: "边做边学，做不出来再回头看概念。",
        completionCriteria: "完成核心练习并记录了至少 3 个卡点与解决方式。",
        debrief: "回顾：哪个任务收获最大？哪个还不熟？",
        tasks: [
          {
            title: "完成一个核心小练习",
            description: "围绕主题最核心的技能点做一个完整的小练习。",
            hints: ["先做最小版本再迭代", "卡住超过 20 分钟就记录下来换下一个"],
          },
          {
            title: "整理练习笔记与错题",
            description: "把练习中的关键步骤、易错点整理成笔记。",
            hints: ["用自己的话复述步骤", "易错点标注触发条件"],
          },
        ],
      },
      {
        title: "阶段三：整合收尾",
        description: "串联所学，产出一份完整的成果。",
        briefing: "把前面的练习整合成一个能拿得出手的东西。",
        completionCriteria: "产出一份整合成果（作品/文档/分享），并完成自评。",
        debrief: "回顾整个路线：下一步想深入什么？",
        tasks: [
          {
            title: "整合一个完整成果",
            description: "把各阶段练习整合为一个小项目或一份体系化文档。",
            hints: ["成果里体现每个阶段的关键收获", "优先完整性而非复杂度"],
          },
          {
            title: "自评与规划下一步",
            description: "对照 gains 自评掌握程度，列出下一步学习清单。",
            hints: ["每条 gain 给自己打分并说明依据", "下一步清单控制在 3 条以内"],
          },
        ],
      },
    ],
  };
}

export interface LearningPlanGenerationResult {
  plan: LearningPlanModel;
  generatedBy: "llm" | "template";
}

export class LearningPlanGenerationService {
  constructor(
    private readonly deps: {
      db: AervoxDatabase;
      learningRepo: ILearningRepository;
      model: PlanModelPort;
    },
  ) {}

  /** 生成学习规划并落库（单次调用 → 校验 → 带 gaps 重试一次 → hydrate → 事务写入） */
  async generate(
    tenant: TenantContext,
    input: { topic: string; level?: string; dailyMinutes?: number },
  ): Promise<LearningPlanGenerationResult> {
    const level = input.level ?? "beginner";
    const dailyMinutes = input.dailyMinutes ?? 25;

    const mode = process.env.AERVOX_LOOP_PROVIDER ?? "llm";
    if (mode !== "llm") {
      const template = renderTemplatePlan({ topic: input.topic, level, dailyMinutes });
      const hydrated = hydratePlan(template, { topic: input.topic, level, dailyMinutes });
      const plan = await this.deps.learningRepo.createLearningPlan(tenant, hydrated);
      return { plan, generatedBy: "template" };
    }

    const system = buildPlanSystemPrompt(input.topic, level, dailyMinutes);
    const basePrompt = buildPlanUserPrompt(input.topic, level, dailyMinutes);

    const attempt = async (prompt: string): Promise<unknown> => {
      const raw = await this.deps.model.generate({ tenant, system, user: prompt });
      return extractJsonObject(raw);
    };

    // 第一次尝试
    let parsed = await attempt(basePrompt);
    let gaps = validatePlanOutput(parsed);

    // 带 gaps 定向重试一次（OpenMAIC 模式）
    if (gaps.length > 0) {
      const retryPrompt = [
        basePrompt,
        ``,
        `你上一次的输出存在以下问题：`,
        ...gaps.map((gap) => `- ${gap}`),
        ``,
        `请修正全部问题后重新输出完整的单个 JSON 对象。`,
      ].join("\n");
      parsed = await attempt(retryPrompt);
      gaps = validatePlanOutput(parsed);
    }

    if (!parsed || gaps.length > 0) {
      throw new Error(`plan_generation_failed: 模型未能产出有效的学习规划（${gaps.join("；")}）`);
    }

    const hydrated = hydratePlan(parsed as PlanLLMOutput, {
      topic: input.topic,
      level,
      dailyMinutes,
    });
    const plan = await this.deps.learningRepo.createLearningPlan(tenant, hydrated);
    return { plan, generatedBy: "llm" };
  }
}
