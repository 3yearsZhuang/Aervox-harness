import fs from "node:fs/promises";
import path from "node:path";
import { pluginManifestSchema } from "@aervox/contracts";

/** Only explicit collection layouts are sources; templates and trusted surfaces are not bundles. */
export async function discoverBuiltinPluginDirectories(root: string): Promise<string[]> {
  const found: string[] = [];
  const children = (directory: string) => fs.readdir(directory, { withFileTypes: true });
  const inspect = async (directory: string): Promise<void> => {
    try {
      const stat = await fs.lstat(path.join(directory, "plugin.manifest.json"));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error("Unsafe plugin manifest");
      found.push(directory);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  for (const entry of await children(root)) {
    if (entry.isSymbolicLink()) throw new Error("Linked builtin source");
    if (entry.isDirectory()) await inspect(path.join(root, entry.name));
  }
  const categorized = path.join(root, "plugins");
  const categoryRoot = await fs.lstat(categorized).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (categoryRoot?.isSymbolicLink()) throw new Error("Linked plugin category root");
  for (const category of ["tool", "bot", "ui", "proactive", "sync", "workflow", "theme"]) {
    const directory = path.join(categorized, category);
    const stat = await fs.lstat(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe plugin category");
    for (const entry of await children(directory)) {
      if (entry.isSymbolicLink()) throw new Error("Linked builtin source");
      if (entry.isDirectory()) await inspect(path.join(directory, entry.name));
    }
  }
  const identities = new Set<string>();
  for (const directory of found) {
    let value: unknown;
    try { value = JSON.parse(await fs.readFile(path.join(directory, "plugin.manifest.json"), "utf8")); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    const result = pluginManifestSchema.safeParse(value);
    if (!result.success) continue;
    if (identities.has(result.data.metadata.id)) throw new Error("Duplicate builtin plugin identity");
    identities.add(result.data.metadata.id);
  }
  return found.sort();
}

export async function findBuiltinPluginDirectory(root: string, pluginId: string): Promise<string | undefined> {
  let result: string | undefined;
  for (const directory of await discoverBuiltinPluginDirectories(root)) {
    let input: unknown;
    try { input = JSON.parse(await fs.readFile(path.join(directory, "plugin.manifest.json"), "utf8")); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    const parsed = pluginManifestSchema.safeParse(input);
    if (!parsed.success) continue;
    const manifest = parsed.data;
    if (manifest.metadata.id !== pluginId) continue;
    if (result) throw new Error("Duplicate builtin plugin identity");
    result = directory;
  }
  return result;
}
