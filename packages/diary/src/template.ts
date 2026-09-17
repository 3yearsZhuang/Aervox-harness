/**
 * Aervox｜思隅 @aervox/diary — 非 LLM 模板日记（诚实降级）
 *
 * 确定性渲染，仅使用 collectDiaryMaterial 采集的真实素材；输出标注 generatedBy=template。
 */
import { diaryMaterialCount, type DiaryMaterial } from "./material.js";
import { defaultDiaryStyleRegistry } from "./styles.js";

export interface DiaryDraft {
  title: string;
  content: string;
  generatedBy: "llm" | "template";
  materialCount: number;
}

/** 非 LLM 模式的模板日记（确定性、诚实标注生成方式，支持按风格渲染） */
export function renderTemplateDiary(
  material: DiaryMaterial,
  localDate: string,
  styleId?: string,
): DiaryDraft {
  const style =
    (styleId ? defaultDiaryStyleRegistry.get(styleId) : undefined) ??
    defaultDiaryStyleRegistry.getDefault();
  const rendered = style.renderTemplate(material, localDate);

  return {
    title: rendered.title,
    content: rendered.content,
    generatedBy: "template" as const,
    materialCount: diaryMaterialCount(material),
  };
}