import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it, expect, onTestFinished } from "vitest";
import { discoverBuiltinPluginDirectories, findBuiltinPluginDirectory } from "../src/modules/ecosystem/plugins/plugin-sources.js";

it("discovers classified sources by manifest identity and excludes templates and trusted surfaces", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-source-layout-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = { apiVersion: "aervox.dev/v1", kind: "PluginManifest", metadata: {
    id: "ap-tool-example", category: "tool", displayName: "Example", publisher: "fixture", version: "1.0.0",
  }, spec: {} };
  const source = path.join(root, "plugins/tool/example");
  for (const directory of [source, path.join(root, "templates/basic-tool"), path.join(root, "surfaces/example")]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "plugin.manifest.json"), JSON.stringify(manifest));
  }
  expect(await discoverBuiltinPluginDirectories(root)).toEqual([source]);
  expect(await findBuiltinPluginDirectory(root, manifest.metadata.id)).toBe(source);
  await fs.mkdir(path.join(root, "invalid"));
  await fs.writeFile(path.join(root, "invalid/plugin.manifest.json"), "{bad");
  expect(await findBuiltinPluginDirectory(root, manifest.metadata.id)).toBe(source);
  const duplicate = path.join(root, "duplicate");
  await fs.mkdir(duplicate);
  await fs.writeFile(path.join(duplicate, "plugin.manifest.json"), JSON.stringify(manifest));
  await expect(discoverBuiltinPluginDirectories(root)).rejects.toThrow(/Duplicate/);
});

it("rejects linked category roots instead of reading an external source tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-source-links-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "external"));
  await fs.symlink(path.join(root, "external"), path.join(root, "plugins"), "dir");
  await expect(discoverBuiltinPluginDirectories(root)).rejects.toThrow(/Linked/);
});
