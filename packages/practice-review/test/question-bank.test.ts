import { describe, expect, it } from "vitest";
import { CsvQuestionBankProvider, JsonQuestionBankProvider, QuestionBankRegistry } from "../src/question-bank.js";

describe("JsonQuestionBankProvider", () => {
  const provider = new JsonQuestionBankProvider();

  it("解析数组、questions 与 items 三种外形，接受题目/答案别名", async () => {
    expect(await provider.parse(JSON.stringify([{ prompt: "1+1", answer: "2" }]))).toEqual([
      { prompt: "1+1", answer: "2", explanation: undefined, difficulty: undefined, tags: undefined, sourceRef: undefined },
    ]);
    expect(await provider.parse(JSON.stringify({ questions: [{ question: "2+2", solution: "4" }] })))
      .toMatchObject([{ prompt: "2+2", answer: "4" }]);
    expect(await provider.parse(JSON.stringify({ items: [{ prompt: "3+3", answer: "6" }] })))
      .toMatchObject([{ prompt: "3+3", answer: "6" }]);
  });

  it("跳过缺题目或答案的记录，过滤非法难度与空标签", async () => {
    const items = await provider.parse(JSON.stringify([
      { prompt: "", answer: "x" },
      { prompt: "ok", answer: "  " },
      { prompt: "A", answer: "B", difficulty: "extreme", tags: ["t1", "", "t2"] },
    ]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ prompt: "A", answer: "B", difficulty: undefined, tags: ["t1", "t2"] });
  });
});

describe("CsvQuestionBankProvider", () => {
  const provider = new CsvQuestionBankProvider();

  it("按逗号或制表符分列，跳过注释与表头，取解析与标签列", async () => {
    const csv = ["# 注释", "题目,答案,解析,标签", "1+1,2,加法,math;easy", '"引号题","引号答案"'].join("\n");
    expect(await provider.parse(csv)).toEqual([
      { prompt: "1+1", answer: "2", explanation: "加法", tags: ["math", "easy"] },
      { prompt: "引号题", answer: "引号答案", explanation: undefined, tags: undefined },
    ]);
    const tsv = ["prompt\tsolution", "Q1\tA1"].join("\n");
    expect(await provider.parse(tsv)).toMatchObject([{ prompt: "Q1", answer: "A1" }]);
  });

  it("列不足或无有效行时返回空", async () => {
    expect(await provider.parse("only-one-column")).toEqual([]);
    expect(await provider.parse("# 只有注释")).toEqual([]);
  });
});

describe("QuestionBankRegistry", () => {
  it("登记、列举并按扩展名解析提供方", () => {
    const registry = new QuestionBankRegistry();
    registry.register(new JsonQuestionBankProvider());
    registry.register(new CsvQuestionBankProvider());
    expect(registry.get("json-question-bank")?.id).toBe("json-question-bank");
    expect(registry.list().map((p) => p.id).sort()).toEqual(["csv-question-bank", "json-question-bank"]);
    expect(registry.resolveByExtension(".JSON")?.id).toBe("json-question-bank");
    expect(registry.resolveByExtension("dump.tsv")?.id).toBe("csv-question-bank");
    expect(registry.resolveByExtension(".xlsx")).toBeUndefined();
  });
});
