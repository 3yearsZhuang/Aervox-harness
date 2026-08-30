/**
 * Aervox｜思隅 @aervox/config — 配置解析测试（缺陷 E）
 *
 * 覆盖：
 * - 缺省值（api / worker 核心键）；
 * - 合法覆盖解析（PORT / AERVOX_LOOP_PROVIDER / 白名单 / GPT_SOVITS / WHISPER / SENSEVOICE）；
 * - 启动期校验 fail-fast（非法数字/枚举抛错）；
 * - worker 按任务独立节拍覆盖 + 非法覆盖回退告警；
 * - 优先级声明一致性（注入 env 与默认）。
 */
import { describe, expect, it } from "vitest";
import { loadApiConfig, loadWorkerConfig } from "../src/index.js";

describe("loadApiConfig（缺陷 E）", () => {
  it("缺省值：port 3000 / loopProvider llm / compaction off / 白名单空 / voice 默认", () => {
    const cfg = loadApiConfig({});
    expect(cfg.port).toBe(3000);
    expect(cfg.loopProvider).toBe("llm");
    expect(cfg.loopDriver).toBe("native");
    expect(cfg.loopCompaction).toBe("off");
    expect(cfg.adminIds).toEqual([]);
    expect(cfg.gptSovits).toMatchObject({ protocol: "http", modelId: "default-remote", allowedRoots: [] });
    expect(cfg.asr.whisperModelId).toBe("whisper-1");
    expect(cfg.asr.senseVoiceBaseUrl).toContain("hf-mirror.com");
  });

  it("合法覆盖：PORT / LOOP_PROVIDER / COMPACTION / ADMIN_IDS / 语音 provider", () => {
    const cfg = loadApiConfig({
      PORT: "8080",
      AERVOX_LOOP_PROVIDER: "scripted",
      AERVOX_LOOP_DRIVER: "dsh",
      AERVOX_LOOP_COMPACTION: "rule",
      AERVOX_ADMIN_IDS: "admin_1, admin_2 ",
      GPT_SOVITS_ALLOWED_ROOTS: "/a:/b",
      GPT_SOVITS_PROTOCOL: "websocket",
      GPT_SOVITS_MODEL_ID: "gpt-sovits-2.0",
      SENSEVOICE_ALLOWED_ROOTS: "/model1:/model2",
      WHISPER_ENDPOINT: "https://whisper.local",
      WHISPER_MODEL_ID: "whisper-large",
    });
    expect(cfg.port).toBe(8080);
    expect(cfg.loopProvider).toBe("scripted");
    expect(cfg.loopDriver).toBe("dsh");
    expect(cfg.loopCompaction).toBe("rule");
    expect(cfg.adminIds).toEqual(["admin_1", "admin_2"]);
    expect(cfg.gptSovits.allowedRoots).toEqual(["/a", "/b"]);
    expect(cfg.gptSovits.protocol).toBe("websocket");
    expect(cfg.gptSovits.modelId).toBe("gpt-sovits-2.0");
    expect(cfg.asr.senseVoiceAllowedRoots).toEqual(["/model1", "/model2"]);
    expect(cfg.asr.whisperEndpoint).toBe("https://whisper.local");
    expect(cfg.asr.whisperModelId).toBe("whisper-large");
  });

  it("启动期校验：非法数字/枚举 fail-fast 抛错", () => {
    expect(() => loadApiConfig({ PORT: "abc" })).toThrow(/PORT=abc/);
    expect(() => loadApiConfig({ AERVOX_LOOP_PROVIDER: "bogus" })).toThrow(
      /AERVOX_LOOP_PROVIDER=bogus/,
    );
    expect(() => loadApiConfig({ AERVOX_LOOP_COMPACTION: "bogus" })).toThrow(
      /AERVOX_LOOP_COMPACTION=bogus/,
    );
    // pi 为保留项：真 pi Adapter 落地前不进枚举（fail-fast，防静默无效果）
    expect(() => loadApiConfig({ AERVOX_LOOP_DRIVER: "pi" })).toThrow(/AERVOX_LOOP_DRIVER=pi/);
    expect(() => loadApiConfig({ AERVOX_LOOP_DRIVER: "bogus" })).toThrow(/AERVOX_LOOP_DRIVER=bogus/);
    expect(() => loadApiConfig({ GPT_SOVITS_PROTOCOL: "ftp" })).toThrow(/GPT_SOVITS_PROTOCOL=ftp/);
  });
});

describe("loadWorkerConfig（缺陷 E）", () => {
  it("缺省：随机 workerId + tick 5000 + 无覆盖", () => {
    const cfg = loadWorkerConfig({});
    expect(cfg.workerId).toMatch(/^worker_/);
    expect(cfg.tickMs).toBe(5000);
    expect(cfg.intervalOverrides).toEqual({});
  });

  it("覆盖：WORKER_TICK_MS 与按任务独立节拍", () => {
    const cfg = loadWorkerConfig({
      WORKER_ID: "w_1",
      WORKER_TICK_MS: "1000",
      WORKER_INTERVAL_OUTBOX_MS: "3000",
      WORKER_INTERVAL_DIARY_MS: "60000",
    });
    expect(cfg.workerId).toBe("w_1");
    expect(cfg.tickMs).toBe(1000);
    expect(cfg.intervalOverrides).toEqual({ outbox: 3000, diary: 60000 });
  });

  it("非法 WORKER_TICK_MS fail-fast；非法任务覆盖回退不阻断", () => {
    expect(() => loadWorkerConfig({ WORKER_TICK_MS: "nope" })).toThrow(/WORKER_TICK_MS=nope/);
    // 非法覆盖值被忽略（不进入 overrides），不抛错
    const cfg = loadWorkerConfig({ WORKER_INTERVAL_OUTBOX_MS: "abc", WORKER_INTERVAL_DIARY_MS: "-5" });
    expect(cfg.intervalOverrides).toEqual({});
  });
});