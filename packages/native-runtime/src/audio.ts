import { NativeRuntimeClient } from "./client.js";
import type { NativeArtifact } from "./artifact.js";

export class NativeAudioPreprocessor {
  private readonly runtime: NativeRuntimeClient;
  constructor(artifact: NativeArtifact) { this.runtime = new NativeRuntimeClient(artifact); }
  async preprocess(wav: Buffer, signal?: AbortSignal): Promise<Float32Array> {
    if (wav.length > 20 * 1024 * 1024) throw new Error("native_audio_input_limit");
    const result = await this.runtime.request("audio.preprocess", { wav: wav.toString("base64") }, signal);
    if (!Number.isSafeInteger(result.frames) || result.frames < 1 || result.frames > 16000 * 600 || result.sampleRate !== 16000 || typeof result.pcm !== "string") throw new Error("native_audio_response_invalid");
    const bytes = Buffer.from(result.pcm, "base64");
    if (bytes.length !== result.frames * 4) throw new Error("native_audio_response_invalid");
    const samples = new Float32Array(result.frames);
    for (let i = 0; i < samples.length; i++) { samples[i] = bytes.readFloatLE(i * 4); if (!Number.isFinite(samples[i])) throw new Error("native_audio_response_invalid"); }
    return samples;
  }
  close(): Promise<void> { return this.runtime.close(); }
}
