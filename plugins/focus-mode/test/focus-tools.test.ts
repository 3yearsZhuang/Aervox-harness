/**
 * Aervox｜思隅 plugins/focus-mode — 作答落库工具贡献单元测试（CAP-016）
 *
 * CR-060：自 `packages/core/test/practice-attempt-tool.test.ts` 随实现迁入。
 * 端口形状由 `PracticeAttemptPort` 改为 `PluginLearningFactPort`（窄端口，按上下文绑定）。
 */
import { describe, expect, it } from "vitest";
import type { JudgedAnswerInput, PluginLearningFactPort } from "@aervox/host-plugin-api";
import {
  createPracticeAttemptToolProvider,
  RECORD_PRACTICE_ATTEMPT_TOOL,
} from "../src/server/focus-tools.js";

function stubPort(
  impl?: (input: JudgedAnswerInput) => Promise<{
    questionId: string;
    attemptId: string;
    judgement: "correct" | "incorrect" | "partial";
    enteredMistakeNotebook: boolean;
  }>,
): PluginLearningFactPort {
  return {
    recordJudgedAnswer:
      impl ??
      (async () => ({ questionId: "q", attemptId: "a", judgement: "correct", enteredMistakeNotebook: false })),
    writeReport: async () => ({}),
    readReport: async () => null,
    listReports: async () => [],
    resetInference: async () => ({}),
  };
}

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

describe("focus-mode 作答落库工具贡献", () => {
  it("工具清单声明 record_practice_attempt 且为 readOnly", () => {
    const provider = createPracticeAttemptToolProvider(stubPort());
    expect(provider.tools).toHaveLength(1);
    expect(provider.tools[0].name).toBe(RECORD_PRACTICE_ATTEMPT_TOOL);
    expect(provider.tools[0].readOnly).toBe(true);
  });

  it("未注册的工具名直接拒绝", async () => {
    const provider = createPracticeAttemptToolProvider(stubPort());
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
    const provider = createPracticeAttemptToolProvider(stubPort());
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
    const provider = createPracticeAttemptToolProvider(stubPort());
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

  it("正常落库并透传窄端口结果（incorrect 进入错题本）", async () => {
    let captured: JudgedAnswerInput | undefined;
    const port = stubPort(async (input) => {
      captured = input;
      return { questionId: "q_1", attemptId: "att_1", judgement: "incorrect", enteredMistakeNotebook: true };
    });
    const provider = createPracticeAttemptToolProvider(port);

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
    const provider = createPracticeAttemptToolProvider(
      stubPort(async () => {
        throw new Error("DB_WRITE_FAILED");
      }),
    );
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
