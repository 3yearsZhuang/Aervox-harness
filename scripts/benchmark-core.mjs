#!/usr/bin/env node
// Controlled fake-provider baseline. Run with mise after building @aervox/core.
import { performance } from "node:perf_hooks";
import { writeFile, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { InMemoryExecutionStore, executeTurn, defaultContextBuilder } from "../packages/core/dist/index.js";
const args = Object.fromEntries(process.argv.slice(2).map(x => x.replace(/^--/, "").split("=")));
const samples = Number(args.samples ?? 5);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 30) throw new Error("samples must be 1..30");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const runs = [];
for (let i = 0; i < samples; i++) {
  const store = new InMemoryExecutionStore(); store.seedAttempt({ id: "a", turnId: "t" });
  const input = { turnId: "t", attemptId: "a", sessionId: "s", userMessage: "benchmark" };
  const begin = performance.now(); let firstVisibleMs, maxBatchBytes = 0, peakHeapBytes = process.memoryUsage().heapUsed;
  const record = store.recordSafeSegments.bind(store);
  store.recordSafeSegments = async inputs => {
    await record(inputs);
    if (inputs.length) firstVisibleMs ??= performance.now() - begin;
    maxBatchBytes = Math.max(maxBatchBytes, inputs.reduce((n, s) => n + Buffer.byteLength(s.text), 0));
    peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
  };
  const provider = { id: "baseline", async *stream() { for (let j = 0; j < 32; j++) { yield { text: "界".repeat(256), isFinal: false }; await sleep(5); } yield { text: "done", isFinal: true }; } };
  const result = await executeTurn({ execution: store, contextBuilder: defaultContextBuilder, provider }, input);
  if (result.status !== "completed") throw new Error(`stream failed: ${result.status}`);
  const durationMs = performance.now() - begin;
  const cancelStore = new InMemoryExecutionStore(); cancelStore.seedAttempt({ id: "a", turnId: "t" });
  let ready; const entered = new Promise(r => { ready = r; });
  const pending = executeTurn({ execution: cancelStore, contextBuilder: defaultContextBuilder, provider: { id: "silent", async *stream() { ready(); await new Promise(() => {}); } } }, input);
  await entered; const cancelBegin = performance.now(); await cancelStore.requestCancelAttempt(input);
  if ((await pending).status !== "cancelled") throw new Error("cancel failed");
  runs.push({ firstVisibleMs, durationMs, cancelMs: performance.now() - cancelBegin, maxBatchBytes, sampledPeakHeapBytes: peakHeapBytes });
}
const percentile = (field, p) => [...runs].map(r => r[field]).sort((a, b) => a - b)[Math.ceil(samples * p) - 1];
const digest = createHash("sha256");
for (const file of (await readdir(new URL("../packages/core/dist/", import.meta.url))).filter(f => f.endsWith(".js")).sort()) {
  digest.update(file).update(await readFile(new URL(`../packages/core/dist/${file}`, import.meta.url)));
}
const report = { builtCodeSha256: digest.digest("hex"), schemaVersion: 1, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), workingTree: "implementation under test", environment: { node: process.version, platform: process.platform, arch: process.arch }, fixture: { samples, chunks: 32, chunkBytes: 768, intervalMs: 5 }, limits: { textWindowBytes: 4096, stepResponseBytes: 8388608, cancelPollMs: 50 }, metrics: { firstVisibleP50Ms: percentile("firstVisibleMs", .5), firstVisibleP95Ms: percentile("firstVisibleMs", .95), cancelP95Ms: percentile("cancelMs", .95), durationP95Ms: percentile("durationMs", .95) }, runs, limitations: ["fake provider and memory store; not production LLM or disk latency", "heap sampled at writes; not a process memory bound", "SQLite contention measured separately by worker-write-contention-drill.mjs"] };
const json = JSON.stringify(report, null, 2) + "\n";
if (args.out) await writeFile(args.out, json);
process.stdout.write(json);
