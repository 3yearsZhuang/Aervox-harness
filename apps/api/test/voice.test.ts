import { describe, it, expect } from "vitest";
import {
  GptSovitsLocalProvider,
  GptSovitsRemoteProvider,
  VoiceService,
} from "../src/modules/voice/index.js";

describe("系统级语音模块 (Voice Module)", () => {
  it("Local GPT-SoVITS: 校验模型路径与合成", async () => {
    const localProvider = new GptSovitsLocalProvider("local-1", {
      modelId: "model-a",
      modelPath: process.cwd(),
      allowedRoots: [process.cwd()],
    });
    const health = await localProvider.healthCheck();
    expect(health.status).toBe("healthy");

    const models = await localProvider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.modelId).toBe("model-a");
    expect(models[0]?.available).toBe(true);

    const artifact = await localProvider.synthesize({ text: "test", modelId: "model-a" });
    expect(artifact.contentType).toBe("audio/wav");
    expect(artifact.providerId).toBe("local-1");
  });

  it("Remote GPT-SoVITS: 远程请求与 Token 鉴权", async () => {
    const calls: Array<{ url: string; headers?: Record<string, string>; body?: string }> = [];
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
      });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }) as typeof fetch;

    const remoteProvider = new GptSovitsRemoteProvider(
      "remote-1",
      {
        endpoint: "https://voice.example.com/api/v1/tts",
        protocol: "http",
        modelId: "remote-model",
        secretRef: "secret-token-123",
      },
      mockFetch,
    );

    const service = new VoiceService([remoteProvider]);
    const artifact = await service.synthesize("remote-1", {
      text: "hello world",
      modelId: "remote-model",
    });
    expect(artifact.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers?.Authorization).toBe("Bearer secret-token-123");
  });
});
