/**
 * Aervox｜思隅 @aervox/api — 外部题库与练习同步 Provider Port (CAP-023)
 *
 * 规范化题库导入与同步 SPI，支持 Anki、CSV/TSV、JSON 题库格式，
 * 支持插件扩展自定义题库来源（如 LeetCode、Quizlet 等）。
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
  parse(content: string | Buffer, options?: Record<string, unknown>): Promise<QuestionBankItem[]>;
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
