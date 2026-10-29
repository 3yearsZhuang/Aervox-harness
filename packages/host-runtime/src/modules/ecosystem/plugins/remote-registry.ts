import { createHash } from "node:crypto";
import { pluginCatalogSchema, pluginManifestSchema } from "@aervox/contracts";
import { executeArchive, ARCHIVE_LIMITS, isSafeArchivePath } from "../../../shared/archive-worker.js";

export const OFFICIAL_PLUGIN_REGISTRY = "https://raw.githubusercontent.com/Aervox-agent/Aervox-plugins/main/registry/catalog.json";
export interface PluginRegistryOptions { url: string; fetch?: typeof fetch; timeoutMs?: number }

/** Registry transport is public, bounded, and never carries the host authentication token. */
export class RemotePluginRegistry {
  constructor(private readonly options: PluginRegistryOptions) {}

  private async read(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let target = new URL(url);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (target.protocol !== "https:" || target.username || target.password
        || !["raw.githubusercontent.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(target.hostname)) {
        throw new Error("Plugin registry requires an approved HTTPS GitHub URL");
      }
      response = await (this.options.fetch ?? fetch)(target.href, { signal: combined, redirect: "manual",
        credentials: "omit", headers: { Accept: "application/octet-stream" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error("Invalid plugin registry redirect");
      target = new URL(location, target);
    }
    if (!response) throw new Error("Plugin registry download failed");
    if (!response.ok || !response.body) throw new Error(`Plugin registry download failed (${response.status})`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > maxBytes) throw new Error("Plugin registry response exceeds limit");
        chunks.push(item.value);
      }
    } finally { await reader.cancel(); }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }

  async catalog(signal?: AbortSignal) {
    const bytes = await this.read(this.options.url, 2 * 1024 * 1024, signal);
    return pluginCatalogSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  }

  async download(pluginId: string, signal?: AbortSignal) {
    const catalog = await this.catalog(signal);
    const entry = catalog.plugins.find(item => item.id === pluginId);
    if (!entry) throw new Error("Plugin is absent from the current registry");
    const bytes = await this.read(entry.downloadUrl, Math.min(entry.size, ARCHIVE_LIMITS.compressedBytes), signal);
    if (bytes.byteLength !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error("Plugin registry checksum or size mismatch");
    }
    const files = await executeArchive<Record<string, Uint8Array>>({ kind: "unpack", input: bytes,
      limits: ARCHIVE_LIMITS, isSafePath: isSafeArchivePath, signal });
    const manifestBytes = files["plugin.manifest.json"] ?? files["manifest.json"];
    if (!manifestBytes) throw new Error("Missing registry plugin manifest");
    const manifest = pluginManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
    if (manifest.metadata.id !== entry.id || manifest.metadata.version !== entry.latestVersion
      || manifest.metadata.category !== entry.category || manifest.metadata.publisher !== entry.publisher
      || (manifest.metadata.breaking ?? false) !== entry.breaking
      || JSON.stringify(manifest.requires) !== JSON.stringify(entry.requires)) {
      throw new Error("Registry metadata does not match the downloaded plugin");
    }
    return { entry, bytes };
  }
}
