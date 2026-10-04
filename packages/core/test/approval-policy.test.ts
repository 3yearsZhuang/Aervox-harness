import { describe, expect, it } from "vitest";
import {
  AutoApprovalPolicy,
  withApprovalPolicy,
  createMockToolProvider,
  createScriptedProvider,
  defaultContextBuilder,
  executeTurn,
  InMemoryExecutionStore,
} from "../src/index.js";

describe("ApprovalPolicyPort & withApprovalPolicy", () => {
  it("AutoApprovalPolicy in full_access mode allows all tools", async () => {
    const policy = new AutoApprovalPolicy({ mode: "full_access" });
    const readDec = await policy.evaluate({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "i1",
      toolName: "search_notes",
      arguments: {},
      safetyLevel: "read_only",
    });
    expect(readDec.action).toBe("allow");

    const writeDec = await policy.evaluate({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "i2",
      toolName: "save_memory_note",
      arguments: { note: "test" },
      safetyLevel: "write_with_approval",
    });
    expect(writeDec.action).toBe("allow");
  });

  it("AutoApprovalPolicy in read_only mode denies write tools", async () => {
    const policy = new AutoApprovalPolicy({ mode: "read_only", defaultReason: "system_is_read_only" });
    const readDec = await policy.evaluate({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "i1",
      toolName: "search_notes",
      arguments: {},
      safetyLevel: "read_only",
    });
    expect(readDec.action).toBe("allow");

    const writeDec = await policy.evaluate({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "i2",
      toolName: "save_memory_note",
      arguments: { note: "test" },
      safetyLevel: "write_with_approval",
    });
    expect(writeDec.action).toBe("deny");
    expect(writeDec.reason).toBe("system_is_read_only");
  });

  it("AutoApprovalPolicy in ask_user mode asks user for write tools", async () => {
    const policy = new AutoApprovalPolicy({ mode: "ask_user" });
    const writeDec = await policy.evaluate({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "inv_42",
      toolName: "save_memory_note",
      arguments: { note: "test" },
      safetyLevel: "write_with_approval",
    });
    expect(writeDec.action).toBe("ask_user");
    expect(writeDec.approvalId).toBe("apv_inv_42");
  });

  it("withApprovalPolicy decorator intercepts and enforces policy", async () => {
    const rawTools = createMockToolProvider({
      save_memory_note: () => ({ ok: true, output: { saved: true } }),
    });

    const readOnlyWrapped = withApprovalPolicy(rawTools, new AutoApprovalPolicy({ mode: "read_only" }));
    const readResult = await readOnlyWrapped.execute({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "inv_1",
      name: "search_notes",
      arguments: { query: "notes" },
    });
    expect(readResult.ok).toBe(true);

    const writeDenied = await readOnlyWrapped.execute({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "inv_2",
      name: "save_memory_note",
      arguments: { note: "forbidden" },
    });
    expect(writeDenied.ok).toBe(false);
    expect(writeDenied.error).toContain("tool_restricted_in_read_only_mode");

    const askUserWrapped = withApprovalPolicy(rawTools, new AutoApprovalPolicy({ mode: "ask_user" }));
    const writeNeedsApproval = await askUserWrapped.execute({
      turnId: "t1",
      attemptId: "a1",
      invocationId: "inv_3",
      name: "save_memory_note",
      arguments: { note: "prompt_user" },
    });
    expect(writeNeedsApproval.ok).toBe(false);
    expect(writeNeedsApproval.needsApproval).toBeDefined();
    expect(writeNeedsApproval.needsApproval?.approvalId).toBe("apv_inv_3");
  });
});

describe("executeTurn with ApprovalPolicyPort", () => {
  it("AutoApprovalPolicy(full_access) executes write tool within the same turn", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_full_access", turnId: "turn_full_access" });
    const provider = createScriptedProvider([
      {
        text: "Saving note...",
        toolCalls: [{ id: "call_save", name: "save_memory_note", arguments: { text: "remember this" } }],
      },
      {
        text: "Successfully saved your note.",
      },
    ]);

    let executed = false;
    const tools = createMockToolProvider({
      save_memory_note: () => {
        executed = true;
        return { ok: true, output: { id: "note_123" } };
      },
    });

    const result = await executeTurn(
      {
        execution: store,
        provider,
        tools,
        contextBuilder: defaultContextBuilder,
        approvalPolicy: new AutoApprovalPolicy({ mode: "full_access" }),
      },
      {
        turnId: "turn_full_access",
        attemptId: "atp_full_access",
        sessionId: "ses_hitl",
        userMessage: "Save a note",
      },
    );

    expect(result.status).toBe("completed");
    expect(executed).toBe(true);
    const events = await store.listEvents("turn_full_access");
    expect(events.some((e) => e.eventType === "tool_result" && e.data?.name === "save_memory_note")).toBe(true);
  });

  it("AutoApprovalPolicy(ask_user) interrupts turn and emits tool_approval_required", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_ask_user", turnId: "turn_ask_user" });
    const provider = createScriptedProvider([
      {
        text: "Asking to save...",
        toolCalls: [{ id: "call_save_ask", name: "save_memory_note", arguments: { text: "need approval" } }],
      },
    ]);

    const tools = createMockToolProvider({
      save_memory_note: () => ({ ok: true, output: { id: "note_never" } }),
    });

    const result = await executeTurn(
      {
        execution: store,
        provider,
        tools,
        contextBuilder: defaultContextBuilder,
        approvalPolicy: new AutoApprovalPolicy({ mode: "ask_user" }),
      },
      {
        turnId: "turn_ask_user",
        attemptId: "atp_ask_user",
        sessionId: "ses_hitl",
        userMessage: "Save a note",
      },
    );

    expect(result).toMatchObject({ status: "interrupted", reason: "pending_approval" });
    const events = await store.listEvents("turn_ask_user");
    const approvalReq = events.find((e) => e.eventType === "tool_approval_required");
    expect(approvalReq).toBeDefined();
    expect(approvalReq?.data?.toolName).toBe("save_memory_note");

    const doneEvent = events.find((e) => e.eventType === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.data?.status).toBe("Interrupted");
  });

  it("AutoApprovalPolicy(read_only) denies write tool and continues loop with rejection error", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_read_only", turnId: "turn_read_only" });
    const provider = createScriptedProvider([
      {
        text: "Trying write...",
        toolCalls: [{ id: "call_save_deny", name: "save_memory_note", arguments: { text: "denied" } }],
      },
      {
        text: "Write operations are disabled in read-only mode.",
      },
    ]);

    const tools = createMockToolProvider({
      save_memory_note: () => ({ ok: true, output: { id: "note_never" } }),
    });

    const result = await executeTurn(
      {
        execution: store,
        provider,
        tools,
        contextBuilder: defaultContextBuilder,
        approvalPolicy: new AutoApprovalPolicy({ mode: "read_only" }),
      },
      {
        turnId: "turn_read_only",
        attemptId: "atp_read_only",
        sessionId: "ses_hitl",
        userMessage: "Save a note",
      },
    );

    expect(result.status).toBe("completed");
    const events = await store.listEvents("turn_read_only");
    const toolResult = events.find((e) => e.eventType === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult?.data?.ok).toBe(false);
    expect(toolResult?.data?.error).toContain("tool_restricted_in_read_only_mode");
  });
});
