/**
 * Aervox｜思隅 @aervox/contracts — 日记「模板生成」标记的唯一来源。
 *
 * 该标记被拼进模板日记正文，随后由三个读取点反推 `generatedBy`：工作台卡片投影、
 * 宿主日记应用服务、移动端本地日记。它们此前各自硬编码同一段文案。若产出方改文案
 * 而某一读取点未同步，该条日记会被静默判成 LLM 生成并显示为「思思手写」，
 * 不报任何错误。因此标记与判定函数只能在此处维护。
 */

/** 模板日记正文中的标记前缀；产出方拼在结尾说明里，读取方据此判定来源。 */
export const DIARY_TEMPLATE_MARKER = "（本篇为非 LLM 模式的模板日记";

/** 由日记正文判定其生成来源；无法匹配标记即视为 LLM 生成。 */
export function detectDiaryGeneratedBy(content: string): "llm" | "template" {
  return content.includes(DIARY_TEMPLATE_MARKER) ? "template" : "llm";
}
