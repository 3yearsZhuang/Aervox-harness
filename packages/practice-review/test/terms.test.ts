import { describe, expect, it } from "vitest";
import {
  extractTerms,
  extractHeuristicTerms,
  cleanTermText,
  isGenericTerm,
  dedupeOverlapTerms,
  parseTermsFromJSON,
} from "../src/terms.js";

describe("CAP-007 / CAP-002 术语抽取测试", () => {
  it("cleanTermText：能正确剥离中英文标点、引号与空格", () => {
    expect(cleanTermText("《快速傅里叶变换》")).toBe("快速傅里叶变换");
    expect(cleanTermText("“Socratic Method”")).toBe("Socratic Method");
    expect(cleanTermText("`TypeScript`，")).toBe("TypeScript");
    expect(cleanTermText("  二叉搜索树  ")).toBe("二叉搜索树");
  });

  it("isGenericTerm：能精准过滤无技术深度或泛化停用词", () => {
    expect(isGenericTerm("这个")).toBe(true);
    expect(isGenericTerm("方法")).toBe(true);
    expect(isGenericTerm("123")).toBe(true);
    expect(isGenericTerm("a")).toBe(true);
    expect(isGenericTerm("红黑树")).toBe(false);
    expect(isGenericTerm("OAuth2")).toBe(false);
    expect(isGenericTerm("深度优先搜索")).toBe(false);
  });

  it("dedupeOverlapTerms：短词包含于长词时自动丢弃短词，保留更精准长词", () => {
    const list = [
      { text: "树", relation: "background" as const },
      { text: "二叉树", relation: "background" as const },
      { text: "平衡二叉树", relation: "background" as const },
      { text: "OAuth2", relation: "related" as const },
    ];
    const deduped = dedupeOverlapTerms(list);
    expect(deduped.map((d) => d.text)).toEqual(["平衡二叉树", "OAuth2"]);
  });

  it("extractHeuristicTerms：能从混合文本中启发式抽取引号实体、英文专有名词和算法名词", () => {
    const text = `在《计算机程序设计艺术》中，提到了 Dijkstra 算法 和 A* 寻路机制，同时可以结合 OAuth2.0 与 JWT 进行身份认证。`;
    const terms = extractHeuristicTerms(text);
    const names = terms.map((t) => t.text);
    expect(names).toContain("计算机程序设计艺术");
    expect(names).toContain("Dijkstra 算法");
    expect(names).toContain("JWT");
  });

  it("parseTermsFromJSON：能解析 markdown code block 与普通 JSON，遇到残缺能正则兜底", () => {
    const jsonStr = "```json\n" + JSON.stringify([
      { text: "反向传播算法", relation: "background", description: "梯度计算" },
      { text: "Transformer", relation: "related" },
    ]) + "\n```";

    const parsed = parseTermsFromJSON(jsonStr);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toBe("反向传播算法");
    expect(parsed[0].relation).toBe("background");
    expect(parsed[1].text).toBe("Transformer");

    // 残缺文本正则兜底
    const broken = `{"other": 123, "items": [{"text": "残差连接", "relation": "background"}, {"text": "Softmax"}`;
    const fallback = parseTermsFromJSON(broken);
    expect(fallback.map((f) => f.text)).toContain("残差连接");
    expect(fallback.map((f) => f.text)).toContain("Softmax");
  });

  it("extractTerms：端到端 pipeline 支持两阶段 LLM 质检与优雅降级", async () => {
    const mockLlm = {
      generate: async (_prompt: string, options?: { systemPrompt?: string }) => {
        if (options?.systemPrompt?.includes("质检员")) {
          // 质检阶段
          return JSON.stringify([
            { text: "支持向量机", relation: "background" },
            { text: "核函数", relation: "related" },
          ]);
        }
        // 初提阶段返回 6 个候选（>5 个以触发质检阶段）
        return JSON.stringify([
          { text: "支持向量机", relation: "background" },
          { text: "核函数", relation: "related" },
          { text: "二叉树", relation: "background" },
          { text: "红黑树", relation: "background" },
          { text: "哈希表", relation: "background" },
          { text: "图遍历", relation: "related" },
        ]);
      },
    };

    const text = "支持向量机（SVM）是一种基于核函数的算法。";
    const terms = await extractTerms(text, { llm: mockLlm, enableHeuristicFallback: false });
    expect(terms.map((t) => t.text)).toEqual(["支持向量机", "核函数"]);
  });
});
