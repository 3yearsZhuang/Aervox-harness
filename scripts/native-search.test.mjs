import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFixture, readFixture, cosine } from "./native-search-fixture.mjs";

const exec = promisify(execFile);
const binary = fileURLToPath(new URL(`./native-vector/target/debug/aervox-vector-pilot${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));

test("Rust executable agrees with reference cosine and stable sorting", async () => {
  const work = await mkdtemp(join(tmpdir(), "aervox-rust-contract-"));
  try {
    const matrix = [1, 0, 1, 0, 0, 0, -1, 0, 0.5, 0.5];
    const queries = [1, 0, 0, 1, 0, 0];
    const path = join(work, "vectors.bin");
    for (const topK of [1, 3, 10]) {
      await writeFile(path, encodeFixture(5, 2, 3, topK, matrix, queries));
      const { stdout } = await exec(binary, [path], { timeout: 10_000 });
      const results = stdout.trim().split("\n").map(JSON.parse).slice(1);
      for (const [index, actual] of results.entries()) {
        const query = queries.slice(index * 2, index * 2 + 2);
        const expected = Array.from({ length: 5 }, (_, i) => ({ index: i, score: cosine(query, matrix.slice(i * 2, i * 2 + 2)) }))
          .filter((hit) => hit.score >= 0).sort((a, b) => b.score - a.score).slice(0, topK);
        assert.deepEqual(actual.hits.map((h) => h.index), expected.map((h) => h.index));
        actual.hits.forEach((hit, i) => assert.ok(Math.abs(hit.score - expected[i].score) < 1e-12));
      }
    }
  } finally { await rm(work, { recursive: true, force: true }); }
});

test("both fixture readers reject malformed, truncated, oversized and non-finite fixtures", async () => {
  const work = await mkdtemp(join(tmpdir(), "aervox-rust-invalid-"));
  try {
    const valid = encodeFixture(1, 2, 1, 1, [1, 0], [1, 0]);
    const oversized = Buffer.from(valid); oversized.writeUInt32LE(0xffffffff, 8);
    const nonfinite = Buffer.from(valid); nonfinite.writeDoubleLE(NaN, 24);
    for (const bytes of [Buffer.from("invalid"), valid.subarray(0, -1), Buffer.concat([valid, Buffer.from([0])]), oversized, nonfinite]) {
      const path = join(work, "bad.bin");
      await writeFile(path, bytes);
      await assert.rejects(readFixture(path));
      await assert.rejects(exec(binary, [path], { timeout: 10_000 }));
    }
  } finally { await rm(work, { recursive: true, force: true }); }
});
