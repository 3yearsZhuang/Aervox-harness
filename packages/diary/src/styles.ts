/**
 * Aervox｜思隅 @aervox/diary — 日记风格与复盘提炼 SPI (CAP-008/017)
 *
 * 将日记生成风格与系统底层解耦，支持第三方或不同场景注册专用的日记 Prompt 与模板：
 * - companion: 桌宠亲密随笔（思思第一人称，情感陪伴，默认）
 * - growth: 学习与认知复盘（聚焦目标推进、练习正答率、错因与沉淀）
 * - concise: 极简量化记录（高信息密度事实与指标清单）
 */
import type { DiaryMaterial } from "./material.js";
import { buildDiarySystemPrompt, buildDiaryUserPrompt } from "./prompts.js";

export interface DiaryStyle {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly targetScene: "companion" | "learning" | "productivity" | "general";

  /** 构建 LLM 系统提示词 */
  buildSystemPrompt(assistantName: string): string;

  /** 构建 LLM 用户提示词 */
  buildUserPrompt(material: DiaryMaterial, localDate: string, focus?: string): string;

  /** 确定性模板日记渲染（非 LLM 或服务降级时使用） */
  renderTemplate(material: DiaryMaterial, localDate: string): { title: string; content: string };
}

/** 桌宠亲密随笔风格（思思第一人称，默认） */
export const companionStyle: DiaryStyle = {
  id: "companion",
  name: "桌宠亲密随笔",
  description: "以桌宠第一人称记录当天的互动与陪伴感受，自然温暖，口语化随笔",
  targetScene: "companion",

  buildSystemPrompt(assistantName: string): string {
    return buildDiarySystemPrompt(assistantName);
  },

  buildUserPrompt(material: DiaryMaterial, localDate: string, focus?: string): string {
    return buildDiaryUserPrompt(material, localDate, focus);
  },

  renderTemplate(material: DiaryMaterial, localDate: string): { title: string; content: string } {
    const lines: string[] = [`标题：${localDate} 的日记`, ""];
    const { messages, memories, goals, attemptsToday } = material;
    if (messages.length > 0) {
      lines.push(`今天我们聊了 ${messages.length} 句话，我都记着呢。`);
    } else {
      lines.push(`今天我们还没怎么说话，明天记得来找我呀。`);
    }
    if (memories.length > 0) {
      lines.push(`今天我还悄悄记下了 ${memories.length} 件与你有关的事。`);
    }
    if (attemptsToday.total > 0) {
      lines.push(
        `你今天练习了 ${attemptsToday.total} 道题，答对了 ${attemptsToday.correct} 道。`,
      );
    }
    if (goals.length > 0) {
      lines.push(`你在学的有：${goals.map((g) => g.topic).join("、")}。`);
    }
    lines.push("", "（本篇为非 LLM 模式的模板日记，配置 LLM 后将由思思亲手书写。）");
    return {
      title: `${localDate} 的日记`,
      content: lines.join("\n"),
    };
  },
};

