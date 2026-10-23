import { describe, expect, it } from "vitest";
import { createTurnTerminator } from "../src/turn-terminator.js";
import {
  ASK_USER_QUESTION_TOOL,
  createAskUserQuestionToolProvider,
  createScriptedProvider,
  defaultContextBuilder,
  executeTurn,
  InMemoryExecutionStore,
} from "../src/index.js";

describe("atomic terminal event reasons", () => {
  it.each(["interrupted", "failed"] as const)("projects the authoritative %s outcome reason into done", async status => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({id: "attempt", turnId: "turn"});
    const claim = await store.claimTurnAttempt({attemptId: "attempt", turnId: "turn", expectedFencingToken: 0});
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("expected a runnable attempt");
    const terminator = createTurnTerminator({
      execution: store, turnId: "turn", attemptId: "attempt", sessionId: "session",
      claimFencingToken: claim.fencingToken, stepsTaken: 1, startedAt: Date.now(),
    });
    const eventData = {status: status === "interrupted" ? "Interrupted" : "Failed", isComplete: false, lastSequence: 1, reason: "stale reason"};
    await terminator.finalize(1, {status, reason: "execution_recovered"}, {eventType: "done", eventData});
    expect((await store.listEvents("turn"))[0]?.data).toEqual({...eventData, reason: "execution_recovered"});
    expect(eventData.reason).toBe("stale reason");
  });

  it("marks max_steps even when the question port returned defaults without an answered event", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({id: "attempt", turnId: "turn"});
    const tools = createAskUserQuestionToolProvider({userQuestionPort: {async ask(input) {
      // Mirrors the coordinator timeout fallback: question persisted, default
      // answer returned to the loop, and no user_question_answered event emitted.
      await store.appendEvent({
        turnId: input.turnId, attemptId: input.attemptId, sequence: await store.nextSequence(input.turnId),
        eventType: "user_question_required", data: {turnId: input.turnId, step: input.step, questions: input.questions},
      });
      return {answers: [{id: "q", selected: ["Yes (Recommended)"]}]};
    }}});
    const result = await executeTurn({
      execution: store, contextBuilder: defaultContextBuilder, tools,
      provider: createScriptedProvider([{text: "Before question.", toolCalls: [{id: "call", name: ASK_USER_QUESTION_TOOL, arguments: {
        questions: [{id: "q", question: "Continue?", options: [{label: "Yes (Recommended)"}, {label: "No"}]}],
      }}]}]),
      options: {maxSteps: 1, leaseHeartbeatIntervalMs: 0},
    }, {turnId: "turn", attemptId: "attempt", sessionId: "session", userMessage: "Confirm the next step"});
    expect(result).toMatchObject({status: "interrupted", reason: "max_steps"});
    const events = await store.listEvents("turn");
    expect(events.some(event => event.eventType === "user_question_required")).toBe(true);
    expect(events.some(event => event.eventType === "user_question_answered")).toBe(false);
    expect(events.at(-1)).toMatchObject({eventType: "done", data: {status: "Interrupted", isComplete: false, reason: "max_steps"}});
  });

  it("makes pending_approval explicit while preserving the interrupted approval terminal", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({id: "attempt", turnId: "turn"});
    const result = await executeTurn({
      execution: store, contextBuilder: defaultContextBuilder,
      provider: createScriptedProvider([{text: "Confirm write.", toolCalls: [{id: "call", name: "write", arguments: {}}]}]),
      tools: {tools: [{name: "write", description: "Write", readOnly: false}], async execute() {
        return {ok: false, needsApproval: {approvalId: "approval", toolName: "write", argumentsHash: "unchanged-hash"}};
      }},
      options: {leaseHeartbeatIntervalMs: 0},
    }, {turnId: "turn", attemptId: "attempt", sessionId: "session", userMessage: "Write"});
    expect(result).toMatchObject({status: "interrupted", reason: "pending_approval"});
    const events = await store.listEvents("turn");
    expect(events.find(event => event.eventType === "tool_approval_required")?.data).toMatchObject({approvalId: "approval", argumentsHash: "unchanged-hash"});
    expect(events.at(-1)).toMatchObject({eventType: "done", data: {status: "Interrupted", isComplete: false, reason: "pending_approval"}});
  });
});
