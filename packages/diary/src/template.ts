/**
 * Aervox｜思隅 @aervox/diary — 非 LLM 模板日记（诚实降级）
 *
 * 确定性渲染，仅使用 collectDiaryMaterial 采集的真实素材；输出标注 generatedBy=template。
 */
import { diaryMaterialCount, type DiaryMaterial } from "./material.js";

export interface DiaryDraft {
  title: string;
  content: string;
  generatedBy: "llm" | "template";
  materialCount: number;
}

/** 非 LLM 模式的模板日记（确定性、诚实标注生成方式） */
export function renderTemplateDiary(material: DiaryMaterial, localDate: string): DiaryDraft {
  const lines: string[] = [`标题：${localDate} 的日记`, ``];
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
  lines.push(``, `（本篇为非 LLM 模式的模板日记，配置 LLM 后将由思思亲手书写。）`);
  return {
    title: `${localDate} 的日记`,
    content: lines.join("\n"),
    generatedBy: "template" as const,
    materialCount: diaryMaterialCount(material),
  };
}