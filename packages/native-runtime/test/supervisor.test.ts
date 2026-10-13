import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { NativeRuntimeClient } from "../src/index.js";

async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
describe("native process ownership", () => {
  it("owns one directory, verifies readiness and digest, reaps descendants and releases the lock", async () => {
    const work = await mkdtemp(join(tmpdir(), "aervox-supervisor-"));
    const bin = fileURLToPath(new URL(`../dist/bin/${process.platform}-${process.arch}/`, import.meta.url));
    const artifact = JSON.parse(await readFile(join(bin, "artifact.json"), "utf8"));
    const native = { binary: join(bin, artifact.binary), sha256: artifact.sha256 };
    const manifest = join(work, "manifest.json"), script = join(work, "child.cjs"), descendants = join(work, "pids.json");
    const port = await freePort();
    await writeFile(script, "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[3],JSON.stringify([process.pid,child.pid]));require('node:http').createServer((req,res)=>res.end('ready')).listen(Number(process.argv[2]),'127.0.0.1');");
    const config = { protocol: 1, version: "test", dataDir: work, processes: [{ role: "api", executable: process.execPath,
      sha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"), cwd: work, args: [script, String(port), descendants], ready: { port, path: "/health" }, startupMs: 3000 }] };
    await writeFile(manifest, JSON.stringify(config));
    const owner = new NativeRuntimeClient(native, { args: ["supervise", manifest], idleMs: 60_000 });
    const duplicate = new NativeRuntimeClient(native, { args: ["supervise", manifest], timeoutMs: 2000 });
    let pids: number[] = [];
    try {
      await owner.request("hello");
      await expect(duplicate.request("hello")).rejects.toThrow();
      const result = await owner.request("supervisor.start");
      expect(result.processes).toHaveLength(1);
      pids = JSON.parse(await readFile(descendants, "utf8"));
      expect(pids.every(alive)).toBe(true);
      expect(await owner.request("supervisor.stop")).toMatchObject({ processes: [] });
      await expect.poll(() => pids.some(alive), { timeout: 5000 }).toBe(false);
      await owner.request("supervisor.start");
      pids = JSON.parse(await readFile(descendants, "utf8"));
      process.kill(owner.pid!, "SIGKILL");
      await expect.poll(() => pids.some(alive), { timeout: 5000 }).toBe(false);
      await owner.close();
      await duplicate.reset();
      expect(await duplicate.request("hello")).toMatchObject({ protocol: 1 });
      // The executable fingerprint is checked again for every launch.
      await duplicate.close(); config.processes[0]!.sha256 = "0".repeat(64);
      await writeFile(manifest, JSON.stringify(config));
      const bad = new NativeRuntimeClient(native, { args: ["supervise", manifest] });
      try { await expect(bad.request("supervisor.start")).rejects.toThrow("digest_mismatch"); } finally { await bad.close(); }
    } finally { await owner.close(); await duplicate.close(); await rm(work, { recursive: true, force: true }); }
  });
});
