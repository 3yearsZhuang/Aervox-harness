import { pluginSkillDirectoryName } from "@aervox/contracts";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import type { SqliteSkillRegistryRepository } from "@aervox/repositories";

export class FileExistsError extends Error {
  readonly statusCode = 409;
  constructor(message: string) { super(message); this.name = "FileExistsError"; }
}

const mutations = new Map<string, Promise<void>>();
const ownedLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/** Serialize filesystem/registry mutations in the local API, including nested bundle installs. */
export async function withSkillMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(root, { recursive: true });
  const key = await fs.realpath(root);
  const held = ownedLocks.getStore();
  if (held?.has(key)) return operation();
  const previous = mutations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  mutations.set(key, current);
  await previous;
  try { return await ownedLocks.run(new Set([...(held ?? []), key]), operation); }
  finally {
    release();
    if (mutations.get(key) === current) mutations.delete(key);
  }
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function rejectSymlinks(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new FileExistsError("Skill directory contains a symbolic link.");
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target)) await rejectSymlinks(path.join(target, entry));
  }
}

/** Check the whole directory, not just the registration matching its basename. */
export async function assertSkillDirectoryOwner(
  registry: SqliteSkillRegistryRepository,
  root: string,
  owner: { kind: "local" | "plugin"; id: string },
): Promise<void> {
  if (owner.kind === "plugin" && owner.id.includes(":")) throw new FileExistsError("Invalid plugin directory owner.");
  try { pluginSkillDirectoryName(owner.id); } catch { throw new FileExistsError("Invalid skill directory owner."); }
  const directory = path.resolve(root, pluginSkillDirectoryName(owner.id));
  const rows = await registry.listSkills();
  let hasOwner = false;
  for (const row of rows) {
    const contentDir = row.contentPath
      ? path.dirname(path.resolve(row.contentPath))
      : path.resolve(root, ...(row.pluginId ? [row.pluginId, pluginSkillDirectoryName(row.id)] : [pluginSkillDirectoryName(row.id)]));
    const belongs = owner.kind === "local"
      ? row.id === owner.id && !row.pluginId && row.readonly !== 1 && contentDir === directory
      : row.pluginId === owner.id;
    const overlaps = contains(directory, contentDir) || contains(contentDir, directory);
    const reservedName = owner.kind === "local" && (row.id === owner.id || row.pluginId === owner.id);
    if ((overlaps || reservedName) && !belongs) {
      throw new FileExistsError(`Skill directory ${owner.id} overlaps another owner (${row.id}).`);
    }
    if (belongs && contains(directory, contentDir)) hasOwner = true;
  }
  await rejectSymlinks(directory);
  // Unregistered content has no proven owner; never recursively replace/delete it.
  if (!hasOwner) {
    const entries = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (entries.length) throw new FileExistsError(`Skill directory ${owner.id} has unregistered content.`);
  }
}
