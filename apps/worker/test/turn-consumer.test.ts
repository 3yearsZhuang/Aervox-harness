import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlitePrivacyRepository, SqliteSkillRegistryRepository, SqliteMemoryRepository, indexMemoryFts } from "@aervox/repositories";
import { ProactiveIntegrationManager } from "@aervox/host-runtime-test/modules/proactive/proactive/integration-manager";
import { createHostFixture, llmSse, toolSse, local } from "./host-fixture.js";

interface ModelRequest { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }

describe("Worker uses the complete product host", () => {
  let fixture: Awaited<ReturnType<typeof createHostFixture>>;
  beforeEach(async () => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "llm");
    vi.stubEnv("AERVOX_LOOP_DISPATCH", "worker");
    vi.stubEnv("AERVOX_TURN_EXECUTION", "background");
    vi.stubEnv("AERVOX_LOOP_RESUME", "off");
    vi.spyOn(ProactiveIntegrationManager.prototype, "start");
    fixture = await createHostFixture();
  });
  afterEach(async () => { await fixture?.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("starts background integrations only in the API role", () => {
    expect(ProactiveIntegrationManager.prototype.start).toHaveBeenCalledTimes(1);
  });

  it("claims before product hooks so concurrent delivery cannot repeat preparatory side effects", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const beforeTurn = vi.fn(async () => { await gate; });
    fixture.pluginRegistry.register({ id: "focus-mode", beforeTurn });
    const fetch = vi.fn(async () => llmSse("只执行一次")); vi.stubGlobal("fetch", fetch);
    const id = await fixture.accept();
    const first = fixture.consume();
    try {
      await vi.waitFor(() => expect(beforeTurn).toHaveBeenCalledTimes(1));
      await fixture.consume();
      expect(beforeTurn).toHaveBeenCalledTimes(1);
    } finally { release(); }
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await fixture.repo.getTurn(local, id))?.status).toBe("Completed");
  });

  it("loads MCP tools connected after Worker startup and rejects them after disconnect", async () => {
    let toolCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).includes("mcp.mcd.cn")) {
        const respond = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
        if (body.method === "initialize") return respond({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } });
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body.method === "tools/list") return respond({ tools: [{ name: "list-nutrition", inputSchema: { type: "object", properties: {} } }] });
        if (body.method === "tools/call") { toolCalls += 1; return respond({ content: [{ type: "text", text: "nutrition result" }] }); }
        throw new Error(`Unexpected RPC ${body.method}`);
      }
      return body.messages.some((m: { role: string }) => m.role === "tool") ? llmSse("完成") : toolSse("mcp__mcd-mcp__list-nutrition");
    }));
    const connected = await fixture.api.app.inject({ method: "POST", url: "/v1/mcp/servers/mcd-mcp/connect", payload: { token: "test-token" } });
    expect(connected.statusCode).toBe(200);
    const id = await fixture.accept(); await fixture.consume();
    expect((await fixture.repo.getTurn(local, id))?.status).toBe("Completed");
    expect(toolCalls, JSON.stringify(await fixture.repo.listToolExecutionsByTurn(local, id))).toBe(1);
    const disconnected = await fixture.api.app.inject({ method: "POST", url: "/v1/mcp/servers/mcd-mcp/disconnect", payload: {} });
    expect(disconnected.statusCode).toBe(200);
    await fixture.accept({}, "after-disconnect"); await fixture.consume();
    expect(toolCalls, JSON.stringify(await fixture.repo.listToolExecutionsByTurn(local, id))).toBe(1);
  });

  it("accepts once, leaves the turn pending until Worker consumes, and completes through registered Skill tools", async () => {
    const requests: ModelRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return requests.length === 1 ? toolSse("aervox_skill_list_candidates") : llmSse("已查询技能候选。");
    }));
    const id = await fixture.accept({}, "session", "once");
    expect(await fixture.accept({}, "session", "once")).toBe(id);
    expect(requests).toHaveLength(0);
    const pending = (await fixture.outboxRepo.fetchPendingEvents({ limit: 100 })).filter(e => e.eventType === "agent.turn.requested");
    expect(pending).toHaveLength(1);
    await fixture.consume();
    expect((await fixture.repo.getTurn(local, id))?.status).toBe("Completed");
    expect((await fixture.repo.listToolExecutionsByTurn(local, id))[0]).toMatchObject({ name: "aervox_skill_list_candidates", status: "executed" });
    expect(requests[0].tools?.map(t => t.function.name)).toContain("avx_aervox_skill_list_candidates");
    expect((await fixture.repo.getStreamEvents(local, id)).at(-1)?.eventType).toBe("done");
    await fixture.consume();
    expect(requests).toHaveLength(2);
  });

  it.each(["default", "inline"])("%s API execution is never stolen by Worker", async mode => {
    if (mode === "default") vi.stubEnv("AERVOX_LOOP_DISPATCH", "api");
    else vi.stubEnv("AERVOX_TURN_EXECUTION", "inline");
    // Configuration belongs to each composition root and is read once at startup.
    await fixture.close();
    fixture = await createHostFixture();
    const workerExecute = vi.spyOn(fixture.worker.conversation.commands, "execute");
    const fetch = vi.fn(async () => llmSse("API 回复")); vi.stubGlobal("fetch", fetch);
    const id = await fixture.accept();
    expect((await fixture.outboxRepo.fetchPendingEvents({ limit: 100 })).some(e => e.eventType === "agent.turn.requested")).toBe(false);
    await fixture.consume();
    await vi.waitFor(async () => expect((await fixture.repo.getTurn(local, id))?.status).toBe("Completed"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(workerExecute).not.toHaveBeenCalled();
    expect((await fixture.outboxRepo.fetchPendingEvents({ limit: 100 })).some(e => e.eventType === "agent.turn.requested")).toBe(false);
  });

  it("loads active persona, persisted metadata, Skill catalog, conversation history and consented memory", async () => {
    const persona = await fixture.api.app.inject({ method: "POST", url: "/v1/personas", payload: { name: "雾老师", config: { systemPromptAppend: "请保持简洁。" } } });
    expect(persona.statusCode).toBe(201);
    await fixture.api.app.inject({ method: "POST", url: `/v1/personas/${persona.json().persona.id}/activate`, payload: {} });
    await new SqliteSkillRegistryRepository(fixture.db).registerSkill({ id: "tea", name: "tea", description: "茶叶复习技能", contentPath: `${fixture.root}/tea/SKILL.md` });
    const privacy = new SqlitePrivacyRepository(fixture.db);
    await privacy.grantConsent(local, { id: "recall", actorId: "local", purpose: "memory_long", scope: "auto_recall", policyVersion: "1" });
    await new SqliteMemoryRepository(fixture.db, fixture.client).createRecord(local, { id: "tea-memory", layer: "long_term", type: "user_fact", content: "请帮我复习大红袍 大红袍是用户最爱的茶", verificationStatus: "verified" });
    await indexMemoryFts(fixture.client, local, { id: "tea-memory", content: "请帮我复习大红袍 大红袍是用户最爱的茶" });
    await fixture.repo.getOrCreateSession(local, "session", "复习");
    await fixture.repo.createTurnWithOutbox(local, { id: "prior", sessionId: "session", idempotencyKey: "prior", status: "Completed" }, { id: "prior-input", content: "之前说过我喜欢武夷岩茶" });
    await fixture.repo.appendStreamEvent(local, { id: "prior-delta", turnId: "prior", attemptId: "prior-attempt", sequence: 1, eventType: "delta", safetyDecision: "approved", data: { messageId: "prior-assistant", text: "记住了。" } });
    await fixture.repo.appendStreamEvent(local, { id: "prior-done", turnId: "prior", attemptId: "prior-attempt", sequence: 2, eventType: "done", safetyDecision: "approved", data: { messageId: "prior-assistant", status: "Completed", isComplete: true } });
    const requests: ModelRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { requests.push(JSON.parse(init.body)); return llmSse("收到。"); }));
    const id = await fixture.accept({ companionName: "团子", userAddress: "掌柜" });
    await fixture.consume();
    expect((await fixture.repo.getTurn(local, id))?.status).toBe("Completed");
    const content = requests[0].messages.map(m => m.content).join("\n");
    for (const text of ["你是 雾老师", "掌柜", "请保持简洁", "茶叶复习技能", "之前说过我喜欢武夷岩茶", "大红袍是用户最爱的茶"]) expect(content).toContain(text);
  });

  it("blocks pending deletion before calling a model", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const id = await fixture.accept();
    await new SqlitePrivacyRepository(fixture.db).createDeletionRequest(local, { id: "delete", idempotencyKey: "delete", scope: "memory", ownerModule: "memory", targets: [] });
    await fixture.consume();
    expect(fetch).not.toHaveBeenCalled();
    expect((await fixture.repo.getTurn(local, id))?.status).toBe("Interrupted");
  });

  it("requires approval for a real Skill write and honors an API grant on resubmission", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const req: ModelRequest = JSON.parse(init.body);
      return req.messages.some(m => m.role === "tool") ? llmSse("创建成功") : toolSse("aervox_skill_create_payload", { payloadRef: "payload-test", payload: { skill_markdown: "# Review" } });
    }));
    const first = await fixture.accept({ toolApprovalMode: "ask" });
    await fixture.consume();
    expect((await fixture.repo.getTurn(local, first))?.status).toBe("Interrupted");
    const [approval] = await fixture.repo.listToolApprovalsByTurn(local, first);
    expect(approval.state).toBe("pending");
    expect((await fixture.client.execute("SELECT * FROM skill_payloads")).rows).toHaveLength(0);
    const grant = await fixture.api.app.inject({ method: "POST", url: `/v1/turns/${first}/tool-approvals`, payload: { approvalId: approval.id, decision: "granted", decidedBy: "local" } });
    expect(grant.statusCode).toBe(200);
    const second = await fixture.accept({ toolApprovalMode: "ask" });
    await fixture.consume();
    expect((await fixture.repo.getTurn(local, second))?.status).toBe("Completed");
    expect((await fixture.client.execute("SELECT * FROM skill_payloads")).rows).toHaveLength(1);
  });

  it("persists full_access per accepted Turn and ignores a forged mode in metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const req: ModelRequest = JSON.parse(init.body);
      return req.messages.some(m => m.role === "tool") ? llmSse("完成") : toolSse("aervox_skill_create_payload", { payloadRef: "full-access", payload: { skill_markdown: "# Review" } });
    }));
    const full = await fixture.accept({}, "session", undefined, "full_access");
    await fixture.consume();
    expect((await fixture.repo.listToolApprovalsByTurn(local, full))[0]).toMatchObject({ state: "granted", decidedBy: "permission:full_access:local" });
    expect((await fixture.repo.getTurn(local, full))?.status).toBe("Completed");
    const ask = await fixture.accept({ toolApprovalMode: "full_access" }, "ask-session");
    await fixture.consume();
    expect((await fixture.repo.listToolApprovalsByTurn(local, ask))[0].state).toBe("pending");
    expect((await fixture.repo.getTurn(local, ask))?.status).toBe("Interrupted");
  });

  it("runs enabled plugin contributions using persisted turn metadata", async () => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "scripted-plugin");
    await fixture.close();
    fixture = await createHostFixture();
    const workerExecute = vi.spyOn(fixture.worker.conversation.commands, "execute");
    const id = await fixture.accept({ mode: "focus", intent: "quiz" });
    await fixture.consume();
    expect(workerExecute).toHaveBeenCalledWith(local, expect.objectContaining({
      turnId: id,
      metadata: { mode: "focus", intent: "quiz" },
    }));
    expect((await fixture.repo.getTurn(local, id))?.status).toBe("Completed");
    const events = await fixture.repo.getStreamEvents(local, id);
    expect(events.find(e => e.eventType === "tool_result")?.data).toMatchObject({ name: "record_practice_attempt", ok: true });
    expect((await fixture.api.app.inject({ method: "GET", url: "/v1/mistakes" })).json().items).toHaveLength(1);
  });

  it("accepts two successive answers through the independent API coordinator and wakes the Worker", async () => {
    let step = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      step += 1;
      return step <= 2 ? toolSse("ask_user_question", { questions: [{ id: `q${step}`, question: `问题 ${step}`, options: [{ label: "确认" }] }] }) : llmSse("两个答案已收到。");
    }));
    const id = await fixture.accept();
    const work = fixture.consume();
    for (let n = 1; n <= 2; n++) {
      await vi.waitFor(async () => {
        const pending = (await fixture.api.app.inject({ method: "GET", url: `/v1/turns/${id}/questions/pending` })).json();
        expect(pending.pending).toBe(true);
        expect(pending.questions[0].id).toBe(`q${n}`);
      });
      const answer = await fixture.api.app.inject({ method: "POST", url: `/v1/turns/${id}/questions/answers`, payload: { answers: [{ id: `q${n}`, selected: ["确认"] }] } });
      expect(answer.statusCode).toBe(200);
    }
    await work;
    expect((await fixture.repo.getTurn(local, id))?.status).toBe("Completed");
    expect((await fixture.repo.getStreamEvents(local, id)).filter(e => e.eventType === "user_question_answered")).toHaveLength(2);
    expect((await fixture.api.app.inject({ method: "GET", url: `/v1/turns/${id}/questions/pending` })).json().pending).toBe(false);
  });

  it("aborts active model execution during Worker shutdown", async () => {
    let modelSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      modelSignal = init.signal;
      modelSignal!.addEventListener("abort", () => reject(modelSignal!.reason), { once: true });
    })));
    const id = await fixture.accept();
    const work = fixture.consume();
    await vi.waitFor(() => expect(modelSignal).toBeDefined());
    fixture.worker.conversation.abort();
    await work;
    expect(modelSignal?.aborted).toBe(true);
    expect((await fixture.repo.getTurn(local, id))?.status).not.toBe("Running");
  });
});
