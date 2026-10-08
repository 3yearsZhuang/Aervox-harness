import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { hash } from './config.mjs';

let manifestPromise;
/** Capture built runtime as well as research source; independent of dirty Git state. */
export function runtimeManifest() {
  manifestPromise ??= (async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url)), files = {};
    for (const file of ['pnpm-lock.yaml', 'mise.toml', 'package.json']) files[file] = hash(await readFile(join(root, file), 'utf8'));
    for (const subdir of ['scripts/hls-agent', 'packages/core/dist']) {
      const directory = join(root, subdir);
      const entries = await readdir(directory, { recursive: true, withFileTypes: true });
      for (const entry of entries.filter((e) => e.isFile() && /\.(mjs|js|txt|sh)$/.test(e.name))) {
        const path = join(entry.parentPath, entry.name);
        files[relative(root, path)] = hash(await readFile(path, 'utf8'));
      }
    }
    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
    return { node: process.version, files: sorted, sha256: hash({ node: process.version, files: sorted }) };
  })();
  return manifestPromise;
}
