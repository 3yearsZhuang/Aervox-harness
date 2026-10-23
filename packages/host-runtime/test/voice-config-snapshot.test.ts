import { describe, expect, it, vi } from "vitest";
import { SenseVoiceLocalProvider } from "../src/modules/platform/voice/asr-providers.js";

describe("voice mirror configuration belongs to its provider instance", () => {
  it("a malformed mirror cannot crash local voice initialization or grant a host", () => {
    const provider = new SenseVoiceLocalProvider("test", { modelBaseUrl: "not a URL" });
    expect(provider.allowedMirrorHosts).toEqual(["hf-mirror.com"]);
    expect(SenseVoiceLocalProvider.isAllowedMirrorHost("not a URL", provider.modelBaseUrl)).toBe(false);
    expect(SenseVoiceLocalProvider.isAllowedMirrorHost("https://arbitrary.example/model", provider.modelBaseUrl)).toBe(false);
  });
  it("one provider cannot inherit another provider's mirror or an environment mutation", () => {
    const first = new SenseVoiceLocalProvider("first", { modelBaseUrl: "https://first.example/models" });
    const second = new SenseVoiceLocalProvider("second", { modelBaseUrl: "https://second.example/models" });
    vi.stubEnv("SENSEVOICE_MODEL_BASE_URL", "https://later.example/models");
    try {
      expect(first.allowedMirrorHosts).toEqual(["hf-mirror.com", "first.example"]);
      expect(second.allowedMirrorHosts).toEqual(["hf-mirror.com", "second.example"]);
      expect(SenseVoiceLocalProvider.isAllowedMirrorHost("https://second.example/models", first.modelBaseUrl)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
});
