import { spawn, execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { createFixture } from "./native-search-fixture.mjs";
import { RipgrepCodeSearch } from "../apps/api/dist/modules/ecosystem/mcp/code-search.js";
import { rgPath } from "@vscode/ripgrep";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((value) => value.replace(/^--/, "").split("=")));
const integer = (name, fallback, max) => {
  const value = Number(args[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
};
const samples = integer("samples", 7, 29);
const warmup = 3;
const dimensions = integer("dimensions", 256, 320);
const sizes = (args.sizes ?? "1000,10000,100000").split(",").map(Number);
if (sizes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 100_000)) throw new Error("Invalid sizes");
const output = resolve(args.out ?? "artifacts/native-search/benchmark.json");
const rustBinary = join(root, "native/target/release", process.platform === "win32" ? "aervox-vector-pilot.exe" : "aervox-vector-pilot");
const work = await mkdtemp(join(tmpdir(), "aervox-native-benchmark-"));
const quantiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries([50, 95, 99].map((p) => [`p${p}Ms`, sorted[Math.ceil(sorted.length * p / 100) - 1]]));
};

async function measureChild(command, argv) {
  const start = performance.now();
  const child = spawn(command, argv, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "", sampledPeakRssBytes = null, sampling = Promise.resolve(), processWallMs;
  const sample = () => {
    if (process.platform === "win32" || !child.pid) return;
    sampling = new Promise((done) => execFile("ps", ["-o", "rss=", "-p", String(child.pid)], { timeout: 1000 }, (error, value) => {
      const bytes = Number(value.trim()) * 1024;
      if (!error && bytes > 0) sampledPeakRssBytes = Math.max(sampledPeakRssBytes ?? 0, bytes);
      done();
    }));
  };
  let samplingBusy = false;
  const sampleOnce = () => { if (samplingBusy) return; samplingBusy = true; sample(); void sampling.finally(() => { samplingBusy = false; }); };
  const timer = setInterval(sampleOnce, 100);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 120_000);
  sampleOnce();
  try {
    await new Promise((done, fail) => {
      child.once("error", fail);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 8 * 1024 * 1024) child.kill("SIGKILL");
      });
      child.stderr.on("data", (chunk) => { if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192); });
      child.once("close", (code) => {
        processWallMs = performance.now() - start;
        if (code === 0) done();
        else fail(new Error(`${command} exited ${code}: ${stderr}`));
      });
    });
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
    await sampling;
  }
  const records = stdout.trim().split("\n").map((line) => JSON.parse(line));
  if (!records[0]?.ready || records.length !== samples + warmup + 1) throw new Error("Incomplete benchmark output");
  return { processWallMs, sampledPeakRssBytes, loadMs: records[0].loadMs,
    matrixBytes: records[0].matrixBytes, queries: records.slice(1) };
}

function legacySearch(directory, query, maxResults) {
  // Fixed pre-migration scan, with its intended global result cap enforced for a fair comparison.
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const lines = readFileSync(join(directory, entry.name), "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(query.toLowerCase())) result.push({ file: entry.name, line: i + 1, content: lines[i].trim() });
      if (result.length === maxResults) return result;
    }
  }
  return result;
}

