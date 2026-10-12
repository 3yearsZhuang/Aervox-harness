import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeArtifact {
  binary: string;
  sha256: string;
  /** Ed25519 signature of the binary digest; public key belongs to the trusted release. */
  signature?: string;
  publicKey?: string;
  requireSignature?: boolean;
}
export async function verifyNativeArtifact(artifact: NativeArtifact): Promise<string> {
  if (!isAbsolute(artifact.binary) || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error("native_artifact_invalid");
  const binary = await realpath(artifact.binary);
  const bytes = await readFile(binary);
  const digest = createHash("sha256").update(bytes).digest();
  if (digest.toString("hex") !== artifact.sha256) throw new Error("native_artifact_digest_mismatch");
  if (artifact.requireSignature || artifact.signature || artifact.publicKey) {
    if (!artifact.signature || !artifact.publicKey) throw new Error("native_artifact_signature_required");
    const key = createPublicKey(artifact.publicKey);
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, digest, key, Buffer.from(artifact.signature, "base64"))) throw new Error("native_artifact_signature_invalid");
  }
  return binary;
}

/** One serial stream per component; timed-out or cancelled work loses the process and all cached state. */
export class NativeRuntimeClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void };
  private sequence = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private idle?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private invalidation = 0;
  private closing = false;
  constructor(private readonly artifact: NativeArtifact, private readonly options: { args?: string[]; timeoutMs?: number; idleMs?: number } = {}) {}
  get epoch(): number { return this.generation; }
  get running(): boolean { return Boolean(this.child); }
  get pid(): number | undefined { return this.child?.pid; }
  async request<T>(method: string, params: unknown = {}, signal?: AbortSignal): Promise<T> {
    if (this.closing) throw new Error("native_client_closed");
    signal?.throwIfAborted();
    if (this.queued >= 16) throw new Error("native_client_busy");
    this.queued++;
    const invalidation = this.invalidation;
    const result = this.chain.then(() => this.call<T>(method, params, signal, invalidation));
    this.chain = result.catch(() => undefined);
    try { return await result; } finally { this.queued--; }
  }
  private assertCurrent(invalidation: number): void {
    if (this.closing) throw new Error("native_client_closed");
    if (invalidation !== this.invalidation) throw new Error("native_client_reset");
  }
  private async start(invalidation: number): Promise<void> {
    await this.stopping;
    this.assertCurrent(invalidation);
    if (this.child) return;
    const binary = await verifyNativeArtifact(this.artifact);
    this.assertCurrent(invalidation);
    const child = spawn(binary, this.options.args ?? [], { shell: false, windowsHide: true, stdio: "pipe" });
    this.child = child; this.generation++;
    let chunks: Buffer[] = []; let recordBytes = 0;
    const fail = (error: Error) => { if (this.child === child) { this.pending?.reject(error); this.pending = undefined; void this.stop(); } };
    child.on("error", fail);
    child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail);
    // Diagnostics deliberately omit stderr and request payloads: they can contain paths, grants or audio.
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
        recordBytes += part.length;
        if (recordBytes > 64 * 1024 * 1024) return fail(new Error("native_output_limit"));
        chunks.push(part);
        if (end < 0) break;
        const line = Buffer.concat(chunks, recordBytes); chunks = []; recordBytes = 0;
        offset = end + 1;
        try {
          const response = JSON.parse(line.toString("utf8")) as { id?: number; result?: unknown; error?: unknown };
          const pending = this.pending;
          if (!pending || response.id !== pending.id || ("result" in response) === ("error" in response)) throw new Error("native_response_invalid");
          this.pending = undefined;
          if (typeof response.error === "string") pending.reject(new Error(response.error)); else pending.resolve(response.result);
        } catch { return fail(new Error("native_response_invalid")); }
      }
    });
    child.once("close", () => {
      if (this.child !== child) return;
      this.child = undefined; this.pending?.reject(new Error("native_process_exited")); this.pending = undefined;
    });
  }
  private async call<T>(method: string, params: unknown, signal: AbortSignal | undefined, invalidation: number): Promise<T> {
    this.assertCurrent(invalidation);
    signal?.throwIfAborted(); clearTimeout(this.idle);
    const id = ++this.sequence;
    const message = JSON.stringify({ id, method, params }) + "\n";
    if (Buffer.byteLength(message) > 48 * 1024 * 1024) throw new Error("native_input_limit");
    await this.start(invalidation);
    this.assertCurrent(invalidation);
    if (signal?.aborted) { await this.stop(); signal.throwIfAborted(); }
    const child = this.child!;
    const promise = new Promise<T>((resolve, reject) => { this.pending = { id, resolve: resolve as (value: unknown) => void, reject }; });
    const abort = () => { this.pending?.reject(new Error("native_request_cancelled")); this.pending = undefined; void this.stop(); };
    const timer = setTimeout(() => { this.pending?.reject(new Error("native_request_timeout")); this.pending = undefined; void this.stop(); }, this.options.timeoutMs ?? 10_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { child.stdin.write(message); return await promise; }
    finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      this.idle = setTimeout(() => { void this.stop(); }, this.options.idleMs ?? 30_000); this.idle.unref();
    }
  }
  private stopping?: Promise<void>;
  private stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child; this.child = undefined; clearTimeout(this.idle);
    if (!child) return Promise.resolve();
    const operation = new Promise<void>((resolve) => {
      const escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("close", () => { clearTimeout(escalation); resolve(); });
      child.stdin.end(); // EOF gives the native supervisor a chance to reap its owned process trees.
    });
    this.stopping = operation;
    void operation.finally(() => { if (this.stopping === operation) this.stopping = undefined; });
    return operation;
  }
  async reset(): Promise<void> {
    this.invalidation++;
    this.pending?.reject(new Error("native_client_reset")); this.pending = undefined;
    await this.stop();
  }
  async close(): Promise<void> {
    this.closing = true; this.pending?.reject(new Error("native_client_closed")); this.pending = undefined;
    await this.stop(); await this.chain;
  }
}

