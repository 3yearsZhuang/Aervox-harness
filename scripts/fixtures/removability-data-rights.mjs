// Run only via run-removability-drill.mjs: every path points into its fresh temp directory.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const Fastify = createRequire(new URL("../../apps/api/package.json", import.meta.url))("fastify");
import { createDatabase, initDatabaseSchema, SqliteMemoryRepository, SqliteToolRegistryRepository, exportSnapshot } from "../../packages/repositories/dist/index.js";
import { ToolRuntime } from "../../apps/api/dist/modules/ecosystem/tools/index.js";
import { registerMemoryModule } from "../../apps/api/dist/modules/companion/memory/index.js";
import { registerModelRuntimeModule } from "../../apps/api/dist/modules/ecosystem/model-runtime/index.js";

const [phase, root] = process.argv.slice(2);
assert.ok(root && path.basename(root).startsWith("aervox-removal-"));
const local = { workspaceId: "local", subjectUserId: "local" };
const { db, client } = await createDatabase({ url: `file:${path.join(root, "fixture.db")}` });
const app = Fastify();
const runtime = new ToolRuntime({ registry: new SqliteToolRegistryRepository(db) });
const ctx = { app, db, client, toolRuntime: runtime };
const modelsDir = path.join(root, "models");
try {
  if (phase === "seed") {
    await initDatabaseSchema(client);
    await fs.mkdir(modelsDir);
    for (const name of ["keep", "delete"]) {
      await fs.writeFile(path.join(modelsDir, `${name}.gguf`), `fixture-${name}`);
      await fs.writeFile(path.join(modelsDir, `${name}.json`), '{"url":"https://example.com/model.gguf"}');
    }
  }
  await registerMemoryModule(ctx, { embeddingProvider: null });
  const service = registerModelRuntimeModule(ctx, { modelsDir });
  await app.ready();
  const repo = new SqliteMemoryRepository(db, client);
  await runtime.registerContribution({ id: "echo", name: "echo", category: "system", description: "fixture", safetyLevel: "read_only" }, { call: async () => "alive" });
  assert.equal(await runtime.callTool(local, "echo", {}), "alive");
  if (phase === "seed") {
    const { memoryId } = await runtime.callTool(local, "aervox_memory_store", { content: "retained user memory" }, { approval: true });
    await repo.createRecord(local, { id: "delete-record", layer: "episodic", type: "fact", content: "delete via existing owner port" });
    await repo.createNode(local, { id: "projection", label: "retained projection" });
    await fs.writeFile(path.join(root, "memory-id"), memoryId);
  } else {
    const id = await fs.readFile(path.join(root, "memory-id"), "utf8");
    assert.equal((await repo.getRecord(local, id)).content, "retained user memory");
    assert.ok((await app.inject({ url: "/v1/memory/nodes" })).json().items.some((n) => n.id === "projection"));
    const snapshot = await exportSnapshot(client, 1);
    assert.ok(snapshot.tables.memory_records.some((r) => r.id === id && r.content === "retained user memory"));
    await fs.writeFile(path.join(root, `${phase}-export.json`), JSON.stringify(snapshot));
    if (phase === "absent") {
      assert.ok(!(await runtime.exportRegistry()).some((t) => t.id === "aervox_memory_store"));
      await assert.rejects(runtime.callTool(local, "aervox_memory_store", { content: "forbidden" }, { approval: true }), /not registered/);
      assert.equal(await repo.softDeleteRecord(local, "delete-record"), true);
      assert.equal(await repo.getRecord(local, "delete-record"), null);
      assert.equal(service.driver.id, "unavailable");
      await assert.rejects(service.start({ modelId: "keep" }), /driver_unavailable/);
      await service.deleteModel("delete");
      await assert.rejects(fs.stat(path.join(modelsDir, "delete.gguf")), /ENOENT/);
    } else {
      assert.equal(await repo.getRecord(local, "delete-record"), null);
      const result = await runtime.callTool(local, "aervox_memory_store", { content: "restored contribution" }, { approval: true });
      assert.equal((await repo.getRecord(local, result.memoryId)).content, "restored contribution");
      assert.equal(service.driver.id, "llama-server");
    }
    assert.equal(await fs.readFile(path.join(modelsDir, "keep.gguf"), "utf8"), "fixture-keep");
    assert.equal(await fs.readFile(path.join(modelsDir, "keep.json"), "utf8"), '{"url":"https://example.com/model.gguf"}');
  }
  console.log(`${phase}: real SQLite read/export/soft-delete and model-file ownership PASS`);
} finally { runtime.dispose(); await app.close(); client.close(); }
