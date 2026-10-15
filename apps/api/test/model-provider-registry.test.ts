import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFauxProvider, defaultModelProviderRegistry } from "@aervox/core";
import { createInMemoryDatabase } from "@aervox/repositories";
import type { ModelRuntimeDriver, ModelRuntimeDriverHandle } from "@aervox/host-runtime/modules/ecosystem/model-runtime/index";
import { buildApp } from "./app-fixture.js";

const providerId = "test-local-engine";
const usage = { totalTokens: 100, promptTokens: 80, completionTokens: 20, cacheReadTokens: 15, cacheWriteTokens: 5 };
const headers = { "x-workspace-id": "local", "x-user-id": "local" };

function endpoint(reason: "length" | "content_filter") {
  const requests: Array<{ url?: string; body: Record<string, unknown> }> = [];
  const fixture = createFauxProvider({ steps: [{ text: "partial answer", stopReason: reason, usage }] });
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += String(part);
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for await (const chunk of fixture.stream({ turnId: "fixture", attemptId: "fixture", step: 1,
      context: { turnId: "fixture", sessionId: "fixture", messages: [] } })) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk.text }, finish_reason: chunk.stopReason }] })}\n\n`);
      // Exercise accounting delivered after the terminal choice, as real compatible endpoints do.
      res.write(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: chunk.usage?.totalTokens,
        prompt_tokens: chunk.usage?.promptTokens, completion_tokens: chunk.usage?.completionTokens,
        prompt_tokens_details: { cached_tokens: chunk.usage?.cacheReadTokens }, cache_creation_input_tokens: chunk.usage?.cacheWriteTokens } })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  return {
    requests,
    async start() {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      return (server.address() as { port: number }).port;
    },
    async stop() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

afterEach(() => {
  defaultModelProviderRegistry.unregister(providerId);
  vi.unstubAllEnvs();
});

describe("Registered Provider host configuration and local runtime parity", () => {
  it.each(["length", "content_filter"] as const)("HTTP and Driver-started endpoints retain %s semantics and usage in SQLite", async reason => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "llm");
    defaultModelProviderRegistry.register({ id: providerId, name: "Test local engine", protocol: "openai-compat",
      capabilities: { toolCalls: false, reasoning: false }, isLocal: true });
    const results = [];
    for (const ingress of ["configured-endpoint", "driver-started"] as const) {
      const fixture = endpoint(reason);
      const database = await createInMemoryDatabase();
      const modelsDir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-provider-parity-"));
      await fs.writeFile(path.join(modelsDir, "fixture.gguf"), "fixture");
      let handle: ModelRuntimeDriverHandle = { pid: null, status: "idle", port: null, modelId: null, startedAt: null, error: null, logs: [] };
      const driver: ModelRuntimeDriver = {
        id: "fixture-driver", name: "Fixture Driver", configured: true,
        get running() { return handle.status === "running"; },
        resolveBinary: () => "fixture-driver", getHandle: () => handle,
        async start(model) {
          const port = await fixture.start();
          handle = { ...handle, status: "running", port, modelId: model.id, startedAt: new Date().toISOString() };
          return handle;
        },
        async stop() { await fixture.stop(); handle = { ...handle, status: "idle", port: null }; return handle; },
      };
      const { app } = await buildApp({ db: database.db, client: database.client,
        modelRuntimeOptions: { modelsDir, driver, metricsIntervalMs: 0 } });
      try {
        await app.ready();
        let port: number;
        if (ingress === "driver-started") {
          const started = await app.inject({ method: "POST", url: "/v1/model-runtime/start", headers, payload: { modelId: "fixture" } });
          expect(started.statusCode).toBe(200);
          expect(started.json()).toMatchObject({ driver: { id: "fixture-driver" }, runtime: { status: "running" } });
          port = started.json().runtime.port;
        } else port = await fixture.start();
        const config = { enabled: true, providerType: providerId, baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "fixture", maxTokens: 4096 };
        const preset = await app.inject({ method: "POST", url: "/v1/llm/presets", headers, payload: { name: "Registered engine", config } });
        expect(preset.statusCode).toBe(201);
        expect(preset.json().providerType).toBe(providerId);
        const saved = await app.inject({ method: "PUT", url: "/v1/llm/config", headers, payload: config });
        expect(saved.statusCode).toBe(200);
        expect(saved.json().providerType).toBe(providerId);
        const read = await app.inject({ method: "GET", url: "/v1/llm/config", headers });
        expect(read.json().providerType).toBe(providerId);
        const created = await app.inject({ method: "POST", url: `/v1/sessions/${ingress}/turns`, headers,
          payload: { message: { content: "hello", contentType: "text" }, clientVersion: "parity", references: [] } });
        expect(created.statusCode).toBe(201);
        const turnId = created.json().turnId;
        const streamed = await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers });
        const events = streamed.body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
        const done = events.find(event => event.eventType === "done");
        expect(done?.data).toMatchObject({ status: "Interrupted", reason: `model_${reason}`, isComplete: false });
        const runs = await database.client.execute({ sql: "SELECT r.token_usage, r.status FROM model_runs r JOIN turn_attempts a ON a.id = r.attempt_id WHERE a.turn_id = ?", args: [turnId] });
        expect(runs.rows).toHaveLength(1);
        expect(runs.rows[0]?.status).toBe("failed");
        const recordedUsage = JSON.parse(String(runs.rows[0]?.token_usage));
        expect(recordedUsage).toEqual(usage);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]?.url).toBe("/v1/chat/completions");
        expect(fixture.requests[0]?.body.tools).toBeUndefined();
        results.push({ done: done.data, usage: recordedUsage });
      } finally {
        await app.close();
        await fixture.stop();
        await database.cleanup();
        await fs.rm(modelsDir, { recursive: true, force: true });
      }
    }
    expect(results[0]).toEqual(results[1]);
  });

  it("unknown, removed and test-only Providers are rejected before configuration or probing", async () => {
    const database = await createInMemoryDatabase();
    const { app } = await buildApp({ db: database.db, client: database.client });
    try {
      await app.ready();
      defaultModelProviderRegistry.register({ id: providerId, name: "Removed", protocol: "openai-compat", isLocal: true, capabilities: { toolCalls: false, reasoning: false } });
      defaultModelProviderRegistry.unregister(providerId);
      for (const id of ["not-registered", providerId, "faux", "replay", "INVALID ID"]) {
        const config = { enabled: true, providerType: id, baseUrl: "http://127.0.0.1:1/v1", modelId: "test" };
        expect((await app.inject({ method: "PUT", url: "/v1/llm/config", headers, payload: config })).statusCode).toBe(400);
        expect((await app.inject({ method: "POST", url: "/v1/llm/presets", headers, payload: { name: "bad", config } })).statusCode).toBe(400);
      }
      const probe = await app.inject({ method: "POST", url: "/v1/llm/test-connection", headers,
        payload: { providerType: "not-registered", baseUrl: "http://127.0.0.1:1/v1", modelId: "test" } });
      expect(probe.json()).toMatchObject({ ok: false, latencyMs: 0, message: "unknown_model_provider: not-registered" });
    } finally { await app.close(); await database.cleanup(); }
  });
});
