/**
 * Aervox｜思隅 @aervox/api — 模型运行时服务与路由集成测试（CR-054 迭代 v2）
 *
 * 通过 buildApp 注入 modelRuntimeOptions（临时模型目录 + fake spawn/health），
 * 用真实本地 http 服务执行下载闭环，验证：状态快照、下载→注册表、启动→运行、
 * 停止→空闲、重复下载 409、断点续传、模型删除；
 * v2 新增：精选目录、多任务并发（缺省 2）、暂停/恢复/取消 .part 语义、
 * 限速参数闭环、SSE 实时推送（建连快照 + 状态变更推送）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createInMemoryDatabase, type AervoxDatabase } from "@aervox/repositories";
import type { Client } from "@libsql/client";

const MODEL_PAYLOAD = Buffer.from("aervox-model-runtime-e2e\n".repeat(64));
let server: http.Server;
let modelUrl: string;

/** 慢速分块下载端点（/slow-<id>.gguf）：每块间隔推送，用于多任务/暂停/取消的确定性验证 */
function isSlowDownloadUrl(url: string | undefined): boolean {
  return Boolean(url && /\/slow-[A-Za-z0-9_-]+\.gguf$/.test(url));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (isSlowDownloadUrl(req.url)) {
      const range = req.headers.range;
      let start = 0;
      if (range) {
        const m = /bytes=(\d+)-/.exec(String(range));
        if (m) start = Number(m[1]);
      }
      if (start >= MODEL_PAYLOAD.length) {
        res.writeHead(416, { "Content-Range": `bytes */${MODEL_PAYLOAD.length}` });
        res.end();
        return;
      }
      const slice = MODEL_PAYLOAD.subarray(start);
      res.writeHead(start > 0 ? 206 : 200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(slice.length),
        ...(start > 0 ? { "Content-Range": `bytes ${start}-${MODEL_PAYLOAD.length - 1}/${MODEL_PAYLOAD.length}` } : {}),
      });
      // ~20 块 × 80ms ≈ 1.6s 完成，为并发/暂停断言留足窗口
      const chunkSize = Math.ceil(slice.length / 20);
      let i = 0;
      const timer = setInterval(() => {
        if (i >= slice.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        const end = Math.min(i + chunkSize, slice.length);
        res.write(slice.subarray(i, end));
        i = end;
      }, 80);
      return;
    }
    if (req.url === "/qwen2.5-7b-instruct.gguf") {
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-/.exec(String(range));
        if (m) {
          const start = Number(m[1]);
          const slice = MODEL_PAYLOAD.subarray(start);
          res.writeHead(206, { "Content-Type": "application/octet-stream", "Content-Length": String(slice.length), "Content-Range": `bytes ${start}-${MODEL_PAYLOAD.length - 1}/${MODEL_PAYLOAD.length}` });
          res.end(slice);
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(MODEL_PAYLOAD.length) });
      res.end(MODEL_PAYLOAD);
      return;
    }
    if (req.url?.endsWith(".gguf")) {
      // 兜底：任意 .gguf 路径返回同一 payload（含 Range 续传语义）
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-/.exec(String(range));
        if (m) {
          const start = Number(m[1]);
          const slice = MODEL_PAYLOAD.subarray(start);
          res.writeHead(206, { "Content-Type": "application/octet-stream", "Content-Length": String(slice.length), "Content-Range": `bytes ${start}-${MODEL_PAYLOAD.length - 1}/${MODEL_PAYLOAD.length}` });
          res.end(slice);
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(MODEL_PAYLOAD.length) });
      res.end(MODEL_PAYLOAD);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  modelUrl = `http://127.0.0.1:${address.port}/qwen2.5-7b-instruct.gguf`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function createFakeChild() {
  const child = new EventEmitter() as unknown as ChildProcess & { killedSignal?: string | null };
  (child as { pid?: number }).pid = 9999;
  (child as { stdout?: unknown }).stdout = new PassThrough();
  (child as { stderr?: unknown }).stderr = new PassThrough();
  (child as { kill?: unknown }).kill = (signal?: string) => {
    (child as { killedSignal?: string | null }).killedSignal = signal ?? "SIGTERM";
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  return child;
}

const FAKE_LLAMA_DEPS = {
  resolveBin: () => "/fake/llama-server",
  spawn: (() => createFakeChild()) as unknown as typeof import("node:child_process").spawn,
  fetchImpl: (async () => new Response("ok", { status: 200 })) as typeof fetch,
  probeIntervalMs: 10,
  probeTimeoutMs: 2000,
};

/** 轮询 GET /state 直至满足条件（下载/启动异步完成场景） */
async function pollState(
  app: FastifyInstance,
  headers: Record<string, string>,
  pred: (body: any) => boolean,
  timeoutMs = 8000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: "/v1/model-runtime/state", headers });
    last = JSON.parse(res.payload);
    if (pred(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pollState 超时（${timeoutMs}ms）：` + JSON.stringify(last));
}

/** SSE 帧读取器：把字节流切分为 (event, data) 帧 */
class SseReader {
  private buffer = "";
  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly decoder = new TextDecoder(),
  ) {}

  async next(): Promise<{ event: string; data: string } | null> {
    for (;;) {
      const sep = this.buffer.indexOf("\n\n");
      if (sep >= 0) {
        const block = this.buffer.slice(0, sep);
        this.buffer = this.buffer.slice(sep + 2);
        return this.parseBlock(block);
      }
      const { done, value } = await this.reader.read();
      if (done) return null;
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  private parseBlock(block: string): { event: string; data: string } {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    return { event, data };
  }
}

describe("Model Runtime API (CR-054 v2)", () => {
  let db: AervoxDatabase;
  let client: Client;
  let modelsDir: string;

  beforeAll(async () => {
    modelsDir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mr-models-"));
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
  });

  afterAll(async () => {
    await fs.rm(modelsDir, { recursive: true, force: true });
  });

  it("下载→注册→启动→停止 全链路", async () => {
    const built = await buildApp({ db, client, modelRuntimeOptions: { modelsDir, llamaDeps: FAKE_LLAMA_DEPS } });
    const app = built.app;
    await app.ready();
    const headers = { "x-workspace-id": "ws_mrt", "x-user-id": "usr_mrt" };

    const initRes = await app.inject({ method: "GET", url: "/v1/model-runtime/state", headers });
    expect(initRes.statusCode).toBe(200);
    const initBody = JSON.parse(initRes.payload);
    expect(initBody.runtime.status).toBe("idle");
    expect(Array.isArray(initBody.models)).toBe(true);
    expect(Array.isArray(initBody.downloads)).toBe(true);

    const dlRes = await app.inject({
      method: "POST",
      url: "/v1/model-runtime/downloads",
      headers,
      payload: { url: modelUrl },
    });
    expect(dlRes.statusCode).toBe(200);
    const dlBody = JSON.parse(dlRes.payload);
    expect(dlBody.downloads.length).toBeGreaterThan(0);
    expect(dlBody.downloads[0].modelId).toBe("qwen2.5-7b-instruct");
    expect(["running", "done"].includes(dlBody.downloads[0].status)).toBe(true);

    await pollState(
      app,
      headers,
      (b) => b.models.some((m: { id: string }) => m.id === "qwen2.5-7b-instruct"),
    );
    const afterDownload = JSON.parse((await app.inject({ method: "GET", url: "/v1/model-runtime/state", headers })).payload);
    expect(afterDownload.models).toHaveLength(1);
    expect(afterDownload.models[0].fileName).toBe("qwen2.5-7b-instruct.gguf");
    expect(afterDownload.models[0].sha256).toBe(createHash("sha256").update(MODEL_PAYLOAD).digest("hex"));
    expect(afterDownload.models[0].sizeBytes).toBe(MODEL_PAYLOAD.length);
    expect(await fs.readFile(path.join(modelsDir, "qwen2.5-7b-instruct.gguf"), "utf8")).toBe(MODEL_PAYLOAD.toString("utf8"));

    // 模型已存在 → 服务端按 busy 返回 409（v2 语义），不再入队
    const dupRes = await app.inject({ method: "POST", url: "/v1/model-runtime/downloads", headers, payload: { url: modelUrl } });
    expect(dupRes.statusCode).toBe(409);
    expect(JSON.parse(dupRes.payload).code).toBe("DOWNLOAD_BUSY");

    const startRes = await app.inject({
      method: "POST",
      url: "/v1/model-runtime/start",
      headers,
      payload: { modelId: "qwen2.5-7b-instruct", params: { port: 8123, ctxSize: 4096 } },
    });
    expect(startRes.statusCode).toBe(200);
    const startBody = JSON.parse(startRes.payload);
    expect(startBody.runtime.status).toBe("running");
    expect(startBody.runtime.port).toBe(8123);
    expect(startBody.params.ctxSize).toBe(4096);

    const busyRes = await app.inject({
      method: "POST",
      url: "/v1/model-runtime/start",
      headers,
      payload: { modelId: "qwen2.5-7b-instruct" },
    });
    expect(busyRes.statusCode).toBe(409);

    const stopRes = await app.inject({ method: "POST", url: "/v1/model-runtime/stop", headers });
    expect(stopRes.statusCode).toBe(200);
    expect(JSON.parse(stopRes.payload).runtime.status).toBe("idle");

    await app.close();
  }, 20_000);

  it("断点续传：.part 存在时从 Range 续传并透出 resumableFrom 闭环（CR-054 迭代）", async () => {
    const built = await buildApp({ db, client, modelRuntimeOptions: { modelsDir, llamaDeps: FAKE_LLAMA_DEPS } });
    const app = built.app;
    await app.ready();
    const headers = { "x-workspace-id": "ws_dl2", "x-user-id": "usr_dl2" };
    try {
      const dest = path.join(modelsDir, "qwen-resume.gguf");
      await fs.writeFile(
        `${dest}.part`,
        MODEL_PAYLOAD.subarray(0, Math.floor(MODEL_PAYLOAD.length / 2)),
      );
      const dlRes = await app.inject({
        method: "POST",
        url: "/v1/model-runtime/downloads",
        headers,
        payload: { url: `${modelUrl.replace("qwen2.5-7b-instruct.gguf", "qwen-resume.gguf")}` },
      });
      const dlBody = JSON.parse(dlRes.payload);
      expect(dlBody.downloads[0].modelId).toBe("qwen-resume");
      expect(dlBody.downloads[0].resumableFrom).toBeGreaterThan(0);
      expect(["running", "done"].includes(dlBody.downloads[0].status)).toBe(true);
      await pollState(app, headers, (b) => b.models.some((m: { id: string }) => m.id === "qwen-resume"));
      expect(await fs.readFile(dest, "utf8")).toBe(MODEL_PAYLOAD.toString("utf8"));
    } finally {
      await app.close();
    }
  });

  it("删除模型：删除 .gguf 与侧车并退出注册表；运行中删除 409；不存在 404（CR-054 迭代）", async () => {
    const built = await buildApp({ db, client, modelRuntimeOptions: { modelsDir, llamaDeps: FAKE_LLAMA_DEPS } });
    const app = built.app;
    await app.ready();
    const headers = { "x-workspace-id": "ws_del", "x-user-id": "usr_del" };
    try {
      const dl = await app.inject({
        method: "POST",
        url: "/v1/model-runtime/downloads",
        headers,
        payload: { url: `${modelUrl.replace("qwen2.5-7b-instruct", "qwen-del")}` },
      });
      expect(dl.statusCode).toBe(200);
      await pollState(app, headers, (b) => b.models.some((m: { id: string }) => m.id === "qwen-del"));

      const start = await app.inject({
        method: "POST",
        url: "/v1/model-runtime/start",
        headers,
        payload: { modelId: "qwen-del" },
      });
      expect(start.statusCode).toBe(200);

      const busyDel = await app.inject({
        method: "DELETE",
        url: "/v1/model-runtime/models/qwen-del",
        headers,
      });
      expect(busyDel.statusCode).toBe(409);

      await app.inject({ method: "POST", url: "/v1/model-runtime/stop", headers });
      const delRes = await app.inject({
        method: "DELETE",
        url: "/v1/model-runtime/models/qwen-del",
        headers,
      });
      expect(delRes.statusCode).toBe(200);
      const after = JSON.parse(delRes.payload);
      expect(after.models.every((m: { id: string }) => m.id !== "qwen-del")).toBe(true);
      await expect(fs.access(path.join(modelsDir, "qwen-del.gguf"))).rejects.toThrow();

      const notFound = await app.inject({
        method: "DELETE",
        url: "/v1/model-runtime/models/nope",
        headers,
      });
      expect(notFound.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("模型不存在时启动返回 400", async () => {
    const res = await createInMemoryDatabase();
    const built = await buildApp({
      db: res.db,
      client: res.client,
      modelRuntimeOptions: { modelsDir },
    });
    const slimApp = built.app;
    await slimApp.ready();
    try {
      const startRes = await slimApp.inject({
        method: "POST",
        url: "/v1/model-runtime/start",
        headers: { "x-workspace-id": "w", "x-user-id": "u" },
        payload: { modelId: "not-downloaded-model" },
      });
      expect(startRes.statusCode).toBe(400);
      expect(JSON.parse(startRes.payload).code).toBe("RUNTIME_START_FAILED");
    } finally {
      await slimApp.close();
      await res.cleanup();
    }
  });

  it("精选目录：GET /catalog 返回内置 GGUF 清单（量化档位 + URL + 推荐参数）", async () => {
    const built = await buildApp({ db, client });
    const app = built.app;
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/model-runtime/catalog",
        headers: { "x-workspace-id": "ws_cat", "x-user-id": "usr_cat" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body.entries)).toBe(true);
      expect(body.entries.length).toBeGreaterThanOrEqual(4);
      const qwen = body.entries.find((e: { id: string }) => e.id === "qwen2.5-7b-instruct-q4-k-m");
      expect(qwen).toBeDefined();
      expect(qwen.family).toBe("Qwen2.5");
      expect(qwen.quant).toBe("Q4_K_M");
      expect(qwen.url).toMatch(/^https:\/\//);
      expect(qwen.recommendedParams?.ctxSize).toBe(8192);
    } finally {
      await app.close();
    }
  });

  it("多任务并发：缺省并发 2，第三任务排队，随后全部完成入库", async () => {
    const built = await buildApp({ db, client, modelRuntimeOptions: { modelsDir, llamaDeps: FAKE_LLAMA_DEPS } });
    const app = built.app;
    await app.ready();
    const headers = { "x-workspace-id": "ws_multi", "x-user-id": "usr_multi" };
    try {
      for (const name of ["slow-a", "slow-b", "slow-c"]) {
        const dl = await app.inject({
          method: "POST",
          url: "/v1/model-runtime/downloads",
          headers,
          payload: { url: `${modelUrl.replace("qwen2.5-7b-instruct.gguf", `${name}.gguf`)}` },
        });
        expect(dl.statusCode).toBe(200);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      const s = JSON.parse((await app.inject({ method: "GET", url: "/v1/model-runtime/state", headers })).payload);
      const running = s.downloads.filter((t: { status: string }) => t.status === "running").length;
      const queued = s.downloads.filter((t: { status: string }) => t.status === "queued").length;
      expect(running).toBe(2);
      expect(queued).toBe(1);
      expect(s.llamaServer.maxConcurrentDownloads).toBe(2);

      await pollState(
        app,
        headers,
        (b) => ["slow-a", "slow-b", "slow-c"].every((id) => b.models.some((m: { id: string }) => m.id === id)),
        15_000,
      );
      // 完成后任务移出活动队列，注册表含三个模型
      const done = JSON.parse((await app.inject({ method: "GET", url: "/v1/model-runtime/state", headers })).payload);
      expect(done.downloads).toEqual([]);
      for (const id of ["slow-a", "slow-b", "slow-c"]) {
        const m = done.models.find((x: { id: string }) => x.id === id);
        expect(m.sha256).toBe(createHash("sha256").update(MODEL_PAYLOAD).digest("hex"));
      }
    } finally {
      await app.close();
    }
  }, 25_000);

  it("暂停/恢复/取消：.part 断点保留、续传落盘、取消清理残片", async () => {
    const built = await buildApp({ db, client, modelRuntimeOptions: { modelsDir, llamaDeps: FAKE_LLAMA_DEPS } });
    const app = built.app;
    await app.ready();
    const headers = { "x-workspace-id": "ws_pse", "x-user-id": "usr_pse" };
    try {
      // 暂停：等待进入 running 且有字节后暂停，.part 保留
      await app.inject({
        method: "POST",
        url: "/v1/model-runtime/downloads",
        headers,
        payload: { url: `${modelUrl.replace("qwen2.5-7b-instruct.gguf", "slow-p.gguf")}` },
      });
      await pollState(
        app,
        headers,
        (b) => b.downloads.some((t: { id: string; status: string; receivedBytes?: number }) => t.id === "slow-p" && t.status === "running" && (t.receivedBytes ?? 0) > 0),
      );
      const pauseRes = await app.inject({ method: "POST", url: "/v1/model-runtime/downloads/slow-p/pause", headers });
      expect(pauseRes.statusCode).toBe(200);
      const pauseBody = JSON.parse(pauseRes.payload);
      const paused = pauseBody.downloads.find((t: { id: string }) => t.id === "slow-p");
      expect(paused.status).toBe("paused");
      expect(paused.receivedBytes).toBeGreaterThan(0);
      const partSize = (await fs.stat(path.join(modelsDir, "slow-p.gguf.part"))).size;
      expect(partSize).toBeGreaterThan(0);

      // 恢复：断点续传至完成
      const resumeRes = await app.inject({ method: "POST", url: "/v1/model-runtime/downloads/slow-p/resume", headers });
      expect(resumeRes.statusCode).toBe(200);
      await pollState(app, headers, (b) => b.models.some((m: { id: string }) => m.id === "slow-p"), 10_000);
      expect(await fs.readFile(path.join(modelsDir, "slow-p.gguf"), "utf8")).toBe(MODEL_PAYLOAD.toString("utf8"));

      // 取消：running 中取消 → 移出队列 + 清理 .part
      await app.inject({
        method: "POST",
        url: "/v1/model-runtime/downloads",
        headers,
        payload: { url: `${modelUrl.replace("qwen2.5-7b-instruct.gguf", "slow-q.gguf")}` },
      });
      await pollState(
        app,
        headers,
        (b) => b.downloads.some((t: { id: string; status: string; receivedBytes?: number }) => t.id === "slow-q" && t.status === "running" && (t.receivedBytes ?? 0) > 0),
      );
      const cancelRes = await app.inject({ method: "POST", url: "/v1/model-runtime/downloads/slow-q/cancel", headers });
      expect(cancelRes.statusCode).toBe(200);
      const cancelBody = JSON.parse(cancelRes.payload);
      expect(cancelBody.downloads.some((t: { id: string }) => t.id === "slow-q")).toBe(false);
      await expect(fs.access(path.join(modelsDir, "slow-q.gguf.part"))).rejects.toThrow();
    } finally {
      await app.close();
    }
  }, 25_000);

  it("限速：rateLimitBps 参数透出并约束下载速率（最小耗时下限）", async () => {
    const built = await buildApp({ db, client, modelRuntimeOptions: { modelsDir, llamaDeps: FAKE_LLAMA_DEPS } });
    const app = built.app;
    await app.ready();
    const headers = { "x-workspace-id": "ws_rate", "x-user-id": "usr_rate" };
    try {
      const t0 = Date.now();
      const dl = await app.inject({
        method: "POST",
        url: "/v1/model-runtime/downloads",
        headers,
        payload: {
          url: `${modelUrl.replace("qwen2.5-7b-instruct.gguf", "rate-limited.gguf")}`,
          rateLimitBps: 2048,
        },
      });
      expect(dl.statusCode).toBe(200);
      const body = JSON.parse(dl.payload);
      expect(body.downloads[0].rateLimitBps).toBe(2048);
      // 采样期：总量已知且已有字节推进
      await pollState(
        app,
        headers,
        (b) => b.downloads.some((t: { id: string; totalBytes?: number | null; receivedBytes?: number }) => t.id === "rate-limited" && t.totalBytes === MODEL_PAYLOAD.length && (t.receivedBytes ?? 0) > 0),
      );
      await pollState(app, headers, (b) => b.models.some((m: { id: string }) => m.id === "rate-limited"), 10_000);
      const elapsed = Date.now() - t0;
      // 1728 B @ 2048 B/s 理论 ≈0.84s；下限 400ms 容忍 CI 抖动，仍可识别未限速的瞬时完成
      expect(elapsed).toBeGreaterThanOrEqual(400);
    } finally {
      await app.close();
    }
  }, 20_000);

  it("SSE 事件流：建连即推快照，下载状态变更实时推送", async () => {
    const built = await buildApp({ db, client, modelRuntimeOptions: { modelsDir, llamaDeps: FAKE_LLAMA_DEPS } });
    const app = built.app;
    await app.ready();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const headers = { "x-workspace-id": "ws_sse", "x-user-id": "usr_sse" };
    const ac = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/model-runtime/events`, {
        headers: { ...headers, Accept: "text/event-stream" },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = new SseReader(res.body!.getReader());

      // 首帧：快照且下载队列为空
      const first = await reader.next();
      expect(first?.event).toBe("snapshot");
      expect(JSON.parse(first!.data).downloads).toEqual([]);

      // 触发慢速下载 → 应收到包含任务状态变更的快照
      await app.inject({
        method: "POST",
        url: "/v1/model-runtime/downloads",
        headers,
        payload: { url: `${modelUrl.replace("qwen2.5-7b-instruct.gguf", "slow-sse.gguf")}` },
      });
      const deadline = Date.now() + 10_000;
      let received = false;
      while (Date.now() < deadline) {
        const frame = await reader.next();
        if (!frame) break;
        if (frame.event !== "snapshot") continue;
        const data = JSON.parse(frame.data);
        const task = (data.downloads ?? []).find((t: { id: string }) => t.id === "slow-sse");
        if (task) {
          received = true;
          expect(["queued", "running", "paused"].includes(task.status)).toBe(true);
          expect(task.rateLimitBps).toBeUndefined();
          break;
        }
      }
      expect(received).toBe(true);
    } finally {
      ac.abort();
      await app.close();
    }
  }, 20_000);
});
