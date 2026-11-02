/**
 * Aervox｜思隅 @aervox/practice-review — 外部题库导入 SPI（CAP-023）
 *
 * 规范化题库导入与练习同步 Provider Port：JSON/CSV 内联解析与注册表为纯模块，
 * 桌面路由与手机原生运行时共用同一解析语义；插件扩展自定义来源时实现同一端口。
 */

export interface QuestionBankItem {
  prompt: string;
  answer: string;
  explanation?: string;
  options?: string[];
  tags?: string[];
  difficulty?: "easy" | "medium" | "hard";
  sourceRef?: string;
}

export interface QuestionBankProviderPort {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly supportedExtensions: string[];
  parse(content: string | Uint8Array, options?: Record<string, unknown>): Promise<QuestionBankItem[]>;
}

export class QuestionBankRegistry {
  private readonly providers = new Map<string, QuestionBankProviderPort>();

  register(provider: QuestionBankProviderPort): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): QuestionBankProviderPort | undefined {
    return this.providers.get(id);
  }

  list(): Array<{ id: string; name: string; description?: string; supportedExtensions: string[] }> {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      supportedExtensions: p.supportedExtensions,
    }));
  }

  resolveByExtension(filename: string): QuestionBankProviderPort | undefined {
    const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    for (const provider of this.providers.values()) {
      if (provider.supportedExtensions.includes(ext)) {
        return provider;
      }
    }
    return undefined;
  }
}


export class JsonQuestionBankProvider implements QuestionBankProviderPort {
  readonly id = "json-question-bank";
  readonly name = "JSON 题库导入器";
  readonly description = "解析符合 Aervox 标准 JSON 格式的题目与闪卡清单";
  readonly supportedExtensions = [".json"];

  async parse(content: string | Uint8Array): Promise<QuestionBankItem[]> {
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
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


export class CsvQuestionBankProvider implements QuestionBankProviderPort {
  readonly id = "csv-question-bank";
  readonly name = "CSV/TSV 闪卡题库导入器";
  readonly description = "解析逗号或制表符分隔的表格文本，首列为题目，次列为答案，第三列可选为解析";
  readonly supportedExtensions = [".csv", ".tsv", ".txt"];

  async parse(content: string | Uint8Array): Promise<QuestionBankItem[]> {
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
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
