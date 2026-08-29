import { describe, expect, it } from "vitest";
import { createAskUserQuestionToolProvider, ASK_USER_QUESTION_TOOL } from "../src/user-question-tool.js";
import type { UserQuestionPort } from "../src/ports.js";

describe("user-question-tool", () => {
  it("subagent 角色调用时直接拦截并返回 DELEGATED_CALLER", async () => {
    const mockPort: UserQuestionPort = {
      ask: async () => ({ answers: [] }),
    };
    const provider = createAskUserQuestionToolProvider({
      userQuestionPort: mockPort,
      isSubagent: true,
    });

    const res = await provider.execute({
      turnId: "turn_1",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: ASK_USER_QUESTION_TOOL,
      arguments: {
        questions: [{ id: "q1", question: "Continue?" }],
      },
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("DELEGATED_CALLER");
  });

  it("参数缺失或空 questions 时报错", async () => {
    const mockPort: UserQuestionPort = {
      ask: async () => ({ answers: [] }),
    };
    const provider = createAskUserQuestionToolProvider({
      userQuestionPort: mockPort,
    });

    const res = await provider.execute({
      turnId: "turn_1",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: ASK_USER_QUESTION_TOOL,
      arguments: { questions: [] },
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("EMPTY_QUESTIONS");
  });

  it("plan-review 意图缺失 detail 时报错 BAD_INTENT", async () => {
    const mockPort: UserQuestionPort = {
      ask: async () => ({ answers: [] }),
    };
    const provider = createAskUserQuestionToolProvider({
      userQuestionPort: mockPort,
    });

    const res = await provider.execute({
      turnId: "turn_1",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: ASK_USER_QUESTION_TOOL,
      arguments: {
        questions: [
          {
            id: "plan_1",
            question: "Review this plan",
            intent: { kind: "plan-review", approve: "Yes" },
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("BAD_INTENT");
  });

  it("正常提问并由 UserQuestionPort 返回 answers", async () => {
    let capturedRequest: unknown;
    const mockPort: UserQuestionPort = {
      ask: async (req) => {
        capturedRequest = req;
        return {
          answers: [{ id: "q1", selected: ["Option A (Recommended)"], custom: undefined }],
        };
      },
    };
    const provider = createAskUserQuestionToolProvider({
      userQuestionPort: mockPort,
    });

    const res = await provider.execute({
      turnId: "turn_1",
      attemptId: "atp_1",
      invocationId: "atp_1:2:1",
      name: ASK_USER_QUESTION_TOOL,
      arguments: {
        questions: [
          {
            id: "q1",
            question: "Which mode?",
            header: "Mode Selection",
            options: [
              { label: "Option A (Recommended)", description: "Faster" },
              { label: "Option B", description: "Safer" },
            ],
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
    expect(res.output).toEqual({
      answers: [{ id: "q1", selected: ["Option A (Recommended)"], custom: undefined }],
    });
    expect(capturedRequest).toMatchObject({
      turnId: "turn_1",
      attemptId: "atp_1",
      step: 2,
      questions: [
        {
          id: "q1",
          question: "Which mode?",
          header: "Mode Selection",
        },
      ],
    });
  });

  it("容错：questions 为字符串化的 JSON 数组（真实 LLM 行为）时自动解析并正常提问", async () => {
    let capturedRequest: { questions?: Array<{ id: string }> } | undefined;
    const mockPort: UserQuestionPort = {
      ask: async (req) => {
        capturedRequest = req as typeof capturedRequest;
        return { answers: [{ id: "q1", selected: ["38"] }] };
      },
    };
    const provider = createAskUserQuestionToolProvider({ userQuestionPort: mockPort });

    // 复现真实 LLM 故障形态：schema 缺省时模型把 questions 数组序列化为字符串
    const res = await provider.execute({
      turnId: "turn_1",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: ASK_USER_QUESTION_TOOL,
      arguments: {
        questions:
          '[{"id": "q1", "question": "23 + 15 = ?", "header": "小学加法", "options": [{"label": "38"}, {"label": "48"}]}]',
      },
    });

    expect(res.ok).toBe(true);
    expect(capturedRequest?.questions).toHaveLength(1);
    expect(capturedRequest?.questions?.[0]?.id).toBe("q1");
  });

  it("容错：带 markdown code fence 的字符串化 questions 也能解析", async () => {
    const mockPort: UserQuestionPort = {
      ask: async () => ({ answers: [{ id: "q1", selected: ["A"] }] }),
    };
    const provider = createAskUserQuestionToolProvider({ userQuestionPort: mockPort });

    const res = await provider.execute({
      turnId: "turn_1",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: ASK_USER_QUESTION_TOOL,
      arguments: {
        questions: '```json\n[{"id": "q1", "question": "选哪个？"}]\n```',
      },
    });

    expect(res.ok).toBe(true);
  });

  it("容错：字符串解析结果非数组（或非法 JSON）仍报 EMPTY_QUESTIONS", async () => {
    const mockPort: UserQuestionPort = {
      ask: async () => ({ answers: [] }),
    };
    const provider = createAskUserQuestionToolProvider({ userQuestionPort: mockPort });

    const notJson = await provider.execute({
      turnId: "turn_1",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: ASK_USER_QUESTION_TOOL,
      arguments: { questions: "不是 JSON 也不是数组" },
    });
    expect(notJson.ok).toBe(false);
    expect(notJson.error).toContain("EMPTY_QUESTIONS");

    const notArray = await provider.execute({
      turnId: "turn_1",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: ASK_USER_QUESTION_TOOL,
      arguments: { questions: '{"id": "q1"}' },
    });
    expect(notArray.ok).toBe(false);
    expect(notArray.error).toContain("EMPTY_QUESTIONS");
  });
});
