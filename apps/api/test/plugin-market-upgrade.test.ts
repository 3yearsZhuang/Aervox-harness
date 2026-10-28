import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { expect, it, onTestFinished, vi } from "vitest";
import { createInMemoryDatabase, SqliteExtensionRepository } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";

const pluginId = "ap-tool-market-upgrade";
const manifest = (version: string, breaking = false, description = "Fixture") => ({
  apiVersion: "aervox.dev/v1", kind: "PluginManifest",
  metadata: { id: pluginId, displayName: "Upgrade fixture", publisher: "fixture", version,
    category: "tool", tags: ["fixture"], breaking, description }, spec: {},
});
function release(version: string, breaking = false, description = "Fixture") {
  const value = manifest(version, breaking, description);
  const bytes = zipSync({ "plugin.manifest.json": strToU8(JSON.stringify(value)) });
  return { bytes, entry: { id: pluginId, displayName: value.metadata.displayName, publisher: "fixture",
    category: "tool", tags: ["fixture"], latestVersion: version, breaking, description,
    downloadUrl: "https://github.com/Aervox-agent/Aervox-plugins/releases/download/fixture/example.aervox-plugin",
    sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-market-upgrade-"));
  const { db, client, cleanup } = await createInMemoryDatabase();
  const directory = path.join(root, "plugins", "tool", "example");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "plugin.manifest.json"), JSON.stringify(manifest("1.0.0")));
  let current = release("2.0.0");
  let online = true;
  let published = true;
  const { app } = await buildApp({ db, client, builtinPluginsSourceRoot: root,
    pluginRegistryOptions: { url: "https://raw.githubusercontent.com/Aervox-agent/Aervox-plugins/main/registry/catalog.json",
      fetch: (async input => {
        if (!online) throw new Error("offline");
        return new Response(String(input).endsWith("catalog.json")
          ? JSON.stringify({ version: 1, updatedAt: "2026-10-29T00:00:00Z", plugins: published ? [current.entry] : [] })
          : current.bytes);
      }) as typeof fetch } });
  onTestFinished(async () => { await app.close(); await cleanup(); await fs.rm(root, { recursive: true, force: true }); });
  const install = (candidate = current, allowBreaking = false) => app.inject({ method: "POST",
    url: `/v1/plugins/market/${pluginId}/install`, payload: {
      expectedVersion: candidate.entry.latestVersion, expectedSha256: candidate.entry.sha256, allowBreaking,
    } });
  const stored = async () => (await client.execute({ sql: "SELECT version, checksum, bundle_generation FROM plugins WHERE id=?", args: [pluginId] })).rows[0];
  return { app, install, stored, directory,
    offline: () => { online = false; }, empty: () => { published = false; },
    select: (candidate: ReturnType<typeof release>) => { current = candidate; } };
}

it.each(["offline", "empty"] as const)("preserves category metadata and rejects builtin downgrade with an %s registry", async mode => {
  const test = await fixture();
  expect((await test.install()).statusCode).toBe(201);
  const before = await test.stored();
  test[mode]();
  const market = (await test.app.inject({ method: "GET", url: "/v1/plugins/market" })).json();
  expect(market.items).toEqual([expect.objectContaining({ category: "tool", tags: ["fixture"], breaking: false,
    version: "1.0.0", installedVersion: "2.0.0", hasUpdate: false })]);
  const stale = await test.app.inject({ method: "POST", url: `/v1/plugins/market/${pluginId}/install`, payload: { expectedVersion: "1.0.0" } });
  expect(stale.statusCode, stale.body).toBe(409);
  expect(await test.stored()).toEqual(before);
});

it.each(["newer", "same-version-replacement"] as const)("rechecks a waiting market install after a concurrent %s install", async scenario => {
  const test = await fixture();
  let entered!: () => void;
  let releaseRead!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { releaseRead = resolve; });
  const original = SqliteExtensionRepository.prototype.getPlugin;
  let armed = true;
  const spy = vi.spyOn(SqliteExtensionRepository.prototype, "getPlugin").mockImplementation(async function (id) {
    const snapshot = await original.call(this, id);
    if (armed && id === pluginId) { armed = false; entered(); await proceed; }
    return snapshot;
  });
  const pending = test.install().then(result => result);
  try {
    await reached;
    test.select(scenario === "newer" ? release("3.0.0") : release("2.0.0", false, "Different release bytes"));
    const installed = await test.install();
    expect(installed.statusCode, installed.body).toBe(201);
    const committed = await test.stored();
    releaseRead();
    const stale = await pending;
    expect(stale.statusCode, stale.body).toBe(409);
    expect(await test.stored()).toEqual(committed);
  } finally { releaseRead(); await pending; spy.mockRestore(); }
});

it("requires explicit confirmation for builtin breaking updates and binds it to the selected version", async () => {
  const test = await fixture();
  test.empty();
  await fs.writeFile(path.join(test.directory, "plugin.manifest.json"), JSON.stringify(manifest("2.0.0", true)));
  const install = (payload: object) => test.app.inject({ method: "POST", url: `/v1/plugins/market/${pluginId}/install`, payload });
  expect((await install({ expectedVersion: "2.0.0" })).statusCode).toBe(409);
  expect((await install({ expectedVersion: "1.0.0", allowBreaking: true })).statusCode).toBe(409);
  expect((await install({ expectedVersion: "2.0.0", allowBreaking: true })).statusCode).toBe(201);
  expect((await test.stored())?.version).toBe("2.0.0");
});