export function nativeArtifactFromEnvironment(env: NodeJS.ProcessEnv = process.env): NativeArtifact | undefined {
  const binary = env.AERVOX_NATIVE_BINARY?.trim(), sha256 = env.AERVOX_NATIVE_SHA256?.trim();
  if (!binary && !sha256) return undefined;
  if (!binary || !sha256) throw new Error("native_artifact_configuration_incomplete");
  return { binary, sha256 };
}

export async function loadNativeArtifact(manifestPath?: string): Promise<NativeArtifact | undefined> {
  const path = manifestPath ?? fileURLToPath(new URL(`./bin/${process.platform}-${process.arch}/artifact.json`, import.meta.url));
  let bytes: Buffer;
  try { bytes = await readFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (bytes.length > 8192) throw new Error("native_artifact_manifest_limit");
  const manifest = JSON.parse(bytes.toString("utf8")) as { protocol: number; platform: string; arch: string; binary: string; sha256: string; signature?: string };
  if (manifest.protocol !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch
    || manifest.binary !== (process.platform === "win32" ? "aervox-native.exe" : "aervox-native")) throw new Error("native_artifact_platform_mismatch");
  return { binary: join(dirname(path), manifest.binary), sha256: manifest.sha256, signature: manifest.signature };
}

export class NativeAudioPreprocessor {
  private readonly runtime: NativeRuntimeClient;
  constructor(artifact: NativeArtifact) { this.runtime = new NativeRuntimeClient(artifact); }
  async preprocess(wav: Buffer, signal?: AbortSignal): Promise<Float32Array> {
    if (wav.length > 20 * 1024 * 1024) throw new Error("native_audio_input_limit");
    const result = await this.runtime.request<{ pcm: string; frames: number; sampleRate: number }>("audio.preprocess", { wav: wav.toString("base64") }, signal);
    if (!Number.isSafeInteger(result.frames) || result.frames < 1 || result.frames > 16000 * 600 || result.sampleRate !== 16000 || typeof result.pcm !== "string") throw new Error("native_audio_response_invalid");
    const bytes = Buffer.from(result.pcm, "base64");
    if (bytes.length !== result.frames * 4) throw new Error("native_audio_response_invalid");
    const samples = new Float32Array(result.frames);
    for (let i = 0; i < samples.length; i++) { samples[i] = bytes.readFloatLE(i * 4); if (!Number.isFinite(samples[i])) throw new Error("native_audio_response_invalid"); }
    return samples;
  }
  close(): Promise<void> { return this.runtime.close(); }
}
