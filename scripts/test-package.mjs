#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { discoverWorkspaces } from './workspaces.mjs';

const workspaces = discoverWorkspaces();
const manifests = [JSON.parse(readFileSync('package.json', 'utf8')), ...workspaces.map(pkg => pkg.manifest)];
const requested = process.argv[2];
if (!requested) throw new Error('A workspace test target is required');

// Directory names need not match manifest names (for example companion-ui).
// Preserve the historical repositories shorthand used by the launcher.
const target = requested === 'repos' ? 'repositories' : requested;
const exact = workspaces.find(pkg => pkg.name === target);
const candidates = exact ? [exact] : workspaces.filter(pkg =>
  pkg.relDir === target.replace(/^\.\//, '') || path.basename(pkg.relDir) === target);
if (candidates.length > 1) throw new Error(`Ambiguous workspace: ${requested}; use its full name or path`);
const filter = candidates[0]?.name ?? target;

// Ask pnpm to interpret selectors, including dependency/dependent selectors.
// `pnpm test` alone exits successfully for selected packages without scripts.
const selected = spawnSync('pnpm', ['--filter', filter, '--fail-if-no-match', 'list', '--depth=-1', '--json'], {
  encoding: 'utf8',
});
if (selected.error) throw selected.error;
if (selected.status !== 0) {
  process.stderr.write(selected.stderr || `No workspace matched test target: ${requested}\n`);
  process.exit(selected.status ?? 1);
}
const packages = JSON.parse(selected.stdout);
if (!Array.isArray(packages) || !packages.some(selectedPackage =>
  manifests.some(manifest => manifest.name === selectedPackage.name && manifest.scripts?.test))) {
  throw new Error(`No selected workspace declares a test script: ${requested}`);
}

console.log(`[aervox] 运行指定目标测试: ${filter}`);
const result = spawnSync('pnpm', ['--filter', filter, '--fail-if-no-match', 'test'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
