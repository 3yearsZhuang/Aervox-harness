import { globSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { assertCoreSubmodule } from './core-submodule.mjs';

/** Read the block-list workspace syntax used by pnpm. Reject unsupported syntax. */
export function workspacePatterns(cwd = process.cwd()) {
  const text = readFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
  const block = /^packages:\s*\n((?:[ \t]+[^\n]*\n|\s*\n)*)/m.exec(text)?.[1];
  if (!block) throw new Error('pnpm-workspace.yaml requires a packages block list');
  const patterns = [];
  for (const line of block.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^\s+-\s+(?:"([^"\\]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    const pattern = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!pattern || pattern.startsWith('!') || path.isAbsolute(pattern) || pattern.split('/').includes('..')) {
      throw new Error(`Unsupported workspace pattern: ${line.trim()}`);
    }
    patterns.push(pattern);
  }
  if (!patterns.length) throw new Error('No workspace patterns');
  return patterns;
}

export function discoverWorkspaces(cwd = process.cwd()) {
  assertCoreSubmodule(cwd);
  const root = realpathSync(cwd);
  const files = globSync(workspacePatterns(cwd).map(p => `${p}/package.json`), {
    cwd, exclude: ['**/node_modules/**', '**/.git/**'],
  });
  const names = new Set();
  return [...new Set(files)].sort().map(file => {
    const pkgPath = path.resolve(cwd, file);
    const relDir = path.dirname(file).split(path.sep).join('/');
    if (lstatSync(path.dirname(pkgPath)).isSymbolicLink() || realpathSync(pkgPath) !== path.join(root, file)) {
      throw new Error(`Workspace must be owned by this checkout: ${relDir}`);
    }
    const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (!manifest.name || names.has(manifest.name)) throw new Error(`Missing or duplicate workspace name: ${relDir}`);
    names.add(manifest.name);
    return { relDir, pkgPath, name: manifest.name, manifest };
  });
}

export function workspaceOwner(file, workspaces) {
  return workspaces.find(pkg => file === pkg.relDir || file.startsWith(`${pkg.relDir}/`)) ?? null;
}
