import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { verifyNativeArtifact, type NativeArtifact } from "./artifact.js";
import { assertNativeParams, decodeNativeResponse, NATIVE_LIMITS, type NativeMethod, type NativeParams, type NativeResult } from "./protocol.js";

/** One serial stream per component; timed-out or cancelled work loses the process and all cached state. */
export class NativeRuntimeClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { id: number; method: NativeMethod; resolve: (value: unknown) => void; reject: (error: Error) => void };
  private sequence = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private idle?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private invalidation = 0;
  private handshakenEpoch = -1;
  private closing = false;
  constructor(private readonly artifact: NativeArtifact, private readonly options: { args?: string[]; timeoutMs?: number; idleMs?: number } = {}) {}
  get epoch(): number { return this.generation; }
  get running(): boolean { return Boolean(this.child); }
  get pid(): number | undefined { return this.child?.pid; }
  async request<M extends NativeMethod>(method: M, ...args: NativeParams<M> extends Record<string, never>
    ? [params?: NativeParams<M>, signal?: AbortSignal] : [params: NativeParams<M>, signal?: AbortSignal]): Promise<NativeResult<M>> {
    const [params = {}, signal] = args;
    if (this.closing) throw new Error("native_client_closed");
    signal?.throwIfAborted();
    if (this.queued >= NATIVE_LIMITS.queuedRequests) throw new Error("native_client_busy");
    this.queued++;
    const invalidation = this.invalidation;
    const result = this.chain.then(() => this.call(method, params, signal, invalidation));
    this.chain = result.catch(() => undefined);
    try { return await result as NativeResult<M>; } finally { this.queued--; }
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
        if (recordBytes > NATIVE_LIMITS.outputBytes) return fail(new Error("native_output_limit"));
        chunks.push(part);
        if (end < 0) break;
        const line = Buffer.concat(chunks, recordBytes); chunks = []; recordBytes = 0;
        offset = end + 1;
        try {
          const pending = this.pending;
          if (!pending) throw new Error("native_response_invalid");
          const response = decodeNativeResponse(pending.method, pending.id, JSON.parse(line.toString("utf8")));
          this.pending = undefined;
          if ("error" in response) pending.reject(new Error(response.error)); else pending.resolve(response.result);
        } catch { return fail(new Error("native_response_invalid")); }
      }
    });
    child.once("close", () => {
      if (this.child !== child) return;
      this.child = undefined; this.pending?.reject(new Error("native_process_exited")); this.pending = undefined;
    });
  }
  private async call(method: NativeMethod, params: unknown, signal: AbortSignal | undefined, invalidation: number): Promise<unknown> {
    this.assertCurrent(invalidation);
    signal?.throwIfAborted(); clearTimeout(this.idle);
    try { assertNativeParams(method, params); }
    catch (error) { await this.stop(); throw error; }
    await this.start(invalidation);
    this.assertCurrent(invalidation);
    const deadline = Date.now() + (this.options.timeoutMs ?? 10_000);
    if (this.handshakenEpoch !== this.generation && method !== "hello") {
      await this.exchange("hello", {}, signal, invalidation, deadline);
    }
    return this.exchange(method, params, signal, invalidation, deadline);
  }
  private async exchange(method: NativeMethod, params: unknown, signal: AbortSignal | undefined, invalidation: number, deadline: number): Promise<unknown> {
    this.assertCurrent(invalidation);
    signal?.throwIfAborted(); clearTimeout(this.idle);
    const id = ++this.sequence;
    const message = JSON.stringify({ id, method, params }) + "\n";
    if (Buffer.byteLength(message) > NATIVE_LIMITS.inputBytes) throw new Error("native_input_limit");
    if (signal?.aborted) { await this.stop(); signal.throwIfAborted(); }
    if (Date.now() >= deadline) { await this.stop(); throw new Error("native_request_timeout"); }
    const child = this.child;
    if (!child) throw new Error("native_process_exited");
    const promise = new Promise<unknown>((resolve, reject) => { this.pending = { id, method, resolve, reject }; });
    const abort = () => { this.pending?.reject(new Error("native_request_cancelled")); this.pending = undefined; void this.stop(); };
    const timer = setTimeout(() => { this.pending?.reject(new Error("native_request_timeout")); this.pending = undefined; void this.stop(); }, Math.max(1, deadline - Date.now()));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      child.stdin.write(message);
      const result = await promise;
      if (method === "hello") {
        const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
        if ((result as NativeResult<"hello">).platform !== platform) { await this.stop(); throw new Error("native_protocol_platform_mismatch"); }
        this.handshakenEpoch = this.generation;
      }
      return result;
    }
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
