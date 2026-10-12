import { readFile, writeFile } from "node:fs/promises";
import { endianness } from "node:os";

export function encodeFixture(rows, dimensions, queries, topK, matrix, queryVectors) {
  const bytes = Buffer.alloc(24 + (rows + queries) * dimensions * 8);
  bytes.write("AVXVEC01");
  for (const [i, value] of [rows, dimensions, queries, topK].entries()) bytes.writeUInt32LE(value, 8 + i * 4);
  let offset = 24;
  for (const values of [matrix, queryVectors]) {
    for (const value of values) { bytes.writeDoubleLE(value, offset); offset += 8; }
  }
  return bytes;
}

export async function createFixture(path, rows, dimensions, queries, topK) {
  const bytes = Buffer.alloc(24 + (rows + queries) * dimensions * 8);
  bytes.write("AVXVEC01");
  for (const [i, value] of [rows, dimensions, queries, topK].entries()) bytes.writeUInt32LE(value, 8 + i * 4);
  let state = 42;
  for (let i = 0; i < rows * dimensions; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes.writeDoubleLE(state / 0xffffffff * 2 - 1, 24 + i * 8);
  }
  // Queries come from fixed early rows, so increasing the corpus preserves the query set.
  for (let i = 0; i < queries; i++) {
    const source = 24 + (i % rows) * dimensions * 8;
    bytes.copy(bytes, 24 + (rows + i) * dimensions * 8, source, source + dimensions * 8);
  }
  await writeFile(path, bytes);
}

export async function readFixture(path) {
  if (endianness() !== "LE") throw new Error("Typed-array benchmark requires a little-endian host");
  const bytes = await readFile(path);
  if (bytes.length < 24 || bytes.toString("ascii", 0, 8) !== "AVXVEC01") throw new Error("Invalid fixture magic");
  const [rows, dimensions, queries, topK] = [8, 12, 16, 20].map((offset) => bytes.readUInt32LE(offset));
  if (rows < 1 || rows > 100_000 || dimensions < 1 || dimensions > 1024 || queries < 1 || queries > 32
    || topK < 1 || topK > 200 || rows * dimensions > 32_000_000
    || bytes.length !== 24 + (rows + queries) * dimensions * 8) throw new Error("Invalid fixture capacity or length");
  const matrix = new Float64Array(bytes.buffer, bytes.byteOffset + 24, rows * dimensions);
  const queryVectors = new Float64Array(bytes.buffer, bytes.byteOffset + 24 + matrix.byteLength, queries * dimensions);
  for (const values of [matrix, queryVectors]) for (const value of values) if (!Number.isFinite(value)) throw new Error("Non-finite fixture value");
  return { rows, dimensions, queries, topK, matrix, queryVectors };
}

export function cosine(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
