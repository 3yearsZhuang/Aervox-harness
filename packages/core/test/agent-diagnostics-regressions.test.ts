import { describe, expect, it, vi } from "vitest";
import { runAgentTurn, InMemoryExecutionStore, exportSanitizedEvalFixture, buildResumeHistory } from "../src/index.js";
import type { AgentDefinition, ModelProviderPort } from "../src/index.js";

const agent: AgentDefinition = { id: "a", name: "agent", persona: { name: "agent", systemPrompt: "help" } };
const input = { turnId: "t", sessionId: "s", attemptId: "first", userMessage: "hello" };
const provider = (text: string): ModelProviderPort => ({ id: "fixture", async *stream() { yield { text, isFinal: true }; } });

describe("Agent diagnostics remain scoped to the actual execution", () => {
  it("excludes prior Attempts and returns no stale output when the same Attempt is skipped", async () => {
    const execution = new InMemoryExecutionStore();
    execution.seedAttempt({ id: "first", turnId: "t" });
    await runAgentTurn(agent, { execution, provider: provider("old") }, input);
    execution.seedAttempt({ id: "second", turnId: "t" });
    const next = await runAgentTurn(agent, { execution, provider: provider("new") }, { ...input, attemptId: "second" });
    expect(next.output.text).toBe("new");
    expect(next.interruption).toBeUndefined();
    const skipped = await runAgentTurn(agent, { execution, provider: provider("unexpected") }, { ...input, attemptId: "second" });
    expect(skipped.status).toBe("skipped");
    expect(skipped.output.text).toBe("");
    expect(skipped.diagnostics.manifest.modelSteps).toEqual([]);
  });

  it("uses actual ledger model IDs across failed streams and retries", async () => {
    const execution = new InMemoryExecutionStore();
    execution.seedAttempt({ id: "first", turnId: "t" });
    let calls = 0;
    const result = await runAgentTurn({ ...agent, options: { maxModelRetries: 1 } }, {
      execution, provider: { id: "retry", async *stream() {
        if (calls++ === 0) throw new Error("temporary failure");
        yield { text: "done", isFinal: true };
      } },
    }, input);
    expect(result.status).toBe("completed");
    const steps = result.diagnostics.manifest.modelSteps;
    expect(steps.map(step => step.modelRunId)).toEqual(execution.modelRunRecords().map(run => run.runId));
    expect(steps.map(step => step.status)).toEqual(["failed", "completed"]);
    expect(new Set(steps.map(step => step.modelRunId)).size).toBe(2);
    expect(steps.every(step => step.recorded && step.contextManifestId)).toBe(true);
    const fixture = exportSanitizedEvalFixture(result.diagnostics.manifest);
    expect(fixture.expectedFinalStatus).toBeUndefined();
    expect(fixture.metadata.replayLimitations).toContain("retries_require_custom_provider");
  });

  it("diagnostic storage failures do not fail a completed run or claim persistence", async () => {
    const execution = new InMemoryExecutionStore();
    execution.seedAttempt({ id: "first", turnId: "t" });
    execution.recordModelRun = async () => { throw new Error("telemetry unavailable"); };
    const result = await runAgentTurn(agent, { execution, provider: provider("done") }, input);
    expect(result.status).toBe("completed");
    expect(result.output.text).toBe("done");
    expect(result.diagnostics.warnings).toContain("model_run_write_failed");
    expect(result.diagnostics.manifest.modelSteps[0]?.recorded).toBe(false);
    expect(result.diagnostics.manifest.modelSteps[0]?.contextManifestId).toBeUndefined();
  });

  it("the Agent allowlist cannot lower the host safety declaration", async () => {
    const execution = new InMemoryExecutionStore();
    execution.seedAttempt({ id: "first", turnId: "t" });
    const execute = vi.fn(async () => ({ ok: true }));
    const evaluate = vi.fn(async () => ({ action: "ask_user" as const, approvalId: "approval", argumentsHash: "hash" }));
    const result = await runAgentTurn({ ...agent, tools: [{ name: "write", description: "write", readOnly: true }] }, {
      execution, approvalPolicy: { evaluate },
      tools: { tools: [], listTools: async () => [{ name: "write", description: "write", readOnly: false, safetyLevel: "privileged" }], execute },
      provider: { id: "write", async *stream() { yield { text: "", isFinal: true, toolCalls: [{ id: "call", name: "write", arguments: {} }] }; } },
    }, input);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ safetyLevel: "privileged" }), expect.anything());
    expect(execute).not.toHaveBeenCalled();
    expect(result.interruption?.type).toBe("approval_required");
    expect(result.diagnostics.manifest.toolExecutions).toMatchObject([{ status: "pending_approval", approvalId: "approval" }]);
  });

  it("resumes an approval through the same executor and omits the previous interruption from the completed result", async () => {
    const execution = new InMemoryExecutionStore();
    execution.seedAttempt({ id: "first", turnId: "t" });
    const declared = [{ name: "write", description: "write", readOnly: false }];
    const pending = await runAgentTurn({ ...agent, tools: declared }, {
      execution,
      provider: { id: "write", async *stream() { yield { text: "", isFinal: true, toolCalls: [{ id: "original", name: "write", arguments: {} }] }; } },
      tools: { tools: declared, async execute() { return { ok: false, needsApproval: { approvalId: "approval", toolName: "write", argumentsHash: "hash" } }; } },
    }, input);
    expect(pending.interruption?.approvalId).toBe("approval");
    expect(exportSanitizedEvalFixture(pending.diagnostics.manifest).metadata.sourceStatus).toBe("interrupted");
    expect(exportSanitizedEvalFixture(pending.diagnostics.manifest).expectedFinalStatus).toBeUndefined();
    const events = await execution.listEvents("t");
    const request = events.find(event => event.eventType === "tool_request")!.data as { executionId: string };
    execution.seedAttempt({ id: "second", turnId: "t" });
    const execute = vi.fn(async () => ({ ok: true, output: "saved" }));
    const result = await runAgentTurn({ ...agent, tools: declared }, { execution, provider: provider("saved"), tools: { tools: declared, execute } }, {
      ...input, attemptId: "second", resume: {
        expectedFencingToken: 0, lastSequence: events.at(-1)!.sequence, lastStep: 1, messageId: "message",
        history: buildResumeHistory({ userMessage: "write", events }).history,
        pendingApprovalResolution: { approvalId: "approval", decision: "granted", invocationId: request.executionId,
          toolCall: { id: "original", name: "write", arguments: {} } },
      },
    });
    expect(result.status).toBe("completed");
    expect(result.interruption).toBeUndefined();
    expect(result.output.text).toBe("saved");
    expect(execute).toHaveBeenCalledOnce();
    expect(result.diagnostics.manifest.toolExecutions).toMatchObject([{ invocationId: request.executionId, status: "executed" }]);
  });

  it("default eval export strips text, arguments, identity and configuration even if a raw argument map is supplied", async () => {
    const execution = new InMemoryExecutionStore();
    execution.seedAttempt({ id: "first", turnId: "t" });
    const result = await runAgentTurn({ ...agent, persona: { name: "SECRET", systemPrompt: "SECRET" } }, {
      execution, provider: provider("SECRET"),
    }, input);
    const manifest = result.diagnostics.manifest;
    manifest.modelSteps[0]!.toolCallsRequested = ["lookup"];
    manifest.modelSteps[0]!.toolCalls = [{ id: "SECRET", name: "lookup", arguments: { text: "SECRET" } }];
    const fixture = exportSanitizedEvalFixture(manifest, { toolCallArgumentsMap: { lookup: { text: "SECRET" } } });
    expect(JSON.stringify(fixture)).not.toContain("SECRET");
    expect(fixture.metadata.replayRequiresStubTools).toBe(true);
    const raw = exportSanitizedEvalFixture(manifest, { scrubUserContent: false });
    expect(raw.script[0]?.text).toBe("SECRET");
    expect(raw.script[0]?.toolCalls?.[0]?.arguments).toEqual({ text: "SECRET" });
  });
});
