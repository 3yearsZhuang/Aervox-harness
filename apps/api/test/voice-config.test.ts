/**
 * Aervox｜思隅 @aervox/api — 语音配置路由集成测试（CR-011 阶段 1 · 本地语音模型配置）
 *
 * 覆盖：GET/PUT /v1/voice/config、modelPath 白名单校验（400）、保存后本地 provider 生效、租户隔离。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type AddressInfo } from "node:http";
import { createInMemoryDatabase, type AervoxDatabase } from "@aervox/database";
import type { Client } from "@libsql/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  GptSovitsLocalProvider,
  GptSovitsRemoteProvider,
  SenseVoiceLocalProvider,
} from "../src/modules/voice/index.js";

const headers = {
  "x-workspace-id": "ws_voice",
  "x-user-id": "usr_voice",
} as const;

describe("语音配置路由 (Voice Config)", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let root: string;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    root = mkdtempSync(path.join(tmpdir(), "aervox-voice-"));

    const built = await buildApp({
      db,
      client,
      voiceOptions: {
        providers: [
          new GptSovitsLocalProvider("gpt-sovits-local", {
            modelId: "default-local",
            modelPath: root,
            allowedRoots: [root],
          }),
          new GptSovitsRemoteProvider("gpt-sovits-remote", {
            endpoint: "http://127.0.0.1:9880",
            protocol: "http",
            modelId: "default-remote",
          }),
        ],
        asrProviders: [
          new SenseVoiceLocalProvider("sensevoice-local", {
            modelId: "sensevoice-small",
            modelPath: root,
            allowedRoots: [root],
          }),
        ],
      },
    });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
  });

  it("GET 缺省：按本地 provider 当前生效值返回默认", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/voice/config", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.providerId).toBe("gpt-sovits-local");
    expect(body.modelId).toBe("default-local");
    expect(body.modelPath).toBe(root);
  });

  it("PUT 合法配置：保存 → GET 回显 + 本地 provider 生效 + 租户隔离", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/voice/config",
      headers,
      payload: {
        enabled: true,
        providerId: "gpt-sovits-local",
        modelPath: root,
        modelId: "gpt-sovits-v2",
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().modelId).toBe("gpt-sovits-v2");

    const get = await app.inject({ method: "GET", url: "/v1/voice/config", headers });
    expect(get.json().modelId).toBe("gpt-sovits-v2");
    expect(get.json().modelPath).toBe(root);

    // 另一租户仍是默认（隔离）
    const other = await app.inject({
      method: "GET",
      url: "/v1/voice/config",
      headers: { "x-workspace-id": "ws_other", "x-user-id": "usr_other" },
    });
    expect(other.json().modelId).toBe("default-local");
  });

  it("PUT 白名单外路径返回 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/voice/config",
      headers,
      payload: {
        enabled: true,
        providerId: "gpt-sovits-local",
        modelPath: "/etc/system/untrusted",
        modelId: "gpt-sovits-v2",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_VOICE_CONFIG");
  });

  it("PUT 非法 body 返回 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/voice/config",
      headers,
      payload: { providerId: "gpt-sovits-local", modelId: 123 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /v1/voice/input/config 读取离线语音输入默认配置", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/voice/input/config", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.engineType).toBe("sensevoice-local");
    expect(body.autoStopOnKeyboard).toBe(true);
    expect(body.vadSilenceThresholdMs).toBe(700);
  });

  it("PUT /v1/voice/input/config 保存离线语音输入配置并回显", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/voice/input/config",
      headers,
      payload: {
        enabled: true,
        engineType: "whisper-compatible",
        endpoint: "http://127.0.0.1:8000/v1",
        apiKey: "sk-test",
        modelId: "whisper-1",
        autoStopOnKeyboard: false,
        vadSilenceThresholdMs: 800,
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().engineType).toBe("whisper-compatible");
    expect(put.json().autoStopOnKeyboard).toBe(false);

    const get = await app.inject({ method: "GET", url: "/v1/voice/input/config", headers });
    expect(get.json().engineType).toBe("whisper-compatible");
    expect(get.json().endpoint).toBe("http://127.0.0.1:8000/v1");
  });

  it("GET /v1/voice/input/model/status 与 POST /v1/voice/input/model/download 模型下载交互与校验", async () => {
    const statusRes = await app.inject({
      method: "GET",
      url: "/v1/voice/input/model/status",
      headers,
    });
    expect(statusRes.statusCode).toBe(200);
    expect(typeof statusRes.json().downloaded).toBe("boolean");
    expect(typeof statusRes.json().verified).toBe("boolean");
    expect(typeof statusRes.json().progressPercent).toBe("number");

    const dlRes = await app.inject({
      method: "POST",
      url: "/v1/voice/input/model/download",
      headers,
      payload: { targetDir: root },
    });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.json().accepted).toBe(true);
    expect(dlRes.json().status.downloading).toBe(true);
    expect(dlRes.json().status.progressPercent).toBeGreaterThan(0);
  });

  it("POST /v1/voice/input/model/download 拒绝白名单外 targetDir（CR-016 安全整改）", async () => {
    const dlRes = await app.inject({
      method: "POST",
      url: "/v1/voice/input/model/download",
      headers,
      payload: { targetDir: "/etc" },
    });
    expect(dlRes.statusCode).toBe(400);
    expect(dlRes.json().code).toBe("INVALID_DOWNLOAD_REQUEST");
  });

  it("POST /v1/voice/input/model/download 拒绝白名单外 mirrorUrl（CR-016 安全整改）", async () => {
    const dlRes = await app.inject({
      method: "POST",
      url: "/v1/voice/input/model/download",
      headers,
      payload: { mirrorUrl: "https://example.com/evil" },
    });
    expect(dlRes.statusCode).toBe(400);
    expect(dlRes.json().code).toBe("INVALID_DOWNLOAD_REQUEST");
  });

  it("POST /v1/voice/transcribe 模型未就绪时返回 503（不改文案插入输入框）", async () => {
    // 当前 provider 的 allowedRoots 指向空目录，SenseVoice 模型未就绪 → healthCheck 不通过 → 503
    const res = await app.inject({
      method: "POST",
      url: "/v1/voice/transcribe",
      headers,
      payload: {
        audioBase64: Buffer.from("fake-wav-content").toString("base64"),
        mimeType: "audio/wav",
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("VOICE_INPUT_PROVIDER_UNAVAILABLE");
  });

  it("PUT /v1/voice/input/config 拒绝非法 whisper endpoint（CR-016 整改）", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/voice/input/config",
      headers,
      payload: {
        enabled: true,
        engineType: "whisper-compatible",
        endpoint: "not-a-url",
        modelId: "whisper-1",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_VOICE_INPUT_CONFIG");
  });

  it("GET /v1/voice/remote/config 缺省：按远程 provider 当前生效值返回默认（CR-028）", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/voice/remote/config", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.providerId).toBe("gpt-sovits-remote");
    expect(body.endpoint).toBe("http://127.0.0.1:9880");
    expect(body.modelId).toBe("default-remote");
  });

  it("PUT /v1/voice/remote/config 保存 → GET 回显 + provider 生效 + 租户隔离（CR-028）", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/voice/remote/config",
      headers,
      payload: {
        enabled: true,
        endpoint: "http://127.0.0.1:9910",
        modelId: "firefly-remote",
        textLang: "zh",
        refAudioPath: "D:/gpt-sovits/voice/ref.wav",
        speedFactor: 1.1,
      },
    });
    expect(put.statusCode).toBe(200);
    const saved = put.json();
    expect(saved.endpoint).toBe("http://127.0.0.1:9910");
    expect(saved.modelId).toBe("firefly-remote");
    expect(saved.textLang).toBe("zh");
    expect(saved.speedFactor).toBe(1.1);

    const get = await app.inject({ method: "GET", url: "/v1/voice/remote/config", headers });
    expect(get.json().endpoint).toBe("http://127.0.0.1:9910");

    // 另一租户仍是默认（隔离）
    const other = await app.inject({
      method: "GET",
      url: "/v1/voice/remote/config",
      headers: { "x-workspace-id": "ws_other", "x-user-id": "usr_other" },
    });
    expect(other.json().endpoint).toBe("http://127.0.0.1:9880");

    // 保存后远程 provider 生效：/v1/voice/models 中 remote 模型 ID 已更新
    const models = await app.inject({ method: "GET", url: "/v1/voice/models", headers });
    const remote = models.json().models.find(
      (m: { providerId: string }) => m.providerId === "gpt-sovits-remote",
    );
    expect(remote.modelId).toBe("firefly-remote");
  });

  it("PUT /v1/voice/remote/config 拒绝非法 endpoint（CR-028）", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/voice/remote/config",
      headers,
      payload: { enabled: true, endpoint: "not-a-url", modelId: "firefly-remote" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_VOICE_REMOTE_CONFIG");
  });

  it("POST /v1/voice/remote/test-connection 服务可达时返回 ok（CR-028）", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end("no route");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await app.inject({
        method: "POST",
        url: "/v1/voice/remote/test-connection",
        headers,
        payload: { endpoint: `http://127.0.0.1:${port}`, modelId: "default-remote" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // 根路径 404 也说明服务可达
      expect(body.ok).toBe(true);
      expect(typeof body.latencyMs).toBe("number");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("POST /v1/voice/remote/test-connection 服务不可达时返回 ok=false（CR-028）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/voice/remote/test-connection",
      headers,
      payload: { endpoint: "http://127.0.0.1:59999", modelId: "default-remote" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
  });
});