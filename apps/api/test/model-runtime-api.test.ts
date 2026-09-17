/**
 * Aervox｜思隅 @aervox/api — 模型运行时服务与路由集成测试（CR-054）
 *
 * 通过 buildApp 注入 modelRuntimeOptions（临时模型目录 + fake spawn/health），
 * 用真实本地 http 服务执行下载闭环，验证：状态快照、下载→注册表、启动→运行、
 * 停止→空闲、单任务队列 409、断点续传、模型删除。
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

beforeAll(async () => {
  server = http.createServer((req, res) => {
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

describe("Model Runtime API (CR-054)", () => {
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

    const dlRes = await app.inject({
      method: "POST",
      url: "/v1/model-runtime/downloads",
      headers,
      payload: { url: modelUrl },
    });
    expect(dlRes.statusCode).toBe(200);
    const dlBody = JSON.parse(dlRes.payload);
    expect(dlBody.download.status).toBe("done");
    expect(dlBody.download.modelId).toBe("qwen2.5-7b-instruct");
    expect(dlBody.download.resumableFrom).toBeUndefined();

    const afterDownload = JSON.parse((await app.inject({ method: "GET", url: "/v1/model-runtime/state", headers })).payload);
    expect(afterDownload.models).toHaveLength(1);
    expect(afterDownload.models[0].fileName).toBe("qwen2.5-7b-instruct.gguf");
    expect(afterDownload.models[0].sha256).toBe(createHash("sha256").update(MODEL_PAYLOAD).digest("hex"));
    expect(await fs.readFile(path.join(modelsDir, "qwen2.5-7b-instruct.gguf"), "utf8")).toBe(MODEL_PAYLOAD.toString("utf8"));

    const dupRes = await app.inject({ method: "POST", url: "/v1/model-runtime/downloads", headers, payload: { url: modelUrl } });
    expect(dupRes.statusCode).toBe(400);
    expect(JSON.parse(dupRes.payload).code).toBe("DOWNLOAD_FAILED");

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
      expect(dlBody.download.modelId).toBe("qwen-resume");
      expect(dlBody.download.resumableFrom).toBeGreaterThan(0);
      expect(dlBody.download.status).toBe("done");
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
});
