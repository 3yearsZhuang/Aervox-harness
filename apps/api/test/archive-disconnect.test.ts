import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { request, type ClientRequest } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { createInMemoryDatabase, SqliteSkillRegistryRepository } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";
import * as archive from "../src/shared/archive-worker.js";

let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
let root: string;
let baseUrl: string;
let personaId: string;
let bundleBase64: string;
let packageBase64: string;
const legacyExportUrl = "/v1/plugins/archive.legacy/export";
const manifest = {
  apiVersion: "aervox.dev/v1", kind: "PluginManifest",
  metadata: { id: "archive.plugin", displayName: "Archive", publisher: "test", version: "1.0.0", description: "Archive test", license: "MIT" },
  spec: { skills: [{ name: "plugin-owned", content: "# Plugin" }] },
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "avx-archive-disconnect-"));
  const builtin = path.join(root, "builtin");
  await fs.mkdir(builtin);
  database = await createInMemoryDatabase();
  ({ app } = await buildApp({ db: database.db, client: database.client, skillsRoot: path.join(root, "skills"), pluginsRoot: path.join(root, "plugins"), builtinPluginsSourceRoot: builtin }));
  await app.ready();
  const skill = await app.inject({ method: "POST", url: "/v1/skills", payload: { name: "archive-owned", zipBase64: Buffer.from(zipSync({ "SKILL.md": strToU8("# Original") })).toString("base64") } });
  expect(skill.statusCode).toBe(201);
  const persona = await app.inject({ method: "POST", url: "/v1/personas", payload: { name: "Archive persona", config: { systemPromptAppend: "Be concise", allowedSkillNames: ["archive-owned"] } } });
  expect(persona.statusCode, persona.body).toBe(201);
  personaId = persona.json().persona.id;
  const exported = await app.inject({ method: "POST", url: `/v1/personas/${personaId}/export` });
  expect(exported.statusCode).toBe(200);
  bundleBase64 = exported.json().bundleBase64;
  packageBase64 = Buffer.from(zipSync({ "plugin.manifest.json": strToU8(JSON.stringify(manifest)) })).toString("base64");
  const plugin = await app.inject({ method: "POST", url: "/v1/plugins/install-package", payload: { packageBase64 } });
  expect(plugin.statusCode, plugin.body).toBe(201);
  // A market item uses the same installed owner; cancellation must not uninstall it.
  await fs.mkdir(path.join(builtin, manifest.metadata.id));
  await fs.writeFile(path.join(builtin, manifest.metadata.id, "plugin.manifest.json"), JSON.stringify(manifest));
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await database.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

