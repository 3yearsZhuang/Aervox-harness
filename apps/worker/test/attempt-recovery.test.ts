import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlitePrivacyRepository, SqliteLLMConfigRepository } from "@aervox/repositories";
import { runAttemptRecoveryCycle } from "../src/attempt-recovery.js";
import { createHostFixture, llmSse, local } from "./host-fixture.js";

describe("Worker recovery admits only configured local models and committed results", () => {
  let f: Awaited<ReturnType<typeof createHostFixture>>;
  beforeEach(async () => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "llm");
    vi.stubEnv("AERVOX_LOOP_DISPATCH", "worker");
    vi.stubEnv("AERVOX_LOOP_RESUME", "local-results");
    f = await createHostFixture();
  });
  afterEach(async () => { await f?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  async function prepare(committed = true) {
    const turnId = await f.accept();
    const attemptId = (await f.repo.listTurnAttempts(local, turnId))[0].id;
    await f.repo.claimTurnAttempt(local, { turnId, attemptId, expectedFencingToken: 0, leaseId: "old", ttlMs: 1 });
    const invocationId = `${attemptId}:1:1`;
    await f.repo.reserveToolExecution(local, { turnId, attemptId, invocationId, name: "notes_search", arguments: {} });
    if (committed) {
      await f.repo.updateToolExecutionResult(local, { turnId, attemptId, invocationId, status: "executed", output: { topic: "微积分基础" } });
      await f.repo.appendStreamEvent(local, { id: "req", turnId, attemptId, sequence: 1, eventType: "tool_request", data: { name: "notes_search", executionId: invocationId } });
      await f.repo.appendStreamEvent(local, { id: "res", turnId, attemptId, sequence: 2, eventType: "tool_result", data: { name: "notes_search", ok: true, output: { topic: "微积分基础" }, executionId: invocationId } });
    }
    await f.client.execute({ sql: "UPDATE turn_attempts SET lease_expires_at = ? WHERE id = ?", args: ["2000-01-01T00:00:00.000Z", attemptId] });
    return { turnId, attemptId };
  }
  async function configure(baseUrl: string) {
    await new SqliteLLMConfigRepository(f.db).saveConfig(local, { enabled: true, providerType: "custom_openai", baseUrl, apiKey: "local-key", modelId: "configured-model", temperature: 0.7, maxTokens: 4096, settings: {} });
  }
  const cycle = () => runAttemptRecoveryCycle({ commands: f.worker.conversation.commands, workerId: "recovery" });

  it("without opt-in, interrupts committed results rather than writing fixture model text", async () => {
    await f.close();
    vi.stubEnv("AERVOX_LOOP_RESUME", "off");
    f = await createHostFixture();
    const { turnId } = await prepare(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    // Changing the environment after composition cannot opt this host into resume.
    vi.stubEnv("AERVOX_LOOP_RESUME", "local-results");
    expect(await cycle()).toBe(1);
    expect((await f.repo.getTurn(local, turnId))?.status).toBe("Interrupted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("resumes via the shared configured local provider, with committed results and no tools", async () => {
    const { turnId } = await prepare(); await configure("http://127.0.0.1:11434/v1");
    const requests: Array<{ model: string; messages: unknown; tools?: unknown[] }> = [];
    const fetch = vi.fn(async (_url, init) => { requests.push(JSON.parse(init.body)); return llmSse("复习重点是微积分基础。"); });
    vi.stubGlobal("fetch", fetch);
    await cycle();
    expect((await f.repo.getTurn(local, turnId))?.status).toBe("Completed");
    expect(requests[0].model).toBe("configured-model");
    expect(JSON.stringify(requests[0].messages)).toContain("微积分基础");
    expect(requests[0].tools ?? []).toHaveLength(0);
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });
  it.each(["remote", "deletion"])("rejects %s admission before calling the provider", async reason => {
    const { turnId } = await prepare();
    await configure(reason === "remote" ? "https://model.example/v1" : "http://127.0.0.1:11434/v1");
    if (reason === "deletion") await new SqlitePrivacyRepository(f.db).createDeletionRequest(local, { id: "delete", idempotencyKey: "delete", scope: "memory", ownerModule: "memory", targets: [] });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await cycle();
    expect(fetch).not.toHaveBeenCalled();
    expect((await f.repo.getTurn(local, turnId))?.status).toBe("Interrupted");
  });
  it("marks an uncommitted side effect outcome_unknown without replay", async () => {
    const { turnId } = await prepare(false); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await cycle()).toBe(1);
    expect((await f.repo.listToolExecutionsByTurn(local, turnId))[0].status).toBe("outcome_unknown");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Worker recovery command adapter", () => {
  afterEach(() => vi.restoreAllMocks());
  it("adapts only a fake command Port without storage or execution dependencies", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const commands = { recoverStaleExecutions: vi.fn(async () => ({
      recoveredAttempts: 2, unknownOutcomes: 3, orphanTurns: 4, resumeFailed: true,
    })) };
    expect(await runAttemptRecoveryCycle({ commands, workerId: "port" })).toBe(2);
    expect(commands.recoverStaleExecutions).toHaveBeenCalledExactlyOnceWith();
    expect(log.mock.calls).toEqual([
      ["[worker:port] turn_attempt_recovery=2 tool_outcome_unknown=3"], ["[worker:port] orphan_turn_recovery=4"],
    ]);
    expect(error).toHaveBeenCalledExactlyOnceWith("[worker:port] resume_error: local-result resume failed");
  });
  it("does not invent progress or swallow a failed recovery command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("recovery_store_unavailable");
    const commands = { recoverStaleExecutions: vi.fn(async () => { throw failure; }) };
    await expect(runAttemptRecoveryCycle({ commands, workerId: "port" })).rejects.toBe(failure);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
