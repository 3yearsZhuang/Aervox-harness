import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerPluginRegistry } from "@aervox/host-runtime/modules/ecosystem/plugins/index";
import { buildHostRuntime } from "@aervox/host-runtime";
import { createInMemoryDatabase, SqliteOutboxRepository, SqlitePlatformRepository } from "@aervox/repositories";
import { createTurnConsumerHandler } from "../src/turn-consumer.js";
import { runOutboxCycle } from "../src/outbox-worker.js";

export const local = { workspaceId: "local", subjectUserId: "local" };
export const llmSse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
export const toolSse = (name: string, args: unknown = {}) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);

/** Two independent composition roots share durable storage, as API and Worker do. */
export async function createHostFixture() {
  const database = await createInMemoryDatabase();
  const root = await mkdtemp(join(tmpdir(), "avx-worker-host-"));
  const options = { db: database.db, client: database.client, skillsRoot: join(root, "skills"), pluginsRoot: join(root, "plugins"), embeddingProvider: null };
  const api = await buildHostRuntime(options);
  await api.app.ready();
  const pluginRegistry = createServerPluginRegistry();
  const worker = await buildHostRuntime({ ...options, role: "worker", pluginRegistry });
  await worker.app.ready();
  const repo = worker.conversation.repo;
  const outboxRepo = new SqliteOutboxRepository(database.db);
  const platformRepo = new SqlitePlatformRepository(database.db);
  const handler = createTurnConsumerHandler(worker.conversation);
  return {
    ...database, api, worker, repo, outboxRepo, root, pluginRegistry,
    consume: () => runOutboxCycle({ outboxRepo, platformRepo, workerId: "test-worker", handlers: { "agent.turn.requested": handler } }),
    async accept(metadata: Record<string, unknown> = {}, sessionId = "session", idempotencyKey?: string, toolApprovalMode: "ask" | "full_access" = "ask") {
      const response = await api.app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/turns`,
        headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
        payload: { message: { content: "请帮我复习大红袍", contentType: "text" }, clientVersion: "worker-test", references: [], metadata, toolApprovalMode } });
      if (![200, 201].includes(response.statusCode)) throw new Error(response.body);
      return response.json().turnId as string;
    },
    async close() {
      await worker.app.close(); await api.app.close();
      await database.cleanup(); await rm(root, { recursive: true, force: true });
    },
  };
}
