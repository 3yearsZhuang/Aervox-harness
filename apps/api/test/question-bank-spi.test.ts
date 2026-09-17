import { describe, it, expect, beforeEach } from "vitest";
import {
  QuestionBankRegistry,
  JsonQuestionBankProvider,
  CsvQuestionBankProvider,
  type QuestionBankProviderPort,
} from "../src/modules/learning/learning/question-bank/index.js";
import { buildApp } from "../src/app.js";
import { createInMemoryDatabase } from "@aervox/repositories";

describe("QuestionBank SPI (外部题库与练习同步, CAP-023)", () => {
  it("JSON 题库解析器正确解析格式化题目与闪卡", async () => {
    const provider = new JsonQuestionBankProvider();
    const jsonContent = JSON.stringify({
      questions: [
        {
          prompt: "What does WAL stand for in SQLite?",
          answer: "Write-Ahead Logging",
          explanation: "WAL enables concurrent readers alongside a writer.",
          difficulty: "medium",
          tags: ["sqlite", "database"],
        },
        {
          question: "Fastify 路由处理函数返回值能否自动序列化？",
          solution: "可以",
          difficulty: "easy",
        },
      ],
    });

    const items = await provider.parse(jsonContent);
    expect(items).toHaveLength(2);
    expect(items[0].prompt).toBe("What does WAL stand for in SQLite?");
    expect(items[0].answer).toBe("Write-Ahead Logging");
    expect(items[0].explanation).toContain("concurrent readers");
    expect(items[0].difficulty).toBe("medium");
    expect(items[0].tags).toEqual(["sqlite", "database"]);

    expect(items[1].prompt).toBe("Fastify 路由处理函数返回值能否自动序列化？");
    expect(items[1].answer).toBe("可以");
  });

  it("CSV/TSV 题库解析器正确解析包含题干、答案与解析的闪卡文本（兼容 Anki）", async () => {
    const provider = new CsvQuestionBankProvider();
    const tsvContent = [
      "# Anki Deck Export",
      "题目\t答案\t解析",
      "Vue 3 组合式 API 入口函数是什么？\tsetup\t在 beforeCreate 前执行",
      "ADR-016 规范的架构形态是什么？\t模块化单体\t规范单体边界与依赖流向",
    ].join("\n");

    const items = await provider.parse(tsvContent);
    expect(items).toHaveLength(2);
    expect(items[0].prompt).toBe("Vue 3 组合式 API 入口函数是什么？");
    expect(items[0].answer).toBe("setup");
    expect(items[0].explanation).toBe("在 beforeCreate 前执行");

    expect(items[1].prompt).toBe("ADR-016 规范的架构形态是什么？");
    expect(items[1].answer).toBe("模块化单体");
  });

  it("QuestionBankRegistry 支持第三方自定义题库解析器注册与扩展名匹配", () => {
    const registry = new QuestionBankRegistry();
    const customProvider: QuestionBankProviderPort = {
      id: "custom-anki-apkg",
      name: "Anki Package Provider",
      supportedExtensions: [".apkg"],
      async parse() {
        return [];
      },
    };

    registry.register(customProvider);
    expect(registry.get("custom-anki-apkg")).toBe(customProvider);
    expect(registry.resolveByExtension("deck.apkg")).toBe(customProvider);
    expect(registry.resolveByExtension("deck.json")).toBeUndefined();
  });

  it("POST /v1/questions/import 真实端点导入 CSV 题库并入库", async () => {
    const { db, client } = await createInMemoryDatabase();
    const { app } = await buildApp({ db, client });

    const csvContent = [
      "TypeScript 中 satisfies 操作符作用是什么？,类型满足校验且保留字面量类型,TS 4.9 引入",
      "SQLite WAL 模式下读操作是否阻塞写？,否,读写互不阻塞",
    ].join("\n");

    const response = await app.inject({
      method: "POST",
      url: "/v1/questions/import",
      payload: {
        format: "csv",
        content: csvContent,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.providerId).toBe("csv-question-bank");
    expect(body.importedCount).toBe(2);
    expect(body.questions).toHaveLength(2);
    expect(body.questions[0].prompt).toBe("TypeScript 中 satisfies 操作符作用是什么？");
    expect(body.questions[0].answerSpec.answer).toBe("类型满足校验且保留字面量类型");
  });
});
