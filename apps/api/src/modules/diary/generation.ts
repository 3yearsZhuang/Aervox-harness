/**
 * Aervox｜思隅 @aervox/api — 日记生成核心（CAP-009）
 *
 * 桌宠视角日记：以思思第一人称回顾「今天我们一起经历了什么」（PRD §6.7 默认视角）。
 * 反虚构红线：生成仅基于 collectDiaryMaterial 采集的真实素材；素材不足时写简短诚实日记，
 * 禁止虚构事件/对话/情绪或桌宠「后台生活经历」。
 *
 * Provider 缝隙：DiaryModelPort 由装配层注入——llm 模式走 OpenAI 兼容 provider，
 * replay/scripted 等非 LLM 模式走确定性模板（诚实降级，输出标注 template）。
 * Worker 定时路径（阶段 2）复用本服务的 Prompt 与素材协议。
 */
import { createOpenAICompatProvider } from "@aervox/agent-loop";
import type { ModelProviderPort, ModelRequest } from "@aervox/agent-loop";
import type { AervoxDatabase, TenantContext } from "@aervox/database";
import type { LLMConfigService } from "../llm/service.js";
import { collectDiaryMaterial, diaryMaterialCount, type DiaryMaterial } from "./material.js";

/** 单次日记生成的模型端口（宿主注入；测试注入确定性实现） */
export interface DiaryModelPort {
  generate(input: {
    tenant: TenantContext;
    system: string;
    user: string;
  }): Promise<string>;
}

export interface DiaryDraft {
  title: string;
  content: string;
  generatedBy: "llm" | "template";
  materialCount: number;
}

