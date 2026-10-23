import { describe, it, expect, vi } from "vitest";
import { createDatabase, initDatabaseSchema, SqliteMemoryRepository, SqliteMemoryEmbeddingRepository,
  SqliteMemoryVectorSearchAdapter, CachedMemoryVectorSearchAdapter, NativeMemoryVectorSearchAdapter } from "../src/index.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const ctx = { workspaceId: "local", subjectUserId: "local" };

describe("interchangeable cached memory Ports", () => {
  for (const engine of ["typed", "rust"] as const) {
    it(`${engine} observes writer upsert, independent deletion and cache restart`, async () => {
      const work = await mkdtemp(join(tmpdir(), "aervox-vector-port-")), path = join(work, "aervox.db");
      const writer = await createDatabase({ url: `file:${path}` }); await initDatabaseSchema(writer.client);
      const other = await createDatabase({ url: `file:${path}` });
      const memories = new SqliteMemoryRepository(writer.db, writer.client), embeddings = new SqliteMemoryEmbeddingRepository(writer.db);
      const base = new SqliteMemoryVectorSearchAdapter(embeddings, "m");
      const fallback = vi.spyOn(base, "search");
      const directory = fileURLToPath(new URL(`../../native-runtime/dist/bin/${process.platform}-${process.arch}/`, import.meta.url));
      const manifest = JSON.parse(await readFile(join(directory, "artifact.json"), "utf8"));
      const port = engine === "typed" ? new CachedMemoryVectorSearchAdapter(base, { client: writer.client, modelId: "m", databasePath: path })
        : new NativeMemoryVectorSearchAdapter(base, { modelId: "m", databasePath: path, artifact: { binary: join(directory, manifest.binary), sha256: manifest.sha256 } });
      try {
        for (const id of ["a", "b", "z"]) await memories.createRecord(ctx, { id, layer: "long_term", type: "user_fact", content: id });
        await port.upsert(ctx, [{ id: "a", vector: [1, 0] }, { id: "b", vector: [1, 0] }, { id: "z", vector: [0, 0] }]);
        expect(await port.search(ctx, [1, 0], 2, 0)).toEqual(await base.search(ctx, [1, 0], 2, 0));
        // MemoryStore and migration writes do not go through the search Port.
        await embeddings.insertBatch(ctx, [{ id: "vec_a", memoryId: "a", vector: [0, 1], modelId: "m" }]);
        expect((await port.search(ctx, [1, 0], 1, 0.1))[0]?.id).toBe("b");
        await other.client.execute("DELETE FROM memory_embeddings WHERE memory_id='b'");
        expect(await port.search(ctx, [1, 0], 3, 0.1)).toEqual([]);
        expect(await port.search(ctx, [0, 0], 3, 0)).toEqual(await base.search(ctx, [0, 0], 3, 0));
        await port.clearAll(ctx); expect(await port.search(ctx, [1, 0], 3, -1)).toEqual([]);
        expect(fallback).toHaveBeenCalledTimes(2); // Only the two explicit reference comparisons above.
      } finally { await port.close(); other.client.close(); writer.client.close(); await rm(work, { recursive: true, force: true }); }
    });
  }
});

it("SQLite, typed cache and Rust preserve ranking, thresholds, ties and dimensional edge cases on one fixed corpus", async () => {
  const work = await mkdtemp(join(tmpdir(), "aervox-vector-differential-")), path = join(work, "oracle.db");
  const writer = await createDatabase({ url: `file:${path}` }); await initDatabaseSchema(writer.client);
  const memories = new SqliteMemoryRepository(writer.db, writer.client);
  const embeddings = new SqliteMemoryEmbeddingRepository(writer.db);
  const oracle = new SqliteMemoryVectorSearchAdapter(embeddings, "differential");
  const directory = fileURLToPath(new URL(`../../native-runtime/dist/bin/${process.platform}-${process.arch}/`, import.meta.url));
  const manifest = JSON.parse(await readFile(join(directory, "artifact.json"), "utf8"));
  const cached = new CachedMemoryVectorSearchAdapter(oracle, { client: writer.client, modelId: "differential", databasePath: path });
  const native = new NativeMemoryVectorSearchAdapter(oracle, { modelId: "differential", databasePath: path, artifact: { binary: join(directory, manifest.binary), sha256: manifest.sha256 } });
  const fallback = vi.spyOn(oracle, "search");
  let seed = 1729;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed % 2001 - 1000) / 1000; };
  const axis = [1,0,0,0,0,0,0,0];
  const corpus = [
    { id: "tie-a", vector: axis }, { id: "tie-b", vector: axis },
    { id: "zero", vector: Array(8).fill(0) }, { id: "negative", vector: axis.map((x) => -x) },
    { id: "other-dimension", vector: [1, 0] },
    ...Array.from({length: 35}, (_, index) => ({id: `random-${index}`, vector: Array.from({length:8}, random)})),
  ];
  try {
    for (const row of corpus) await memories.createRecord(ctx, {id: row.id, layer:"long_term", type:"user_fact", content:row.id});
    await oracle.upsert(ctx, corpus);
    const scenarios = [
      { query: axis, topK: 2, minScore: 0 },
      { query: axis, topK: 20, minScore: -1 },
      { query: Array(8).fill(0), topK: 50, minScore: 0 },
      { query: [1,0], topK: 3, minScore: 0 },
      { query: Array.from({length:8}, random), topK: 9, minScore: 0.25 },
      { query: axis, topK: 0, minScore: 0 },
    ];
    for (const scenario of scenarios) {
      const expected = await oracle.search(ctx, scenario.query, scenario.topK, scenario.minScore);
      for (const port of [cached, native]) {
        const actual = await port.search(ctx, scenario.query, scenario.topK, scenario.minScore);
        expect(actual.map((hit) => hit.id)).toEqual(expected.map((hit) => hit.id));
        actual.forEach((hit, index) => expect(hit.score).toBeCloseTo(expected[index]!.score, 12));
      }
    }
    expect(fallback).toHaveBeenCalledTimes(scenarios.length);
  } finally { await cached.close(); await native.close(); writer.client.close(); await rm(work,{recursive:true,force:true}); }
});
