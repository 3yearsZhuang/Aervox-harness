import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { getEventListeners } from "node:events";
import { CliInteractiveApprovalPolicy } from "../src/index.js";

describe("CliInteractiveApprovalPolicy", () => {
  it("immediately allows read_only tools without prompt", async () => {
    const policy = new CliInteractiveApprovalPolicy();
    const decision = await policy.evaluate({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "inv_1",
      toolName: "search_notes",
      arguments: { q: "test" },
      safetyLevel: "read_only",
    });
    expect(decision.action).toBe("allow");
  });

  it("immediately allows when autoApprove is enabled", async () => {
    const policy = new CliInteractiveApprovalPolicy({ autoApprove: true });
    const decision = await policy.evaluate({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "inv_2",
      toolName: "save_memory_note",
      arguments: { note: "test" },
      safetyLevel: "write_with_approval",
    });
    expect(decision.action).toBe("allow");
  });

  it("denies when stdin is not a TTY and autoApprove is false", async () => {
    const mockInput = new PassThrough();
    (mockInput as unknown as { isTTY?: boolean }).isTTY = false;

    const policy = new CliInteractiveApprovalPolicy({ input: mockInput });
    const decision = await policy.evaluate({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "inv_3",
      toolName: "save_memory_note",
      arguments: {},
      safetyLevel: "write_with_approval",
    });
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("cli_non_interactive");
  });

  it("allows when user responds 'y' in interactive TTY", async () => {
    const mockInput = new PassThrough();
    const mockOutput = new PassThrough();
    (mockInput as unknown as { isTTY?: boolean }).isTTY = true;

    const policy = new CliInteractiveApprovalPolicy({
      input: mockInput,
      output: mockOutput,
    });

    const promise = policy.evaluate({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "inv_4",
      toolName: "save_memory_note",
      arguments: { content: "hello world" },
      safetyLevel: "write_with_approval",
    });

    // 模拟用户输入 y + 回车
    mockInput.write("y\n");

    const decision = await promise;
    expect(decision.action).toBe("allow");
  });

  it("denies when user responds 'n' in interactive TTY", async () => {
    const mockInput = new PassThrough();
    const mockOutput = new PassThrough();
    (mockInput as unknown as { isTTY?: boolean }).isTTY = true;

    const policy = new CliInteractiveApprovalPolicy({
      input: mockInput,
      output: mockOutput,
    });

    const promise = policy.evaluate({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "inv_5",
      toolName: "delete_database",
      arguments: {},
      safetyLevel: "write_with_approval",
    });

    mockInput.write("n\n");

    const decision = await promise;
    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("user_rejected");
  });

  it("denies when approval times out", async () => {
    const mockInput = new PassThrough();
    const mockOutput = new PassThrough();
    (mockInput as unknown as { isTTY?: boolean }).isTTY = true;

    const policy = new CliInteractiveApprovalPolicy({
      input: mockInput,
      output: mockOutput,
      timeoutMs: 50,
    });

    const decision = await policy.evaluate({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "inv_6",
      toolName: "save_memory_note",
      arguments: {},
      safetyLevel: "write_with_approval",
    });

    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("approval_timeout");
  });

  it("denies when abort signal is triggered", async () => {
    const mockInput = new PassThrough();
    const mockOutput = new PassThrough();
    (mockInput as unknown as { isTTY?: boolean }).isTTY = true;

    const policy = new CliInteractiveApprovalPolicy({
      input: mockInput,
      output: mockOutput,
      timeoutMs: 5000,
    });

    const controller = new AbortController();
    const promise = policy.evaluate(
      {
        turnId: "t1",
        attemptId: "a1",
        invocationId: "inv_7",
        toolName: "save_memory_note",
        arguments: {},
        safetyLevel: "write_with_approval",
      },
      controller.signal,
    );

    controller.abort();
    const decision = await promise;
    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("approval_aborted");
  });

  it("denies immediately when signal is already aborted before evaluate", async () => {
    const policy = new CliInteractiveApprovalPolicy({
      promptUser: () => new Promise<string>(() => undefined),
      timeoutMs: 5000,
    });
    const controller = new AbortController();
    controller.abort();
    const decision = await policy.evaluate(
      {
        turnId: "t1",
        attemptId: "a1",
        invocationId: "inv_8",
        toolName: "save_memory_note",
        arguments: {},
        safetyLevel: "write_with_approval",
      },
      controller.signal,
    );
    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("approval_aborted");
  });

  it("removes abort listener from the turn signal after a successful decision", async () => {
    // 回归：同一 turn signal 上多次审批不得累积 abort 监听器（Node >10 触发告警）
    const controller = new AbortController();
    const policy = new CliInteractiveApprovalPolicy({
      promptUser: async () => "y",
      timeoutMs: 5000,
    });
    const request = (invocationId: string) => ({
      turnId: "t1",
      attemptId: "a1",
      invocationId,
      toolName: "save_memory_note",
      arguments: {},
      safetyLevel: "write_with_approval" as const,
    });

    const before = getEventListeners(controller.signal, "abort").length;
    await policy.evaluate(request("inv_9"), controller.signal);
    await policy.evaluate(request("inv_10"), controller.signal);
    const after = getEventListeners(controller.signal, "abort").length;

    expect(after).toBe(before);
  });
});
