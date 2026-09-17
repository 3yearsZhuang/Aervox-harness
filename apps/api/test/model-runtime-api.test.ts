/**
 * Aervox｜思隅 @aervox/api — 模型运行时服务与路由集成测试（CR-054）
 *
 * 通过 buildApp 注入 modelRuntimeOptions（临时模型目录 + fake spawn/health），
 * 用真实本地 http 服务执行下载闭环，验证：状态快照、下载→注册表、启动→运行、
 * 停止→空闲、单任务队列 409。
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

describe("Model Runtime API (CR-054)", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let modelsDir: string;

  beforeAll(async () => {
    modelsDir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mr-models-"));
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
  });

  afterAll(async () => {
    await fs.rm(modelsDir, { recursive: true, force: true });
    if (cleanup) await cleanup();
  });

  it("下载→注册→启动→停止 全链路", async () => {
    const fakeSpawn = (() => createFakeChild()) as unknown as typeof import("node:child_process").spawn;
    const built = await buildApp({
      db,
      client,
      modelRuntimeOptions: {
        modelsDir,
        llamaDeps: {
          resolveBin: () => "/fake/llama-server",
          spawn: fakeSpawn,
          fetchImpl: (async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch,
          probeIntervalMs: 10,
          probeTimeoutMs: 2000,
        },
      },
    });
    app = built.app;
    await app.ready();

    const headers = { "x-workspace-id": "ws_mrt", "x-user-id": "usr_mrt" };

    // 初始状态：空模型 + idle + 未配置（resolveBin 注入仍视为 configured=true）
    const initRes = await app.inject({ method: "GET", url: "/v1/model-runtime/state", headers });
    expect(initRes.statusCode).toBe(200);
    const initBody = JSON.parse(initRes.payload);
    expect(initBody.runtime.status).toBe("idle");
    expect(Array.isArray(initBody.models)).toBe(true);

    // 发起下载（真实 http 流）
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

    // 状态快照：模型已注册且 SHA-256 与本地计算一致
    const afterDownload = JSON.parse((await app.inject({ method: "GET", url: "/v1/model-runtime/state", headers })).payload);
    expect(afterDownload.models).toHaveLength(1);
    expect(afterDownload.models[0].fileName).toBe("qwen2.5-7b-instruct.gguf");
    expect(afterDownload.models[0].sha256).toBe(createHash("sha256").update(MODEL_PAYLOAD).digest("hex"));
    const diskFile = await fs.readFile(path.join(modelsDir, "qwen2.5-7b-instruct.gguf"), "utf8");
    expect(diskFile).toBe(MODEL_PAYLOAD.toString("utf8"));

    // 重复下载同模型 → 拒绝
    const dupRes = await app.inject({ method: "POST", url: "/v1/model-runtime/downloads", headers, payload: { url: modelUrl } });
    expect(dupRes.statusCode).toBe(400);
    expect(JSON.parse(dupRes.payload).code).toBe("DOWNLOAD_FAILED");

    // 启动 llama-server
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

    // 运行中再启动 → 409 busy
    const busyRes = await app.inject({
      method: "POST",
      url: "/v1/model-runtime/start",
      headers,
      payload: { modelId: "qwen2.5-7b-instruct" },
    });
    expect(busyRes.statusCode).toBe(409);

    // 停止
    const stopRes = await app.inject({ method: "POST", url: "/v1/model-runtime/stop", headers });
    expect(stopRes.statusCode).toBe(200);
    expect(JSON.parse(stopRes.payload).runtime.status).toBe("idle");

    await app.close();
  }, 20_000);

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