it.each([
  { name: "skill install", url: "/v1/skills", cancelAt: 1 },
  { name: "plugin inspection", url: "/v1/plugins/inspect-package", cancelAt: 1 },
  { name: "plugin replacement after inspection", url: "/v1/plugins/install-package", cancelAt: 2 },
  { name: "legacy plugin export", url: legacyExportUrl, cancelAt: 1 },
  { name: "market install", url: "/v1/plugins/market/archive.plugin/install", cancelAt: 2 },
  { name: "Persona nested preview", url: "/v1/personas/import/preview", cancelAt: 2 },
  { name: "Persona nested import", url: "/v1/personas/import", cancelAt: 2 },
  { name: "Persona nested export", url: "persona-export", cancelAt: 2 },
])("$name disconnect terminates its archive worker, releases capacity and preserves installed data", async ({ url, cancelAt }) => {
  if (url === legacyExportUrl) {
    // Direct registration creates the legacy layout, whose export still packs
    // repository metadata and local skill files through a real archive worker.
    const legacy = await app.inject({ method: "POST", url: "/v1/plugins", payload: {
      id: "archive.legacy", publisher: "test", version: "1.0.0",
      skills: [{ name: "legacy-owned", content: "# Legacy original" }],
    } });
    expect(legacy.statusCode, legacy.body).toBe(201);
    expect(legacy.json().bundleGeneration).toBeNull();
  }
  const snapshot = async () => Promise.all(["/v1/skills", "/v1/plugins", "/v1/personas"].map(async route => (await app.inject({ url: route })).json()));
  const before = await snapshot();
  const original = archive.executeArchive;
  let client: ClientRequest;
  let calls = 0;
  let cancelledSignal: AbortSignal | undefined;
  let outcome: { error?: unknown; finished: boolean } = { finished: false };
  vi.spyOn(archive, "executeArchive").mockImplementation(function<T>(operation: Parameters<typeof original>[0]): Promise<T> {
    const pending = original<T>(operation); // Real Worker; spy observes without replacing CPU work.
    if (++calls === cancelAt) {
      cancelledSignal = operation.signal;
      client.destroy();
      void pending.then(
        () => { outcome = { finished: true }; },
        error => { outcome = { error, finished: true }; },
      );
    }
    return pending;
  });
  const payload = JSON.stringify({ name: "archive-owned", overwrite: true, zipBase64: Buffer.from(zipSync({ "SKILL.md": strToU8("# Replacement") })).toString("base64"), packageBase64, bundleBase64, conflictResolution: "replace" });
  const target = url === "persona-export" ? `/v1/personas/${personaId}/export` : url;
  client = request(baseUrl + target, { method: target === legacyExportUrl ? "GET" : "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } });
  client.on("error", () => {});
  client.end(payload);
  try {
    await vi.waitFor(() => expect(outcome.finished).toBe(true), { timeout: 10_000 });
    expect(cancelledSignal?.aborted).toBe(true);
    expect(String(outcome.error)).toContain("cancelled");
    // Two simultaneous real workers can be admitted again only after the cancelled worker released its slot.
    const results = await Promise.all([1, 2].map(() => original<Uint8Array>({ kind: "pack", input: { "probe.txt": strToU8("ok") }, limits: archive.ARCHIVE_LIMITS })));
    expect(results.every(result => result.byteLength > 0)).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(await fs.readFile(path.join(root, "skills", "archive-owned", "SKILL.md"), "utf8")).toBe("# Original");
    if (url === legacyExportUrl) {
      expect(await fs.readFile(path.join(root, "skills", "archive.legacy", "legacy-owned", "SKILL.md"), "utf8")).toBe("# Legacy original");
    }
  } finally { client.destroy(); }
});

it("exports a generation's original archive without starting an archive worker", async () => {
  const executeArchive = vi.spyOn(archive, "executeArchive");
  const exported = await app.inject({ method: "GET", url: "/v1/plugins/archive.plugin/export" });
  expect(exported.statusCode, exported.body).toBe(200);
  expect(exported.json().packageBase64).toBe(packageBase64);
  expect(executeArchive).not.toHaveBeenCalled();
});

it("maps asynchronous Persona preview failures to INVALID_BUNDLE", async () => {
  const result = await app.inject({ method: "POST", url: "/v1/personas/import/preview", payload: { bundleBase64: Buffer.from("bad zip").toString("base64") } });
  expect(result.statusCode).toBe(400);
  expect(result.body).toContain("INVALID_BUNDLE");
});

it.each(["skill", "plugin", "persona"])("%s completes accepted mutations after a disconnect at the first file write", async kind => {
  const original = SqliteSkillRegistryRepository.prototype.registerSkill;
  let client: ClientRequest;
  let disconnected = false;
  vi.spyOn(SqliteSkillRegistryRepository.prototype, "registerSkill").mockImplementation(async function(skill) {
    // Registration follows the actual file write. Let the socket close reach the
    // request before proceeding, so later writes exercise the commit boundary.
    if (!disconnected) {
      disconnected = true;
      client.destroy();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return original.call(this, skill);
  });
  const url = kind === "skill" ? "/v1/skills" : kind === "plugin" ? "/v1/plugins/install-package" : "/v1/personas/import";
  const changedManifest = { ...manifest, metadata: { ...manifest.metadata, version: "2.0.0" } };
  const payload = JSON.stringify({
    overwrite: true, conflictResolution: "replace", bundleBase64,
    zipBase64: Buffer.from(zipSync({ "archive-owned/SKILL.md": strToU8("# Changed"), "second-skill/SKILL.md": strToU8("# Second") })).toString("base64"),
    packageBase64: Buffer.from(zipSync({ "plugin.manifest.json": strToU8(JSON.stringify(changedManifest)) })).toString("base64"),
  });
  client = request(baseUrl + url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } });
  client.on("error", () => {});
  client.end(payload);
  try {
    await vi.waitFor(async () => {
      expect(disconnected).toBe(true);
      if (kind === "skill") {
        const skills = (await app.inject({ url: "/v1/skills" })).json().items;
        expect(skills.some((skill: { name: string }) => skill.name === "second-skill")).toBe(true);
        expect(await fs.readFile(path.join(root, "skills", "archive-owned", "SKILL.md"), "utf8")).toBe("# Changed");
      } else if (kind === "plugin") {
        const plugins = (await app.inject({ url: "/v1/plugins" })).json().items;
        expect(plugins.find((plugin: { id: string }) => plugin.id === manifest.metadata.id)?.version).toBe("2.0.0");
        expect(await new SqliteSkillRegistryRepository(database.db).getSkill("plugin-owned")).not.toBeNull();
      } else {
        expect((await app.inject({ url: "/v1/personas" })).json().personas).toHaveLength(2);
      }
    }, { timeout: 10_000 });
  } finally { client.destroy(); }
});
