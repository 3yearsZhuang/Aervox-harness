import { describe, it, expect } from "vitest";
import {
  GptSovitsLocalProvider,
  GptSovitsRemoteProvider,
  VoiceService,
} from "../src/modules/platform/voice/index.js";

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

  it("Remote GPT-SoVITS: api_v2 协议请求与 Token 鉴权（CR-028）", async () => {
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
        endpoint: "https://voice.example.com/",
        protocol: "http",
        modelId: "remote-model",
        secretRef: "secret-token-123",
        textLang: "zh",
        refAudioPath: "D:/gpt-sovits/voice/ref.wav",
        promptText: "我还知道你们经常在银河各地到处旅行.",
        promptLang: "zh",
        auxRefAudioPaths: ["D:/gpt-sovits/voice/aux1.wav"],
        speedFactor: 1.1,
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
    // api_v2：base URL 去尾斜杠后拼 /tts，Bearer 鉴权
    expect(calls[0]?.url).toBe("https://voice.example.com/tts");
    expect(calls[0]?.headers?.Authorization).toBe("Bearer secret-token-123");
    const payload = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(payload.text).toBe("hello world");
    expect(payload.text_lang).toBe("zh");
    expect(payload.ref_audio_path).toBe("D:/gpt-sovits/voice/ref.wav");
    expect(payload.prompt_text).toBe("我还知道你们经常在银河各地到处旅行.");
    expect(payload.prompt_lang).toBe("zh");
    expect(payload.aux_ref_audio_paths).toEqual(["D:/gpt-sovits/voice/aux1.wav"]);
    expect(payload.speed_factor).toBe(1.1);
  });

  it("Remote GPT-SoVITS: 缺少 refAudioPath/promptText 时合成报错；reconfigure 后生效（CR-028）", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body as string });
      return new Response(new Uint8Array([9]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }) as typeof fetch;

    const remoteProvider = new GptSovitsRemoteProvider(
      "remote-1",
      { endpoint: "http://127.0.0.1:9880", protocol: "http", modelId: "remote-model" },
      mockFetch,
    );
    await expect(
      remoteProvider.synthesize({ text: "测试", modelId: "remote-model" }),
    ).rejects.toThrow("refAudioPath is required");

    remoteProvider.reconfigure({
      endpoint: "http://127.0.0.1:9881",
      modelId: "firefly",
      textLang: "en",
      refAudioPath: "D:/gpt-sovits/voice/ref2.wav",
      promptText: "hello world.",
    });
    const artifact = await remoteProvider.synthesize({ text: "hello", modelId: "firefly" });
    expect(artifact.modelId).toBe("firefly");
    expect(calls[0]?.url).toBe("http://127.0.0.1:9881/tts");
    const payload = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(payload.text_lang).toBe("en");
    expect(payload.ref_audio_path).toBe("D:/gpt-sovits/voice/ref2.wav");
    // prompt_lang 未配置时跟随 text_lang
    expect(payload.prompt_text).toBe("hello world.");
    expect(payload.prompt_lang).toBe("en");
    // 未配置的 aux/speed 不下发
    expect("aux_ref_audio_paths" in payload).toBe(false);
    expect("speed_factor" in payload).toBe(false);
  });

  it("ASR Provider SPI: 自定义插件式 ASR Provider 动态注册与多态配置分发", async () => {
    let reconfigureCalledWith: Record<string, unknown> | null = null;
    let transcribeCalled = false;

    const customAsrProvider = {
      id: "custom-asr",
      kind: "custom-asr-kind",
      async healthCheck() {
        return { status: "healthy" as const };
      },
      reconfigure(config: Record<string, unknown>) {
        reconfigureCalledWith = config;
      },
      async transcribe() {
        transcribeCalled = true;
        return { text: "识别文本来自插件", isFinal: true };
      },
    };

    const mockRepo = {
      getConfig: async () => ({
        enabled: 1,
        engineType: "custom-asr",
        modelPath: "/plugins/models/custom.bin",
        modelId: "custom-v1",
        endpoint: "http://custom-asr:8080",
        apiKey: "secret",
        autoStopOnKeyboard: 1,
        vadSilenceThresholdMs: 500,
        settingsJson: { customSetting: true },
        createdAt: "2026-09-17",
        updatedAt: "2026-09-17",
      }),
      saveConfig: async () => {
        throw new Error("not implemented");
      },
    };

    const service = new VoiceService([], undefined, [customAsrProvider as any], mockRepo as any);
    const result = await service.transcribe(
      { workspaceId: "ws_voice_it", subjectUserId: "usr_voice_it" },
      { audioBuffer: Buffer.from("audio") },
    );

    expect(transcribeCalled).toBe(true);
    expect(result.text).toBe("识别文本来自插件");
    expect(reconfigureCalledWith).toEqual({
      modelPath: "/plugins/models/custom.bin",
      modelId: "custom-v1",
      endpoint: "http://custom-asr:8080",
      apiKey: "secret",
      customSetting: true,
    });
  });
});
