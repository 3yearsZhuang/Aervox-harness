import { lstatSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverWorkspaces } from './workspaces.mjs';
import { productTrackedEntries } from './core-submodule.mjs';

export function generatedPaths(cwd = process.cwd()) {
  return ['dist', '.turbo', 'node_modules/.turbo', ...discoverWorkspaces(cwd).flatMap(({ relDir }) =>
    ['dist', 'out', '.turbo'].map(dir => `${relDir}/${dir}`))];
}

/** Validate the entire deletion set before touching anything. Never follow links. */
export function cleanGenerated({ cwd = process.cwd(), dryRun = false } = {}) {
  const root = realpathSync(cwd);
  const tracked = productTrackedEntries(cwd).map(entry => entry.file);
  const paths = generatedPaths(cwd);
  for (const rel of paths) {
    if (tracked.some(file => file === rel || file.startsWith(`${rel}/`))) throw new Error(`Refusing tracked output: ${rel}`);
    let parent = root;
    for (const part of rel.split('/')) {
      parent = path.join(parent, part);
      if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing linked output: ${rel}`);
    }
  }
  for (const rel of paths) {
    if (!dryRun) rmSync(path.join(root, rel), { force: true, recursive: true });
  }
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--dry-run')) throw new Error('Usage: clean-generated.mjs [--dry-run]');
  console.log(cleanGenerated({ dryRun: args.includes('--dry-run') }).join('\n'));
}