/** 学习与认知复盘风格 */
export const growthStyle: DiaryStyle = {
  id: "growth",
  name: "认知与学习复盘",
  description: "聚焦当日答题练习、学习目标推进与知识掌握反思，条理清晰的沉淀报告",
  targetScene: "learning",

  buildSystemPrompt(assistantName: string): string {
    return [
      `你是 ${assistantName}，Aervox 的智能学习伴侣。`,
      `你正在为用户生成一份深入、客观且富有建设性的「今日学习与认知复盘」。`,
      "",
      "必须遵守的规则：",
      "1. 严格基于素材中的事实（练习题数、正确率、对话探讨的技术点、学习目标）。绝不虚构未发生的练习或成绩。",
      "2. 突出学习成效与卡点分析：肯定掌握良好的领域，指出需要巩固的盲区。",
      "3. 语气保持理智、鼓励且专业，避免空洞口号。",
      "4. 输出格式：第一行为「标题：<复盘标题>」，随后空一行，正文包含【今日学情回顾】、【关键认知沉淀】、【明日专注建议】3 个结构化段落。",
    ].join("\n");
  },

  buildUserPrompt(material: DiaryMaterial, localDate: string, focus?: string): string {
    const base = buildDiaryUserPrompt(material, localDate, focus);
    return `${base}\n\n请以学习教练与认知复盘视角展开，重点提炼知识收获与薄弱点。`;
  },

  renderTemplate(material: DiaryMaterial, localDate: string): { title: string; content: string } {
    const lines: string[] = [`标题：${localDate} 学习复盘`, ""];
    const { goals, attemptsToday, memories } = material;

    lines.push("【今日学情回顾】");
    if (attemptsToday.total > 0) {
      const accuracy = Math.round((attemptsToday.correct / attemptsToday.total) * 100);
      lines.push(`完成练习 ${attemptsToday.total} 题，答对 ${attemptsToday.correct} 题（准确率 ${accuracy}%）。`);
    } else {
      lines.push("今日暂无答题记录。");
    }

    lines.push("", "【进行中目标】");
    if (goals.length > 0) {
      for (const g of goals) {
        lines.push(`- ${g.topic}（等级: ${g.level}，状态: ${g.status}）`);
      }
    } else {
      lines.push("暂无活跃学习目标。");
    }

    if (memories.length > 0) {
      lines.push("", "【知识与事件记录】");
      for (const m of memories.slice(0, 5)) {
        lines.push(`- [${m.category}] ${m.content}`);
      }
    }

    lines.push("", "（本篇为非 LLM 模式的模板复盘，配置 LLM 后将由思思亲手生成深度洞察。）");
    return {
      title: `${localDate} 学习复盘`,
      content: lines.join("\n"),
    };
  },
};

/** 极简量化记录风格 */
export const conciseStyle: DiaryStyle = {
  id: "concise",
  name: "极简量化记录",
  description: "以高信息密度、极简要点列表呈现当日关键活动与指标",
  targetScene: "productivity",

  buildSystemPrompt(assistantName: string): string {
    return [
      `你是 ${assistantName} 的极简记录模块。`,
      "请将用户今天发生的所有活动浓缩为 3-5 条简练的要点事实（Bullet Points）。",
      "严禁煽情、严禁废话、严禁虚构。只保留核心数据与动作。",
      "输出格式：第一行为「标题：<极简标题>」，随后空一行，使用 Markdown 无序列表输出。",
    ].join("\n");
  },

  buildUserPrompt(material: DiaryMaterial, localDate: string, focus?: string): string {
    return buildDiaryUserPrompt(material, localDate, focus);
  },

  renderTemplate(material: DiaryMaterial, localDate: string): { title: string; content: string } {
    const lines: string[] = [`标题：${localDate} 极简记录`, ""];
    const { messages, memories, attemptsToday, goals } = material;

    lines.push(`- 对话交互：${messages.length} 条记录`);
    lines.push(`- 记忆捕捉：${memories.length} 条事实`);
    lines.push(`- 题目练习：${attemptsToday.correct}/${attemptsToday.total} 达标`);
    if (goals.length > 0) {
      lines.push(`- 目标领域：${goals.map((g) => g.topic).join(", ")}`);
    }

    lines.push("", "（极简量化模板记录）");
    return {
      title: `${localDate} 极简记录`,
      content: lines.join("\n"),
    };
  },
};

/** 日记风格注册表 */
export class DiaryStyleRegistry {
  private readonly styles = new Map<string, DiaryStyle>();
  private defaultStyleId = "companion";

  constructor() {
    this.register(companionStyle);
    this.register(growthStyle);
    this.register(conciseStyle);
  }

  register(style: DiaryStyle): void {
    this.styles.set(style.id, style);
  }

  get(id: string): DiaryStyle | undefined {
    return this.styles.get(id);
  }

  getDefault(): DiaryStyle {
    return this.styles.get(this.defaultStyleId) ?? companionStyle;
  }

  setDefault(id: string): void {
    if (!this.styles.has(id)) {
      throw new Error(`Style not registered: ${id}`);
    }
    this.defaultStyleId = id;
  }

  list(): DiaryStyle[] {
    return Array.from(this.styles.values());
  }
}

export const defaultDiaryStyleRegistry = new DiaryStyleRegistry();