try {
  const digest = createHash("sha256");
  for (const path of ["native/Cargo.toml", "native/tools/vector-pilot/src/main.rs", "native/tools/vector-pilot/Cargo.toml", "native/Cargo.lock", "pnpm-lock.yaml", "scripts/benchmark-native-search.mjs", "scripts/native-search-fixture.mjs", "scripts/vector-benchmark-worker.mjs", "packages/repositories/dist/search/top-k.js", "apps/api/dist/modules/ecosystem/mcp/code-search.js"]) {
    digest.update(path).update(await readFile(join(root, path)));
  }
  const report = {
    schemaVersion: 1,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    workingTree: "implementation under test", implementationSha256: digest.digest("hex"),
    rustBinarySha256: createHash("sha256").update(await readFile(rustBinary)).digest("hex"),
    environment: { node: process.version, rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(), ripgrep: execFileSync(rgPath, ["--version"], { encoding: "utf8" }).trim(), platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, ramBytes: totalmem() },
    fixture: { seed: 42, sizes, dimensions, topK: 10, minScore: 0, warmup, samples },
    vector: [], codeSearch: [],
    limitations: [
      "Synthetic vectors; no production database, SQL I/O, embedding quality or index lifecycle measurement.",
      "Vector query timings exclude loading/conversion; processWallMs includes startup, fixture I/O, conversion, warmup and queries.",
      "JSON modes materialize JSON from binary fixtures; this startup cost is not a SQLite read benchmark.",
      "RSS is sampled per child every 100 ms using ps on macOS/Linux; it may miss peaks and is null on Windows.",
      "Code search timer delay is a scheduled zero-delay timer, not a production event-loop percentile; API RSS excludes ripgrep.",
      "Seven default samples are an exploratory comparison, not an SLA or a statistical confidence interval.",
    ],
  };
  for (const rows of sizes) {
    const fixture = join(work, `vectors-${rows}.bin`);
    await createFixture(fixture, rows, dimensions, samples + warmup, 10);
    const cases = [];
    let reference;
    for (const mode of ["json-sort", "json-topk", "typed-topk", "rust-topk"]) {
      const result = mode === "rust-topk"
        ? await measureChild(rustBinary, [fixture])
        : await measureChild(process.execPath, ["scripts/vector-benchmark-worker.mjs", mode, fixture]);
      reference ??= result.queries;
      let maxScoreDelta = 0;
      for (const [i, query] of result.queries.entries()) {
        const expected = reference[i];
        if (JSON.stringify(query.hits.map((h) => h.index)) !== JSON.stringify(expected.hits.map((h) => h.index))) throw new Error(`Result mismatch: ${mode}, ${rows}, query ${i}`);
        query.hits.forEach((hit, j) => { maxScoreDelta = Math.max(maxScoreDelta, Math.abs(hit.score - expected.hits[j].score)); });
      }
      if (maxScoreDelta > 1e-12) throw new Error(`Score mismatch: ${mode}`);
      const sampleMs = result.queries.slice(warmup).map((q) => q.ms);
      const { queries: _queries, ...metrics } = result;
      cases.push({ mode, ...metrics, ...quantiles(sampleMs), sampleMs, parity: { queries: samples + warmup, identicalIds: true, maxScoreDelta } });
      process.stdout.write(`${rows} x ${dimensions} ${mode}: P95 ${quantiles(sampleMs).p95Ms.toFixed(2)} ms\n`);
    }
    report.vector.push({ rows, cases });
    await rm(fixture);
  }
  const codeRoot = join(work, "code");
  await mkdir(codeRoot);
  const files = integer("files", 1000, 10000);
  for (let i = 0; i < files; i++) await writeFile(join(codeRoot, `${String(i).padStart(5, "0")}.txt`), "const value = 'ordinary source text';\n".repeat(256) + `needle ${i}\n`);
  const search = new RipgrepCodeSearch();
  for (const query of ["missing-value", `needle ${files - 1}`, "needle"]) {
    let expected;
    for (const mode of ["legacy-sync", "ripgrep"]) {
      const sampleMs = [], timerDelayMs = [];
      for (let i = 0; i < warmup + samples; i++) {
        await pause(1);
        const begin = performance.now();
        const tick = pause(0).then(() => performance.now() - begin);
        const hits = mode === "ripgrep" ? await search.search({ root: codeRoot, path: ".", query, caseSensitive: false, maxResults: 50 }) : legacySearch(codeRoot, query, 50);
        const duration = performance.now() - begin;
        const timerDelay = await tick;
        expected ??= JSON.stringify(hits);
        if (JSON.stringify(hits) !== expected) throw new Error(`Code search mismatch: ${query}`);
        if (i >= warmup) { sampleMs.push(duration); timerDelayMs.push(timerDelay); }
      }
      report.codeSearch.push({ mode, query, files, ...quantiles(sampleMs), sampleMs, timerDelayMs, apiRssSampleBytes: process.memoryUsage().rss, identicalResults: true });
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`Report: ${output}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
