import { afterEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { NativeRuntimeClient, verifyNativeArtifact, type NativeArtifact } from "../src/index.js";

const work: string[] = [], clients: NativeRuntimeClient[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), "aervox-native-")); work.push(path); return path; }
async function nativeArtifact(): Promise<NativeArtifact> {
  const directory = fileURLToPath(new URL(`../dist/bin/${process.platform}-${process.arch}/`, import.meta.url));
  const manifest = JSON.parse(await readFile(join(directory, "artifact.json"), "utf8"));
  return { binary: join(directory, manifest.binary), sha256: manifest.sha256 };
}
function client(artifact: NativeArtifact, options?: ConstructorParameters<typeof NativeRuntimeClient>[1]) {
  const value = new NativeRuntimeClient(artifact, options); clients.push(value); return value;
}
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.close())); await Promise.all(work.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

describe("native artifact and stream boundaries", () => {
  it("checks protocol compatibility before sending a business request", async () => {
    const path = await directory(), fake = join(path, "incompatible.cjs"), calls = join(path, "calls.jsonl");
    const binary = process.execPath, sha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
    await writeFile(fake, `const fs = require('node:fs');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        fs.appendFileSync(process.argv[2], JSON.stringify(request.method) + '\\n');
        process.stdout.write(JSON.stringify({ id: request.id, result: { protocol: 2, version: 'future', platform: 'macos' } }) + '\\n');
      });`);
    const runtime = client({ binary, sha256 }, { args: [fake, calls] });
    await expect(runtime.request("vector.open", { path: join(path, "unused.db") })).rejects.toThrow("native_response_invalid");
    await runtime.close();
    expect((await readFile(calls, "utf8")).trim()).toBe('"hello"');
    expect(runtime.running).toBe(false);
  });
  it("keeps component instances independent and handshakes a replacement process", async () => {
    const first = client(await nativeArtifact()), second = client(await nativeArtifact());
    await first.request("hello"); await second.request("hello");
    const firstEpoch = first.epoch, secondPid = second.pid;
    expect(first.pid).not.toBe(secondPid);
    process.kill(first.pid!, "SIGKILL");
    await expect.poll(() => first.running).toBe(false);
    expect(await second.request("vector.clear")).toEqual({ cleared: true });
    expect(second.pid).toBe(secondPid);
    expect(await first.request("vector.clear")).toEqual({ cleared: true });
    expect(first.epoch).toBeGreaterThan(firstEpoch);
  });
  it("checks digest and trusted Ed25519 signature before launch", async () => {
    const artifact = await nativeArtifact();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signature = sign(null, Buffer.from(artifact.sha256, "hex"), privateKey).toString("base64");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(await verifyNativeArtifact({ ...artifact, signature, publicKey: pem, requireSignature: true })).toBe(artifact.binary);
    await expect(verifyNativeArtifact({ ...artifact, requireSignature: true })).rejects.toThrow("signature_required");
    await expect(verifyNativeArtifact({ ...artifact, sha256: "0".repeat(64) })).rejects.toThrow("digest_mismatch");
    await expect(verifyNativeArtifact({ ...artifact, signature: Buffer.alloc(64).toString("base64"), publicKey: pem })).rejects.toThrow("signature_invalid");
  });
  it("rejects malformed responses, cancels and times out without leaving a live process", async () => {
    const path = await directory();
    const binary = process.execPath, sha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
    const fake = join(path, "fake.cjs");
    await writeFile(fake, "process.stdin.on('data',()=>process.stdout.write(JSON.stringify({id:999,result:{}})+'\\n'));process.stdin.resume()");
    const malformed = client({ binary, sha256 }, { args: [fake] });
    await expect(malformed.request("hello")).rejects.toThrow("response_invalid");
    await malformed.reset(); expect(malformed.running).toBe(false);
    await writeFile(fake, "process.stdin.resume();setInterval(()=>{},1000)");
    const timed = client({ binary, sha256 }, { args: [fake], timeoutMs: 50 });
    await expect(timed.request("hello")).rejects.toThrow("timeout");
    await timed.reset(); expect(timed.running).toBe(false);
    const aborted = client({ binary, sha256 }, { args: [fake] });
    const controller = new AbortController();
    const pending = aborted.request("hello", {}, controller.signal);
    const assertion = expect(pending).rejects.toThrow(/cancelled|aborted/iu);
    setTimeout(() => controller.abort(), 50); await assertion;
    await aborted.reset(); expect(aborted.running).toBe(false);
  });
});

describe("SQLite native cache", () => {
  it("preserves scores and ties and observes external update/delete/model changes", async () => {
    const path = join(await directory(), "vectors.db");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE memory_embeddings (memory_id TEXT, model_id TEXT, embedding_json TEXT)");
    const add = db.prepare("INSERT INTO memory_embeddings VALUES (?,?,?)");
    add.run("a", "m", "[1,0]"); add.run("b", "m", "[1,0]"); add.run("zero", "m", "[0,0]"); add.run("negative", "m", "[-1,0]"); add.run("other", "other", "[0,1]");
    const runtime = client(await nativeArtifact());
    try {
      expect(await runtime.request("vector.open", { path })).toEqual({ readonly: true });
      const search = (modelId = "m", query = [1, 0], minScore = 0) => runtime.request("vector.search", { modelId, query, minScore, topK: 3 });
      expect((await search()).hits).toEqual([{ id: "a", score: 1 }, { id: "b", score: 1 }, { id: "zero", score: 0 }]);
      expect((await search()).cacheHit).toBe(true);
      db.prepare("UPDATE memory_embeddings SET embedding_json=? WHERE memory_id=?").run("[0,1]", "a");
      expect((await search()).hits.map(h => h.id)).toEqual(["b", "a", "zero"]);
      db.prepare("DELETE FROM memory_embeddings WHERE memory_id=?").run("b");
      expect((await search("m", [1, 0], 0.1)).hits).toEqual([]);
      expect((await search("other", [0, 1])).hits).toEqual([{ id: "other", score: 1 }]);
      expect((await search("m", [0, 0])).hits.map(h => h.id)).toEqual(["a", "zero", "negative"]);
      await runtime.reset(); await runtime.request("vector.open", { path });
      expect((await search()).cacheHit).toBe(false);
    } finally { db.close(); }
  });
});

describe("activity control", () => {
  it("invalidates queued work on revoke before it can start a replacement helper", async () => {
    const runtime = client(await nativeArtifact());
    const first = runtime.request("hello"), queued = runtime.request("hello");
    const assertions = [expect(first).rejects.toThrow("reset"), expect(queued).rejects.toThrow("reset")];
    await runtime.reset(); await Promise.all(assertions);
    expect(runtime.running).toBe(false);
    expect(await runtime.request("hello")).toMatchObject({ protocol: 1 });
  });
  it("reports the real platform and refuses capture without a current lease", async () => {
    const runtime = client(await nativeArtifact());
    expect(await runtime.request("hello")).toMatchObject({ protocol: 1 });
    const probe = await runtime.request("activity.probe");
    expect(typeof probe.ready).toBe("boolean");
    await expect(runtime.request("activity.capture", { deviceId: "d", revisionId: "r", epoch: "e" })).rejects.toThrow("lease");
    expect(await runtime.request("activity.revoke")).toEqual({ stopped: true });
  });
});

describe("audio compute", () => {
  it("decodes stereo PCM and resamples with bounded binary output", async () => {
    const b = Buffer.alloc(44 + 8);
    b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
    b.write("data", 36); b.writeUInt32LE(8, 40); [32767, -32767, 16384, 16384].forEach((v,i) => b.writeInt16LE(v, 44+i*2));
    const runtime = client(await nativeArtifact());
    const result = await runtime.request("audio.preprocess", { wav: b.toString("base64") });
    const bytes = Buffer.from(result.pcm, "base64");
    expect(result).toMatchObject({ sampleRate: 16000, frames: 4 });
    expect(Array.from({ length: 4 }, (_,i) => bytes.readFloatLE(i*4))).toEqual([0, 0.25, 0.5, 0.5]);
    b.writeUInt16LE(24, 34);
    await expect(runtime.request("audio.preprocess", { wav: b.toString("base64") })).rejects.toThrow("format_unsupported");
  });
});
