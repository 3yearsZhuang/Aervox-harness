import { performance } from "node:perf_hooks";
import { TopK } from "../packages/repositories/dist/search/top-k.js";
import { readFixture, cosine } from "./native-search-fixture.mjs";

const [mode, path] = process.argv.slice(2);
if (!["json-sort", "json-topk", "typed-topk"].includes(mode)) throw new Error("Invalid benchmark mode");
const start = performance.now();
const { rows, dimensions, queries, topK, matrix, queryVectors } = await readFixture(path);
const json = mode.startsWith("json")
  ? Array.from({ length: rows }, (_, i) => JSON.stringify(Array.from(matrix.subarray(i * dimensions, (i + 1) * dimensions))))
  : undefined;
process.stdout.write(JSON.stringify({ ready: true, loadMs: performance.now() - start, matrixBytes: matrix.byteLength }) + "\n");
for (let index = 0; index < queries; index++) {
  const query = queryVectors.subarray(index * dimensions, (index + 1) * dimensions);
  const begin = performance.now();
  const heap = new TopK(topK);
  const all = [];
  for (let i = 0; i < rows; i++) {
    const vector = json ? JSON.parse(json[i]) : matrix.subarray(i * dimensions, (i + 1) * dimensions);
    const score = cosine(query, vector);
    if (score < 0) continue;
    const hit = { index: i, score };
    if (mode === "json-sort") all.push(hit);
    else heap.add(hit, score);
  }
  const hits = mode === "json-sort" ? all.sort((a, b) => b.score - a.score).slice(0, topK) : heap.values();
  process.stdout.write(JSON.stringify({ query: index, ms: performance.now() - begin, hits }) + "\n");
}