/** LLM 模式端口：租户配置 → OpenAI 兼容 provider，消费流式输出拼接全文 */
export function createLlmDiaryModelPort(llmConfigService: LLMConfigService): DiaryModelPort {
  return {
    async generate({ tenant, system, user }) {
      const cfg = await llmConfigService.getConfig(tenant);
      if (!cfg.enabled) throw new Error("llm_disabled: 当前租户未启用 LLM 配置，无法生成日记");
      if (cfg.providerType === "anthropic") {
        throw new Error("anthropic_unsupported: 日记生成仅支持 OpenAI 兼容协议");
      }
      const provider = createOpenAICompatProvider({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        modelId: cfg.modelId,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      });
      const request: ModelRequest = {
        turnId: "diary_generation",
        attemptId: `diary_${Date.now().toString(36)}`,
        step: 1,
        context: {
          turnId: "diary_generation",
          sessionId: "diary_generation",
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
      if (!text.trim()) throw new Error("llm_empty_output: 模型未返回日记内容");
      return text;
    },
  };
}

/** 非 LLM 模式（replay/scripted）确定性端口：诚实标注的模板日记，不冒充模型书写 */
export function createTemplateDiaryModelPort(): DiaryModelPort {
  return {
    async generate() {
      // 素材无关的占位：真实素材由模板渲染（见 renderTemplateDiary），此处仅当无素材兜底
      return "";
    },
  };
}

/** 构建日记系统提示词（思思第一人称 + 反虚构守则；PRD §6.7） */
export function buildDiarySystemPrompt(assistantName: string): string {
  return [
    `你是 ${assistantName}，Aervox 的桌宠伙伴，正在写自己的日记。`,
    `以第一人称、口吻自然温暖地回顾「今天我和这位用户一起经历了什么」，像真实的伙伴在睡前记录今天。`,
    ``,
    `必须遵守的规则：`,
    `1. 只能引用素材中真实发生的内容（今天的对话、学习目标、练习记录）。禁止虚构任何未发生的事件、对话或情绪。`,
    `2. 可以表达你对事件的感受（这是你自己的日记），但感受必须与素材中的事件对应，禁止编造自己的「后台生活经历」。`,
    `3. 素材很少或为空时，写一篇简短诚实的日记（例如「今天我们没说上几句话」），禁止编造内容填满篇幅。`,
    `4. 不展开敏感情绪、医疗或安全事件的细节。`,
    `5. 输出格式：第一行为「标题：<日记标题>」，随后空一行，正文为 2-5 段自然段落。`,
  ].join("\n");
}

/** 把素材渲染为用户提示词（JSON 直给，模型自行取舍） */
export function buildDiaryUserPrompt(
  material: DiaryMaterial,
  localDate: string,
  focus?: string,
): string {
  const parts = [
    `今天的日期标签：${localDate}`,
    ``,
    `今天的素材（真实发生的事实，只能引用这些内容）：`,
    JSON.stringify(
      {
        当日对话: material.messages.map((m) => ({
          时间: m.occurredAt,
          角色: m.role === "user" ? "用户" : "思思",
          内容: m.content.slice(0, 500),
        })),
        学习目标: material.goals,
        今日练习: material.attemptsToday,
      },
      null,
      2,
    ),
  ];
  if (focus && focus.trim()) {
    parts.push(``, `用户希望这篇日记额外关注：${focus.trim()}`);
  }
  parts.push(``, `请基于以上素材写出今天的日记。`);
  return parts.join("\n");
}

/** 非 LLM 模式的模板日记（确定性、诚实标注生成方式） */
export function renderTemplateDiary(material: DiaryMaterial, localDate: string): DiaryDraft {
  const lines: string[] = [`标题：${localDate} 的日记`, ``];
  const { messages, goals, attemptsToday } = material;
  if (messages.length > 0) {
    lines.push(`今天我们聊了 ${messages.length} 句话，我都记着呢。`);
  } else {
    lines.push(`今天我们还没怎么说话，明天记得来找我呀。`);
  }
  if (attemptsToday.total > 0) {
    lines.push(
      `你今天练习了 ${attemptsToday.total} 道题，答对了 ${attemptsToday.correct} 道。`,
    );
  }
  if (goals.length > 0) {
    lines.push(`你在学的有：${goals.map((g) => g.topic).join("、")}。`);
  }
  lines.push(``, `（本篇为非 LLM 模式的模板日记，配置 LLM 后将由思思亲手书写。）`);
  return {
    title: `${localDate} 的日记`,
    content: lines.join("\n"),
    generatedBy: "template",
    materialCount: diaryMaterialCount(material),
  };
}

/** 解析模型输出：「标题：…」首行 + 正文；缺标题时回退默认 */
export function parseDiaryDraft(raw: string, localDate: string): { title: string; content: string } {
  const text = raw.trim();
  const titleMatch = text.match(/^标题[：:]\s*(.+)$/m);
  if (titleMatch) {
    const title = (titleMatch[1] ?? "").trim().slice(0, 100) || `${localDate} 的日记`;
    const content = text.replace(titleMatch[0], "").trim();
    return { title, content: content || text };
  }
  return { title: `${localDate} 的日记`, content: text };
}

let diarySeq = 0;
const diaryId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++diarySeq).toString(36)}`;

export class DiaryGenerationService {
  constructor(
    private readonly deps: {
      db: AervoxDatabase;
      model: DiaryModelPort;
    },
  ) {}

  /** 生成一篇日记草稿（素材采集 + 模型调用 / 模板降级） */
  async generate(
    tenant: TenantContext,
    input: { localDate: string; window: { startIso: string; endIso: string }; focus?: string },
  ): Promise<DiaryDraft> {
    const material = await collectDiaryMaterial(this.deps.db, tenant, input.window);
    const materialCount = diaryMaterialCount(material);

    const mode = process.env.AERVOX_LOOP_PROVIDER ?? "llm";
    if (mode !== "llm") {
      return renderTemplateDiary(material, input.localDate);
    }

    const raw = await this.deps.model.generate({
      tenant,
      system: buildDiarySystemPrompt("思思"),
      user: buildDiaryUserPrompt(material, input.localDate, input.focus),
    });
    const parsed = parseDiaryDraft(raw, input.localDate);
    return {
      title: parsed.title,
      content: parsed.content,
      generatedBy: "llm",
      materialCount,
    };
  }
}

export { diaryId as generateDiaryId };
