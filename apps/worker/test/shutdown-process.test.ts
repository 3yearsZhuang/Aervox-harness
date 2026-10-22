import { expect, it } from "vitest";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { createNoopObservability } from "@aervox/observability";
import { registerWorkerShutdown } from "../src/shutdown.js";

async function runShutdown(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "avx-worker-exit-"));
  const child = fork(fileURLToPath(new URL("./fixtures/shutdown-process.ts", import.meta.url)), [root, mode], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  for (const stream of [child.stdout!, child.stderr!]) stream.on("data", chunk => { output += String(chunk); });
  let externallyKilled = false;
  let shutdownStartedAt = 0;
  let outerTimer: ReturnType<typeof setTimeout> | undefined;
  const duplicateTimers: ReturnType<typeof setTimeout>[] = [];
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const started = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Child exited before work: ${code} ${output}`)));
    child.on("message", message => { if (message === "started") resolve(); });
  });
  child.on("message", message => {
    if (message !== "stopping") return;
    child.send("release");
    if (mode === "duplicate") { child.kill("SIGINT"); child.kill("SIGTERM"); }
    if (mode === "health-hung") {
      duplicateTimers.push(setTimeout(() => child.kill("SIGINT"), 300), setTimeout(() => child.kill("SIGTERM"), 600));
    }
  });
  const startupTimer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    await started; clearTimeout(startupTimer);
    shutdownStartedAt = performance.now();
    outerTimer = setTimeout(() => { externallyKilled = true; child.kill("SIGKILL"); }, mode === "hung" ? 4000 : 2000);
    child.kill("SIGTERM");
    const result = await closed;
    const elapsedMs = performance.now() - shutdownStartedAt;
    const events = (await readFile(join(root, "events"), "utf8")).trim().split("\n");
    const rows: string[][] = [];
    for (const filename of ["main.db", "vault.db"]) {
      const reader = createClient({ url: `file:${join(root, filename)}` });
      try { rows.push((await reader.execute("SELECT value FROM shutdown_probe ORDER BY rowid")).rows.map(row => String(row.value))); }
      finally { reader.close(); }
    }
    return { result, events, rows, externallyKilled, elapsedMs, output };
  } finally {
    clearTimeout(startupTimer); clearTimeout(outerTimer);
    for (const timer of duplicateTimers) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed; await rm(root, { recursive: true, force: true });
  }
}

it.each(["drain", "dispose-write", "duplicate"])("SIGTERM %s drains and disposes before closing both databases", async mode => {
  const run = await runShutdown(mode);
  expect(run.result, run.output).toEqual({ code: 0, signal: null });
  expect(run.externallyKilled).toBe(false);
  const expected = ["started", "shutdown", "abort", "stop", "written", "drained", "dispose-start"];
  if (mode === "dispose-write") expected.push("dispose-written");
  expected.push("dispose-done", "health-close", "health-connections-closed", "health-closed", "closed-0", "closed-1");
  expect(run.events).toEqual(expected);
  expect(run.rows).toEqual(Array.from({ length: 2 }, () => mode === "dispose-write" ? ["finished", "disposed"] : ["finished"]));
});

it("SIGTERM hung job keeps the existing drain timeout without explicitly closing databases", async () => {
  const run = await runShutdown("hung");
  expect(run.result, run.output).toEqual({ code: 1, signal: null });
  expect(run.externallyKilled).toBe(false);
  expect(run.events.join("\n")).toContain("worker_shutdown_timeout");
  expect(run.events.some(event => event.startsWith("closed-") || event === "written" || event === "dispose-start")).toBe(false);
  expect(run.rows).toEqual([[], []]);
});

it.each(["dispose-hung", "health-hung"])("SIGTERM %s is bounded by the entire shutdown deadline", async mode => {
  const run = await runShutdown(mode);
  expect(run.result, JSON.stringify(run)).toEqual({ code: 1, signal: null });
  expect(run.externallyKilled).toBe(false);
  expect(run.events.join("\n")).toContain("worker_shutdown_deadline_exceeded");
  expect(run.events.join("\n")).toContain("worker.shutdown.failed");
  const failure = JSON.parse(run.events.find(event => event.startsWith("{"))!);
  expect(failure.fields).toEqual({
    phase: mode === "dispose-hung" ? "runtime" : "health",
    shutdownTimeoutMs: 700, elapsedMs: expect.any(Number),
  });
  expect(run.events.some(event => event.startsWith("closed-"))).toBe(false);
  expect(run.rows).toEqual([["finished"], ["finished"]]);
  expect(run.elapsedMs).toBeLessThan(1800);
  if (mode === "health-hung") {
    expect(run.events.filter(event => event === "shutdown" || event === "abort" || event === "stop")).toEqual(["shutdown", "abort", "stop"]);
    expect(failure.fields.elapsedMs).toBeLessThan(1050);
  }
});

it.each(["dispose-reject", "health-reject"])("SIGTERM %s fails without explicitly closing databases", async mode => {
  const run = await runShutdown(mode);
  expect(run.result, run.output).toEqual({ code: 1, signal: null });
  expect(run.externallyKilled).toBe(false);
  expect(run.events.join("\n")).toContain(mode === "dispose-reject" ? "runtime_dispose_rejected" : "health_close_rejected");
  expect(run.events.join("\n")).toContain("worker.shutdown.failed");
  expect(run.events.some(event => event.startsWith("closed-"))).toBe(false);
  expect(run.rows).toEqual([["finished"], ["finished"]]);
});

it("does not reset the shared deadline between host, runtime and health stages", async () => {
  const run = await runShutdown("shared-budget");
  expect(run.result, JSON.stringify(run)).toEqual({ code: 1, signal: null });
  expect(run.externallyKilled).toBe(false);
  expect(run.events).toContain("drained"); expect(run.events).toContain("dispose-done");
  expect(run.events).toContain("health-close");
  expect(run.events.join("\n")).toContain("worker_shutdown_deadline_exceeded");
  const failure = JSON.parse(run.events.find(event => event.startsWith("{"))!);
  expect(failure.fields).toEqual({ phase: "health", shutdownTimeoutMs: 800, elapsedMs: expect.any(Number) });
  expect(run.events.some(event => event.startsWith("closed-") || event === "health-closed")).toBe(false);
  expect(run.rows).toEqual([["finished"], ["finished"]]);
  expect(run.elapsedMs).toBeLessThan(1800);
});

it.each([0, -1, NaN, Infinity, 2 ** 31, 1.5])("rejects invalid whole-shutdown timer %s before registering signal listeners", shutdownTimeoutMs => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  expect(() => registerWorkerShutdown({
    host: { stop: async () => undefined }, clients: [], logger: createNoopObservability().log, shutdownTimeoutMs,
  } as Parameters<typeof registerWorkerShutdown>[0] & { shutdownTimeoutMs: number })).toThrow("invalid_worker_shutdown_deadline");
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});
