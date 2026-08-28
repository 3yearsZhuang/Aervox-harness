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
});
