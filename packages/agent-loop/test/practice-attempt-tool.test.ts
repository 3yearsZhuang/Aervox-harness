import { describe, expect, it } from "vitest";
import { createPracticeAttemptToolProvider, RECORD_PRACTICE_ATTEMPT_TOOL } from "../src/practice-attempt-tool.js";
import type { PracticeAttemptPort, PracticeAttemptPortRequest } from "../src/ports.js";

function baseArgs(): Record<string, unknown> {
  return {
    prompt: "1 + 1 等于几？",
    questionType: "short_answer",
    userAnswer: "2",
    correctAnswer: "2",
    judgement: "correct",
    explanation: "基础加法",
  };
}

describe("practice-attempt-tool", () => {
  it("工具清单声明 record_practice_attempt 且为 readOnly", () => {
    const provider = createPracticeAttemptToolProvider({
      practiceAttemptPort: { recordAttempt: async () => ({ questionId: "q", attemptId: "a", judgement: "correct", enteredMistakeNotebook: false }) },
    });
    expect(provider.tools).toHaveLength(1);
    expect(provider.tools[0].name).toBe(RECORD_PRACTICE_ATTEMPT_TOOL);
    expect(provider.tools[0].readOnly).toBe(true);
  });

  it("未注册的工具名直接拒绝", async () => {
    const provider = createPracticeAttemptToolProvider({
      practiceAttemptPort: { recordAttempt: async () => ({ questionId: "q", attemptId: "a", judgement: "correct", enteredMistakeNotebook: false }) },
    });
    const res = await provider.execute({
      turnId: "turn_1",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: "other_tool",
      arguments: {},
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unregistered_tool");
  });

  it("缺少 prompt / userAnswer / correctAnswer 时报错", async () => {
    const provider = createPracticeAttemptToolProvider({
      practiceAttemptPort: { recordAttempt: async () => ({ questionId: "q", attemptId: "a", judgement: "correct", enteredMistakeNotebook: false }) },
    });
    for (const field of ["prompt", "userAnswer", "correctAnswer"]) {
      const args = baseArgs();
      delete args[field];
      const res = await provider.execute({
        turnId: "turn_1",
        attemptId: "atp_1",
        invocationId: "atp_1:1:1",
        name: RECORD_PRACTICE_ATTEMPT_TOOL,
        arguments: args,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("INVALID_ATTEMPT");
      expect(res.error).toContain(field);
    }
  });

  it("judgement 非三值枚举时报错", async () => {
    const provider = createPracticeAttemptToolProvider({
      practiceAttemptPort: { recordAttempt: async () => ({ questionId: "q", attemptId: "a", judgement: "correct", enteredMistakeNotebook: false }) },
    });
    const res = await provider.execute({
      turnId: "turn_1",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: RECORD_PRACTICE_ATTEMPT_TOOL,
      arguments: { ...baseArgs(), judgement: "wrong" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("judgement");
  });

  it("正常落库并透传端口结果（incorrect 进入错题本）", async () => {
    let captured: PracticeAttemptPortRequest | undefined;
    const port: PracticeAttemptPort = {
      recordAttempt: async (req) => {
        captured = req;
        return { questionId: "q_1", attemptId: "att_1", judgement: "incorrect", enteredMistakeNotebook: true };
      },
    };
    const provider = createPracticeAttemptToolProvider({ practiceAttemptPort: port });

    const res = await provider.execute({
      turnId: "turn_quiz",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: RECORD_PRACTICE_ATTEMPT_TOOL,
      arguments: { ...baseArgs(), userAnswer: "3", judgement: "incorrect" },
    });

    expect(res.ok).toBe(true);
    expect(res.output).toEqual({
      questionId: "q_1",
      attemptId: "att_1",
      judgement: "incorrect",
      enteredMistakeNotebook: true,
    });
    expect(captured).toMatchObject({
      turnId: "turn_quiz",
      prompt: "1 + 1 等于几？",
      questionType: "short_answer",
      userAnswer: "3",
      correctAnswer: "2",
      judgement: "incorrect",
      explanation: "基础加法",
    });
  });

  it("端口抛错时映射为 ok:false", async () => {
    const provider = createPracticeAttemptToolProvider({
      practiceAttemptPort: {
        recordAttempt: async () => {
          throw new Error("DB_WRITE_FAILED");
        },
      },
    });
    const res = await provider.execute({
      turnId: "turn_1",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: RECORD_PRACTICE_ATTEMPT_TOOL,
      arguments: baseArgs(),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("DB_WRITE_FAILED");
  });
});
