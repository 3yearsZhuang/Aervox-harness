import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// This compatibility entry point validates all required product submodules.
// Reference repositories never become default scan/install inputs.
export const CORE_SUBMODULE = 'packages/core';
export const PLUGINS_SUBMODULE = 'plugins';
export const PRODUCT_SUBMODULES = [
  { path: CORE_SUBMODULE, label: 'Core', manifests: { 'package.json': '@aervox/core' } },
  { path: PLUGINS_SUBMODULE, label: 'Plugins', manifests: {
    'plugins/tool/flowcampus/package.json': '@aervox/plugin-flowcampus',
    'plugins/ui/focus-mode/package.json': '@aervox/plugin-focus-mode',
    'plugins/bot/onebot/package.json': '@aervox/plugin-bot-onebot',
    'plugins/bot/weixin/package.json': '@aervox/plugin-bot-weixin',
  } },
];

function declaresSubmodule(cwd, mount) {
  const file = path.join(cwd, '.gitmodules');
  if (!lstatSync(file, { throwIfNoEntry: false })) return false;
  let output;
  try {
    output = execFileSync('git', ['config', '--file', file, '--null', '--get-regexp', '^submodule\\..*\\.path$'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error.status === 1) return false; // No submodule paths declared.
    throw error;
  }
  return output.split('\0').some(entry => entry.slice(entry.indexOf('\n') + 1) === mount);
}

export function trackedEntries(cwd, { optional = false } = {}) {
  let output;
  try {
    output = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // Synthetic scan fixtures need not be Git repositories. Never hide an index/read error.
    if (optional && /not a git repository/i.test(String(error.stderr))) return [];
    throw error;
  }
  return output.split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, object, stage] = entry.slice(0, tab).split(' ');
    return { mode, object, stage, file: entry.slice(tab + 1) };
  });
}

export function assertCoreSubmodule(cwd = process.cwd(), entries = trackedEntries(cwd, { optional: true })) {
  for (const dependency of PRODUCT_SUBMODULES) assertProductSubmodule(cwd, entries, dependency);
}

// The historical entry point now validates every required product dependency.
function assertProductSubmodule(cwd, entries, { path: mount, label, manifests }) {
  const prefix = `Required ${label} submodule`;
  const links = entries.filter(entry => entry.file === mount && entry.mode === '160000');
  if (!links.length) {
    if (declaresSubmodule(cwd, mount)) throw new Error(`${prefix} is declared but its indexed gitlink is missing. Restore ${mount} before scanning/building.`);
    return;
  }
  if (links.length !== 1 || links[0].stage !== '0') throw new Error(`${prefix} has an unresolved gitlink; resolve the index before scanning/building.`);
  const checkout = path.join(cwd, mount);
  const directory = lstatSync(checkout, { throwIfNoEntry: false });
  const git = lstatSync(path.join(checkout, '.git'), { throwIfNoEntry: false });
  if (!directory?.isDirectory() || !git || git.isSymbolicLink() ||
      Object.keys(manifests).some(file => !lstatSync(path.join(checkout, file), { throwIfNoEntry: false })?.isFile())) {
    throw new Error(`${prefix} is not initialized; run git submodule update --init -- ${mount} before scanning/building, or use ./aervox setup / mise tasks run install.`);
  }
  let top, head;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    head = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error(`${prefix} is not a valid checkout; run git submodule update --init -- ${mount}.`);
  }
  if (realpathSync(top) !== realpathSync(checkout)) throw new Error(`${prefix} must be its own checkout at ${mount}.`);
  if (head !== links[0].object) throw new Error(`${prefix} revision differs from the indexed gitlink; run git submodule update --init -- ${mount}, or stage the intended reviewed ${label} revision.`);
  for (const [file, expectedName] of Object.entries(manifests)) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(path.join(checkout, file), 'utf8')); }
    catch { throw new Error(`${prefix} has an invalid workspace manifest at ${mount}/${file}.`); }
    if (manifest.name !== expectedName) throw new Error(`${prefix} workspace ${mount}/${file} must retain package name ${expectedName}.`);
  }
  if (trackedEntries(checkout).some(entry => entry.mode === '160000')) throw new Error(`${prefix} cannot contain unscanned nested submodules.`);
}

export function initializeCoreSubmodule(cwd = process.cwd()) {
  const entries = trackedEntries(cwd, { optional: true });
  for (const { path: mount } of PRODUCT_SUBMODULES) {
    if (!entries.some(entry => entry.file === mount && entry.mode === '160000')) continue;
    execFileSync('git', ['submodule', 'sync', '--', mount], { cwd, stdio: 'inherit' });
    execFileSync('git', ['submodule', 'update', '--init', '--', mount], { cwd, stdio: 'inherit' });
  }
  assertCoreSubmodule(cwd, entries);
}

/** Parent files plus tracked ordinary files in required product submodules. */
export function productTrackedEntries(cwd = process.cwd()) {
  const entries = trackedEntries(cwd);
  assertCoreSubmodule(cwd, entries);
  const files = entries.filter(entry => entry.mode !== '160000');
  for (const { path: mount } of PRODUCT_SUBMODULES) {
    if (!entries.some(entry => entry.file === mount && entry.mode === '160000')) continue;
    const dependencyEntries = trackedEntries(path.join(cwd, mount));
    files.push(...dependencyEntries.map(entry => ({ ...entry, file: `${mount}/${entry.file}` })));
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--init') initializeCoreSubmodule();
  else assertCoreSubmodule();
}
