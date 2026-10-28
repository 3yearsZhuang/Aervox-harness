import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { RemotePluginRegistry } from "../src/modules/ecosystem/plugins/remote-registry.js";

const manifest = { apiVersion: "aervox.dev/v1", kind: "PluginManifest", metadata: {
  id: "ap-tool-example", displayName: "Example", publisher: "test", version: "1.0.0", category: "tool", tags: [], breaking: false,
}, spec: {} };
const archive = zipSync({ "plugin.manifest.json": strToU8(JSON.stringify(manifest)) });
function setup(overrides: Record<string, unknown> = {}, body = archive) {
  const entry = { id: manifest.metadata.id, displayName: "Example", publisher: "test", latestVersion: "1.0.0", category: "tool",
    description: "Example", breaking: false, downloadUrl: "https://github.com/Aervox-agent/Aervox-plugins/releases/download/test/example.aervox-plugin",
    sha256: createHash("sha256").update(body).digest("hex"), size: body.byteLength, ...overrides };
  const transport = (async (input: RequestInfo | URL) => new Response(String(input).endsWith("catalog.json")
    ? JSON.stringify({ version: 1, updatedAt: "2026-10-29T00:00:00Z", plugins: [entry] }) : body)) as typeof fetch;
  return new RemotePluginRegistry({ url: "https://raw.githubusercontent.com/Aervox-agent/Aervox-plugins/main/registry/catalog.json", fetch: transport });
}

describe("published registry downloads", () => {
  it("verifies the real archive identity, publisher, version, size and SHA before returning it", async () => {
    const result = await setup().download(manifest.metadata.id);
    expect(result.bytes).toEqual(archive);
    expect(result.entry.latestVersion).toBe("1.0.0");
  });
  it("rejects a checksum mismatch and mismatched manifest identity", async () => {
    await expect(setup({ sha256: "0".repeat(64) }).download(manifest.metadata.id)).rejects.toThrow(/checksum/);
    await expect(setup({ id: "ap-tool-other" }).download("ap-tool-other")).rejects.toThrow(/metadata/);
    await expect(setup({ latestVersion: "2.0.0" }).download(manifest.metadata.id)).rejects.toThrow(/metadata/);
  });
  it("bounds streamed bytes and rejects unsupported URLs and invalid registry data", async () => {
    await expect(setup({ size: 1 }).download(manifest.metadata.id)).rejects.toThrow(/limit/);
    await expect(setup({ downloadUrl: "https://localhost/private" }).download(manifest.metadata.id)).rejects.toThrow(/approved HTTPS/);
    await expect(setup({ category: "bot" }).catalog()).rejects.toThrow();
    const registry = new RemotePluginRegistry({ url: "http://127.0.0.1/private" });
    await expect(registry.catalog()).rejects.toThrow(/approved HTTPS/);
  });
  it("reports transport errors rather than returning an empty successful registry", async () => {
    const registry = new RemotePluginRegistry({ url: "https://raw.githubusercontent.com/Aervox-agent/Aervox-plugins/main/registry/catalog.json",
      fetch: (async () => new Response("offline", { status: 503 })) as typeof fetch });
    await expect(registry.catalog()).rejects.toThrow(/503/);
  });
  it("rejects a redirect before making a request to its untrusted destination", async () => {
    const calls: string[] = [];
    const registry = new RemotePluginRegistry({ url: "https://raw.githubusercontent.com/Aervox-agent/Aervox-plugins/main/registry/catalog.json",
      fetch: (async input => { calls.push(String(input)); return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); }) as typeof fetch });
    await expect(registry.catalog()).rejects.toThrow(/approved HTTPS/);
    expect(calls).toHaveLength(1);
  });
  it("checks the breaking marker as well as the downloaded identity", async () => {
    await expect(setup({ breaking: true }).download(manifest.metadata.id)).rejects.toThrow(/metadata/);
  });
});
