import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadHostRuntimeConfig } from "@aervox/config";
import { ControlContext, type SubagentPort } from "@aervox/core";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteExtensionRepository, SqliteLLMConfigRepository } from "@aervox/repositories";
import type { resumeCommittedTurns } from "@aervox/host-agent";

const captured = vi.hoisted(() => ({ children: [] as SubagentPort[], resumes: [] as Parameters<typeof resumeCommittedTurns>[0][] }));
vi.mock("@aervox/host-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@aervox/host-agent")>();
  return { ...actual,
    createSqliteSubagentPort: (deps: Parameters<typeof actual.createSqliteSubagentPort>[0]) => {
      const child = actual.createSqliteSubagentPort(deps); captured.children.push(child); return child;
    },
    resumeCommittedTurns: (deps: Parameters<typeof actual.resumeCommittedTurns>[0]) => {
      captured.resumes.push(deps); return actual.resumeCommittedTurns(deps);
    },
  };
});
import { buildHostRuntime } from "../src/runtime.js";
import { LLMConfigService } from "../src/modules/ecosystem/llm/service.js";
import { ServerPluginRegistry } from "../src/modules/ecosystem/plugins/turn-plugins/registry.js";
import { createLLMCallable } from "../src/modules/companion/conversation/llm-adapter.js";

