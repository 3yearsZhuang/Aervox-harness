import { describe, expect, it } from "vitest";
import { GptSovitsLocalProvider, GptSovitsRemoteProvider } from "../src/index.js";

describe("GPT-SoVITS providers", () => {
  it("enforces local model path allowlist", async () => {
    const provider = new GptSovitsLocalProvider("local", { modelId: "m", modelPath: process.cwd(), allowedRoots: [process.cwd()] });
    expect((await provider.healthCheck()).status).toBe("healthy");
    const blocked = new GptSovitsLocalProvider("blocked", { modelId: "m", modelPath: "/tmp/aervox-not-allowed", allowedRoots: [process.cwd()] });
    expect((await blocked.healthCheck()).status).toBe("misconfigured");
  });
  it("calls the remote GPT-SoVITS service without exporting credentials", async () => {
    const calls: RequestInit[] = [];
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => { calls.push(init ?? {}); return new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/wav" } }); };
    const provider = new GptSovitsRemoteProvider("remote", { endpoint: "https://voice.test", protocol: "http", modelId: "m", secretRef: "secret-ref" }, fetchMock);
    const artifact = await provider.synthesize({ text: "hello", modelId: "m" });
    expect(artifact.bytes).toEqual(new Uint8Array([1, 2]));
    expect(calls[0]?.headers).toMatchObject({ Authorization: "Bearer secret-ref" });
  });
});
