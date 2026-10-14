import { expect, it } from "vitest";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

it.each(["drain", "hung"])("SIGTERM %s observes database-close ordering and real exit status", async mode => {
  const root = await mkdtemp(join(tmpdir(), "avx-worker-exit-"));
  const child = fork(fileURLToPath(new URL("./fixtures/shutdown-process.ts", import.meta.url)), [root, mode], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stderr!.on("data", chunk => { output += String(chunk); });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const started = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Child exited before work: ${code} ${output}`)));
    child.on("message", message => { if (message === "started") resolve(); });
  });
  child.on("message", message => { if (message === "stopping") child.send("release"); });
  try {
    await started;
    child.kill("SIGTERM");
    const result = await closed;
    expect(result, output).toEqual({ code: mode === "hung" ? 1 : 0, signal: null });
    const events = (await readFile(join(root, "events"), "utf8")).trim().split("\n");
    if (mode === "drain") expect(events).toEqual(["started", "shutdown", "written", "closed-0", "closed-1"]);
    else {
      expect(events.join("\n")).toContain("worker_shutdown_timeout");
      expect(events.some(event => event.startsWith("closed-") || event === "written")).toBe(false);
    }
    for (const filename of ["main.db", "vault.db"]) {
      const reader = createClient({ url: `file:${join(root, filename)}` });
      try {
        const rows = (await reader.execute("SELECT value FROM shutdown_probe")).rows;
        expect(rows.map(row => row.value)).toEqual(mode === "drain" ? ["finished"] : []);
      } finally { reader.close(); }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