const local = { workspaceId: "local", subjectUserId: "local" };
async function loopback() {
  const active = new Set<http.ServerResponse>();
  const requests: string[] = [];
  const held = new Map<string, http.ServerResponse>();
  let peak = 0;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += String(part);
    const input = JSON.parse(body) as { messages: Array<{ content: string }> };
    const prompt = input.messages.at(-1)!.content;
    requests.push(prompt); held.set(prompt, response); active.add(response);
    peak = Math.max(peak, active.size);
    response.once("close", () => { active.delete(response); held.delete(prompt); });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"held"},"finish_reason":null}]}\n\n');
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, active, requests, get peak() { return peak; },
    finish(prompt: string) {
      const response = held.get(prompt);
      if (!response) throw new Error(`fixture_request_missing: ${prompt}`);
      response.end('data: {"choices":[{"delta":{"content":" answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

describe("Node Host shared upstream model admission over actual HTTP", () => {
  it("shares one limit across leader, child, resume, plugin and domain; records refusal and cancels before shutdown drain", async () => {
    const fixture = await loopback();
    const database = await createInMemoryDatabase();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "avx-model-admission-"));
    const repo = new SqliteConversationRepository(database.db);
    const registry = new ServerPluginRegistry();
    let host: Awaited<ReturnType<typeof buildHostRuntime>> | undefined;
    const tasks: Promise<unknown>[] = [];
    const track = <T>(task: Promise<T>) => { void task.catch(() => undefined); tasks.push(task); return task; };
    const createTurn = (id: string, message = id) => host!.conversation.commands.createTurn(local, {
      turnId: id, sessionId: "session", attemptId: `${id}_attempt`, idempotencyKey: id,
      message: { id: `${id}_message`, content: message },
    });
    const assertRefused = async (turnId: string) => {
      expect((await repo.getTurn(local, turnId))?.status).toBe("Failed");
      const events = await repo.getStreamEvents(local, turnId);
      expect(events.find(event => event.eventType === "error")?.data).toMatchObject({ message: "model_stream_limit" });
      expect(events.filter(event => event.eventType === "delta")).toHaveLength(0);
      expect(events.at(-1)).toMatchObject({ eventType: "error", data: { message: "model_stream_limit" } });
      expect((await repo.listTurnAttempts(local, turnId)).at(-1)?.status).toBe("Failed");
      expect(events.some(event => event.eventType === "done" && (event.data as { isComplete?: boolean }).isComplete)).toBe(false);
    };
    try {
      await new SqliteExtensionRepository(database.db).createPlugin({ id: "admission_probe", publisher: "fixture", version: "1", checksum: "fixture", enabled: 1 });
      registry.register({ id: "admission_probe", afterTurn: async ctx => {
        if (ctx.status === "Completed") await ctx.llm!.generate("plugin_hold", { signal: ctx.signal });
      } });
      host = await buildHostRuntime({ db: database.db, client: database.client, role: "worker", pluginRegistry: registry,
        config: loadHostRuntimeConfig({ AERVOX_LOOP_PROVIDER: "llm", AERVOX_TURN_EXECUTION: "inline", AERVOX_MODEL_STREAM_CONCURRENCY: "2" }),
        skillsRoot: path.join(root, "skills"), pluginsRoot: path.join(root, "plugins"),
      });
      await new LLMConfigService(new SqliteLLMConfigRepository(database.db)).saveConfig(local, {
        enabled: true, providerType: "custom_openai", baseUrl: fixture.baseUrl, modelId: "isolated-concurrency-fixture",
        maxTokens: 1024, temperature: 0, settings: { requestTimeoutMs: 10_000 },
      });
      await host.app.ready();
      const leader = track(createTurn("leader_hold"));
      await vi.waitFor(() => expect(fixture.requests).toEqual(["leader_hold"]), { timeout: 5000 });
      const domainAbort = new AbortController();
      const domain = host.modelGeneration.generate({ context: local, system: "fixture", user: "diary_hold", task: "diary_generation", signal: domainAbort.signal });
      const domainOutcome = track(domain.then(() => undefined, error => error as Error));
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(2), { timeout: 5000 });

      await createTurn("refused_leader"); await assertRefused("refused_leader");
      const child = await captured.children.at(-1)!.delegate({ parentTurnId: "leader_hold", parentAttemptId: "leader_hold_attempt",
        parentExecutionId: "fixture_child", sessionId: "session", task: "refused_child" });
      expect(child.status).toBe("Failed"); await assertRefused(child.subTurnId);
      await host.conversation.resume();
      const control = new ControlContext();
      try {
        const resumed = await captured.resumes.at(-1)!.createProvider({ turnId: "existing", sessionId: "session", attemptId: "existing_attempt", userMessage: "resume" }, control);
        await expect(createLLMCallable(resumed).generate("refused_resume", { signal: control.abortSignal })).rejects.toThrow("model_stream_limit");
      } finally { control.dispose(); }
      expect(fixture.requests).toHaveLength(2);
      const refusedRuns = await database.client.execute("SELECT status, token_usage FROM model_runs WHERE attempt_id='refused_leader_attempt'");
      expect(refusedRuns.rows.length).toBeGreaterThan(0);
      expect(refusedRuns.rows.every(row => row.status === "failed" && row.token_usage === null)).toBe(true);

      fixture.finish("leader_hold");
      await vi.waitFor(() => expect(fixture.requests).toContain("plugin_hold"), { timeout: 5000 });
      await createTurn("refused_during_plugin"); await assertRefused("refused_during_plugin");
      expect(fixture.requests).toHaveLength(3);
      fixture.finish("plugin_hold"); await leader;
      expect((await repo.getTurn(local, "leader_hold"))?.status).toBe("Completed");
      domainAbort.abort(new Error("fixture_cancel")); expect(await domainOutcome).toMatchObject({ message: "fixture_cancel" });
      await vi.waitFor(() => expect(fixture.active.size).toBe(0), { timeout: 5000 });

      const replacement = track(host.modelGeneration.generate({ context: local, system: "fixture", user: "replacement_hold", task: "proactive_compose" }));
      await vi.waitFor(() => expect(fixture.requests).toContain("replacement_hold"), { timeout: 5000 });
      fixture.finish("replacement_hold"); expect(await replacement).toBe("held answer");
      await vi.waitFor(() => expect(fixture.active.size).toBe(0), { timeout: 5000 });

      const shutdown = track(createTurn("shutdown_hold"));
      await vi.waitFor(() => expect(fixture.requests).toContain("shutdown_hold"), { timeout: 5000 });
      const shutdownGeneration = track(host.modelGeneration.generate({ context: local, system: "fixture", user: "shutdown_generation" })
        .then(() => undefined, error => error as Error));
      await vi.waitFor(() => expect(fixture.requests).toContain("shutdown_generation"), { timeout: 5000 });
      await host.app.close(); await shutdown;
      expect(await shutdownGeneration).toMatchObject({ message: "host_shutdown" });
      expect((await repo.getTurn(local, "shutdown_hold"))?.status).toBe("Cancelled");
      expect((await repo.getStreamEvents(local, "shutdown_hold")).at(-1)?.data).toMatchObject({ status: "Cancelled", reason: "cancelled" });
      await vi.waitFor(() => expect(fixture.active.size).toBe(0), { timeout: 5000 });
      expect(fixture.peak).toBe(2);
    } finally {
      await host?.app.close();
      await Promise.allSettled(tasks);
      await fixture.close(); await database.cleanup(); await fs.rm(root, { recursive: true, force: true });
      captured.children.length = 0; captured.resumes.length = 0;
    }
  });
});
