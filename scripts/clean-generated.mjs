import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverWorkspaces } from './workspaces.mjs';
import { productTrackedEntries, trackedEntries } from './core-submodule.mjs';

const cargoCaches = ['.fingerprint', 'build', 'deps', 'incremental'];

function assertOwnedPath(root, rel) {
  let parent = root;
  for (const part of rel.split('/')) {
    parent = path.join(parent, part);
    if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing linked output: ${rel}`);
  }
}

function nativePaths(cwd) {
  const paths = ['apps/mobile/android/.gradle'];
  for (const target of ['native/target', 'native/tools/vector-pilot/target']) {
    assertOwnedPath(cwd, target);
    if (!lstatSync(path.join(cwd, target), { throwIfNoEntry: false })) continue;
    // Cargo places profiles directly below target, or below a target triple.
    for (const entry of readdirSync(path.join(cwd, target), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const base = `${target}/${entry.name}`;
      const profiles = ['debug', 'release'].includes(entry.name) ? [base] : ['debug', 'release'].map(profile => `${base}/${profile}`);
      for (const profile of profiles) paths.push(...cargoCaches.map(dir => `${profile}/${dir}`));
    }
  }
  for (const build of ['apps/mobile/android/build', 'apps/mobile/android/app/build', 'apps/mobile/android/capacitor-cordova-android-plugins/build']) {
    paths.push(...['intermediates', 'generated', 'tmp', 'kotlin', '.transforms'].map(dir => `${build}/${dir}`));
  }
  return paths;
}

function referencePaths(cwd) {
  return trackedEntries(cwd).filter(entry => entry.mode === '160000' && entry.file.startsWith('reference/')).flatMap(entry => {
    const checkout = path.join(cwd, entry.file);
    assertOwnedPath(cwd, entry.file);
    if (!lstatSync(path.join(checkout, '.git'), { throwIfNoEntry: false })) return [];
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: checkout, encoding: 'utf8' });
    if (result.status !== 0 || realpathSync(result.stdout.trim()) !== realpathSync(checkout)) {
      throw new Error(`Reference checkout binding differs from its physical directory: ${entry.file}`);
    }
    const tracked = spawnSync('git', ['ls-files', '-z', '--', 'node_modules'], { cwd: checkout, encoding: 'utf8' });
    if (tracked.status !== 0) throw new Error(`Cannot inspect reference dependencies: ${entry.file}`);
    if (tracked.stdout) {
      throw new Error(`Refusing tracked reference dependencies: ${entry.file}`);
    }
    return [`${entry.file}/node_modules`];
  });
}

export function assertInactiveOutputs(root, paths) {
  if (process.platform === 'win32') return;
  const existing = paths.filter(rel => lstatSync(path.join(root, rel), { throwIfNoEntry: false }));
  if (!existing.length) return;
  const result = spawnSync('lsof', ['-nP', '-Fpn'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('Cannot inspect open build outputs with lsof', { cause: result.error });
  const absolute = existing.map(rel => path.join(root, rel));
  let pid;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (!line.startsWith('n') || pid === process.pid) continue;
    const file = line.slice(1).replace(/ \(deleted\)$/, '');
    if (absolute.some(dir => file === dir || file.startsWith(`${dir}${path.sep}`))) {
      throw new Error(`Build output is open in process ${pid}; stop its build/runtime before cleaning`);
    }
  }
}

export function generatedPaths(cwd = process.cwd(), { native = false, references = false } = {}) {
  return ['dist', '.turbo', 'node_modules/.turbo', ...discoverWorkspaces(cwd).flatMap(({ relDir }) =>
    ['dist', 'out', '.turbo'].map(dir => `${relDir}/${dir}`)),
  ...(native ? nativePaths(cwd) : []), ...(references ? referencePaths(cwd) : [])];
}

/** Validate the entire deletion set before touching anything. Never follow links. */
export function cleanGenerated({ cwd = process.cwd(), dryRun = false, native = false, references = false } = {}) {
  const root = realpathSync(cwd);
  const tracked = productTrackedEntries(cwd).map(entry => entry.file);
  const paths = generatedPaths(cwd, { native, references });
  for (const rel of paths) {
    if (tracked.some(file => file === rel || file.startsWith(`${rel}/`))) throw new Error(`Refusing tracked output: ${rel}`);
    assertOwnedPath(root, rel);
  }
  if (!dryRun) assertInactiveOutputs(root, paths);
  for (const rel of paths) {
    if (!dryRun) rmSync(path.join(root, rel), { force: true, recursive: true });
  }
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--dry-run', '--native', '--references'].includes(arg))) throw new Error('Usage: clean-generated.mjs [--dry-run] [--native] [--references]');
  console.log(cleanGenerated({ dryRun: args.includes('--dry-run'), native: args.includes('--native'), references: args.includes('--references') }).join('\n'));
}
