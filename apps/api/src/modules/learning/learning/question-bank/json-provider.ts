/**
 * Aervox｜思隅 @aervox/api — JSON 格式题库解析器
 */
import type { QuestionBankItem, QuestionBankProviderPort } from "./provider-port.js";

export class JsonQuestionBankProvider implements QuestionBankProviderPort {
  readonly id = "json-question-bank";
  readonly name = "JSON 题库导入器";
  readonly description = "解析符合 Aervox 标准 JSON 格式的题目与闪卡清单";
  readonly supportedExtensions = [".json"];

  async parse(content: string | Buffer): Promise<QuestionBankItem[]> {
    const text = typeof content === "string" ? content : content.toString("utf8");
    const data = JSON.parse(text);

    const items: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray(data.questions)
        ? data.questions
        : Array.isArray(data.items)
          ? data.items
          : [];

    const result: QuestionBankItem[] = [];

    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const prompt = String(record.prompt ?? record.question ?? "").trim();
      const answer = String(record.answer ?? record.solution ?? "").trim();
      if (!prompt || !answer) continue;

      const explanation = record.explanation !== undefined ? String(record.explanation).trim() : undefined;
      const difficulty = ["easy", "medium", "hard"].includes(String(record.difficulty))
        ? (record.difficulty as "easy" | "medium" | "hard")
        : undefined;
      const tags = Array.isArray(record.tags)
        ? record.tags.map(String).filter(Boolean)
        : undefined;

      result.push({
        prompt,
        answer,
        explanation,
        difficulty,
        tags,
        sourceRef: typeof record.sourceRef === "string" ? record.sourceRef : undefined,
      });
    }

    return result;
  }
}
