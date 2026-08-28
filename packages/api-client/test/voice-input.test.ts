import { describe, expect, it } from "vitest";
import { VoiceInputRecorder } from "../src/voice-input-recorder";

describe("VoiceInputRecorder (CR-016)", () => {
  it("创建实例并初始化参数", () => {
    const recorder = new VoiceInputRecorder({
      sampleRate: 16000,
      silenceThresholdMs: 600,
      preRollMs: 250,
    });

    expect(recorder).toBeDefined();
    expect(recorder.active).toBe(false);
  });
});
