import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Product dependency only. Reference repositories never become default scan/install inputs.
export const CORE_SUBMODULE = 'packages/core';

function declaresCoreSubmodule(cwd) {
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
  return output.split('\0').some(entry => entry.slice(entry.indexOf('\n') + 1) === CORE_SUBMODULE);
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
  const links = entries.filter(entry => entry.file === CORE_SUBMODULE && entry.mode === '160000');
  if (!links.length) {
    if (declaresCoreSubmodule(cwd)) throw new Error('Required Core submodule is declared but its indexed gitlink is missing. Restore packages/core before scanning/building.');
    return;
  }
  if (links.length !== 1 || links[0].stage !== '0') throw new Error('Required Core submodule has an unresolved gitlink; resolve the index before scanning/building.');
  const core = path.join(cwd, CORE_SUBMODULE);
  const directory = lstatSync(core, { throwIfNoEntry: false });
  const git = lstatSync(path.join(core, '.git'), { throwIfNoEntry: false });
  const manifest = lstatSync(path.join(core, 'package.json'), { throwIfNoEntry: false });
  if (!directory?.isDirectory() || !git || git.isSymbolicLink() || !manifest?.isFile()) {
    throw new Error('Required Core submodule is not initialized; run git submodule update --init -- packages/core before scanning/building, or use ./aervox setup / mise tasks run install.');
  }
  let top, head;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: core, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    head = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: core, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error('Required Core submodule is not a valid checkout; run git submodule update --init -- packages/core.');
  }
  if (realpathSync(top) !== realpathSync(core)) throw new Error('Required Core submodule must be its own checkout at packages/core.');
  if (head !== links[0].object) throw new Error('Required Core submodule revision differs from the indexed gitlink; run git submodule update --init -- packages/core, or stage the intended reviewed Core revision.');
}

export function initializeCoreSubmodule(cwd = process.cwd()) {
  const entries = trackedEntries(cwd, { optional: true });
  if (!entries.some(entry => entry.file === CORE_SUBMODULE && entry.mode === '160000')) {
    assertCoreSubmodule(cwd, entries);
    return;
  }
  execFileSync('git', ['submodule', 'sync', '--', CORE_SUBMODULE], { cwd, stdio: 'inherit' });
  execFileSync('git', ['submodule', 'update', '--init', '--', CORE_SUBMODULE], { cwd, stdio: 'inherit' });
  assertCoreSubmodule(cwd, entries);
}

/** Parent files plus tracked ordinary files in the one required product submodule. */
export function productTrackedEntries(cwd = process.cwd()) {
  const entries = trackedEntries(cwd);
  assertCoreSubmodule(cwd, entries);
  const files = entries.filter(entry => entry.mode !== '160000');
  if (entries.some(entry => entry.file === CORE_SUBMODULE && entry.mode === '160000')) {
    const coreEntries = trackedEntries(path.join(cwd, CORE_SUBMODULE));
    if (coreEntries.some(entry => entry.mode === '160000')) throw new Error('Required Core submodule cannot contain unscanned nested submodules.');
    files.push(...coreEntries.map(entry => ({ ...entry, file: `${CORE_SUBMODULE}/${entry.file}` })));
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--init') initializeCoreSubmodule();
  else assertCoreSubmodule();
}
