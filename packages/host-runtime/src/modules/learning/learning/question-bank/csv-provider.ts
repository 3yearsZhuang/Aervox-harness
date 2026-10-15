/**
 * Aervox｜思隅 @aervox/api — CSV/TSV 格式题库/闪卡解析器（兼容 Anki 文本导出）
 */
import type { QuestionBankItem, QuestionBankProviderPort } from "./provider-port.js";

export class CsvQuestionBankProvider implements QuestionBankProviderPort {
  readonly id = "csv-question-bank";
  readonly name = "CSV/TSV 闪卡题库导入器";
  readonly description = "解析逗号或制表符分隔的表格文本，首列为题目，次列为答案，第三列可选为解析";
  readonly supportedExtensions = [".csv", ".tsv", ".txt"];

  async parse(content: string | Buffer): Promise<QuestionBankItem[]> {
    const text = typeof content === "string" ? content : content.toString("utf8");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

    if (lines.length === 0) return [];

    // 检测分隔符：制表符优先，其次逗号（基于首个非注释行）
    const firstDataLine = lines.find((l) => !l.startsWith("#")) ?? lines[0] ?? "";
    const delimiter = firstDataLine.includes("\t") ? "\t" : ",";

    const result: QuestionBankItem[] = [];
    let isFirstDataRow = true;

    for (const line of lines) {
      // 跳过注释行
      if (line.startsWith("#")) continue;

      const cols = line.split(delimiter).map((col) => col.trim().replace(/^["']|["']$/g, ""));
      if (cols.length < 2) continue;

      const promptCol = cols[0];
      const answerCol = cols[1];
      if (!promptCol || !answerCol) continue;

      // 智能跳过表头
      if (isFirstDataRow) {
        isFirstDataRow = false;
        if (["question", "prompt", "题目", "正面"].includes(promptCol.toLowerCase())) {
          continue;
        }
      }

      const prompt = promptCol;
      const answer = answerCol;

      const explanation = cols[2] && cols[2].length > 0 ? cols[2] : undefined;
      const tags = cols[3] && cols[3].length > 0 ? cols[3].split(/[; ]+/).filter(Boolean) : undefined;

      result.push({
        prompt,
        answer,
        explanation,
        tags,
      });
    }

    return result;
  }
}
