import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertCoreSubmodule, initializeCoreSubmodule, productTrackedEntries } from './core-submodule.mjs';
import { collectFiles } from './source-files.mjs';
import { discoverWorkspaces } from './workspaces.mjs';
import { inspectTrackedFiles } from './check-tracked-files.mjs';
import { cleanGenerated } from './clean-generated.mjs';
import { getChangedFiles, resolveChangeScope, buildTurboFilterArgs } from './ci-scope.mjs';

const PLUGINS = ['focus-mode', 'bot-onebot', 'bot-weixin'];

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'aervox-plugins-submodule-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'host'), source = path.join(home, 'collection');
  const put = (cwd, file, text) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const dir of [root, source]) {
    mkdirSync(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'Test Fixture');
    git(dir, 'config', 'user.email', 'fixture@example.invalid');
  }
  for (const name of PLUGINS) {
    put(source, `${name}/package.json`, JSON.stringify({ name: `@aervox/plugin-${name}` }));
    put(source, `${name}/src/index.ts`, 'export {};');
  }
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'fixture collection');
  put(root, 'pnpm-workspace.yaml', 'packages:\n  - "plugins/*"\n');
  put(root, 'package.json', '{"private":true}');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'plugins');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture host');
  const plugins = path.join(root, 'plugins');
  git(plugins, 'config', 'user.name', 'Test Fixture');
  git(plugins, 'config', 'user.email', 'fixture@example.invalid');
  return { root, plugins, source, put, git };
}

test('plugin collection retains workspace ownership and tracked safety scans without optional references', t => {
  const { root, plugins, put, git } = fixture(t);
  git(root, 'update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,reference/unused');
  assert.deepEqual(discoverWorkspaces(root).map(pkg => pkg.name).sort(), PLUGINS.map(name => `@aervox/plugin-${name}`).sort());
  assert.ok(collectFiles(['plugins'], { cwd: root, extensions: /\.ts$/, ignoreDirectories: /(?:^|\/)(?:\.git|node_modules)(?:\/|$)/ }).includes('plugins/focus-mode/src/index.ts'));
  put(plugins, 'local/business.db', 'untracked business data');
  assert.equal(productTrackedEntries(root).some(entry => entry.file.includes('business.db') || entry.file.startsWith('reference/')), false);
  put(plugins, '.env', 'EXAMPLE=secret');
  git(plugins, 'add', '-f', '.env');
  assert.ok(inspectTrackedFiles({ cwd: root }).violations.some(v => v.file === 'plugins/.env' && v.rule === 'credential-file'));
  put(plugins, 'focus-mode/dist/owned.js', 'tracked output must survive');
  git(plugins, 'add', '-f', 'focus-mode/dist/owned.js');
  assert.throws(() => cleanGenerated({ cwd: root }), /Refusing tracked output: plugins\/focus-mode\/dist/);
  assert.equal(readFileSync(path.join(plugins, 'focus-mode/dist/owned.js'), 'utf8'), 'tracked output must survive');
});

test('missing collection blocks product scans and initialization restores the pinned checkout', t => {
  const { root, plugins } = fixture(t);
  rmSync(plugins, { recursive: true, force: true });
  for (const inspect of [
    () => assertCoreSubmodule(root),
    () => discoverWorkspaces(root),
    () => collectFiles(['plugins'], { cwd: root, extensions: /\.ts$/, ignoreDirectories: /node_modules/ }),
    () => inspectTrackedFiles({ cwd: root }),
    () => cleanGenerated({ cwd: root }),
  ]) assert.throws(inspect, /Required Plugins submodule is not initialized/);
  initializeCoreSubmodule(root);
  assert.doesNotThrow(() => assertCoreSubmodule(root));
});

test('each required plugin workspace manifest is checked before accepting the collection', t => {
  const { root, plugins, put, git } = fixture(t);
  for (const name of PLUGINS) {
    const file = `${name}/package.json`;
    rmSync(path.join(plugins, file));
    assert.throws(() => discoverWorkspaces(root), /Required Plugins submodule is not initialized/, file);
    git(plugins, 'restore', '--', file);
    put(plugins, file, '{"name":"@aervox/renamed-plugin"}');
    assert.throws(() => assertCoreSubmodule(root), /must retain package name/);
    put(plugins, file, '{broken');
    assert.throws(() => assertCoreSubmodule(root), /invalid workspace manifest/);
    git(plugins, 'restore', '--', file);
  }
});

test('collection revision and dirty worktree changes cannot disappear behind Git ignore settings', t => {
  const { root, plugins, put, git } = fixture(t);
  git(root, 'config', 'diff.ignoreSubmodules', 'all');
  git(root, 'config', 'submodule.plugins.ignore', 'all');
  put(plugins, 'focus-mode/src/index.ts', 'export const changed = true;');
  assert.ok(getChangedFiles(null, root).includes('plugins'));
  git(plugins, 'add', '.');
  git(plugins, 'commit', '-qm', 'fixture updated plugin');
  assert.throws(() => assertCoreSubmodule(root), /Required Plugins submodule revision differs/);
  const scope = resolveChangeScope(getChangedFiles(null, root), { packageInputs: [], sharedInputs: [], globalDependencies: [] });
  assert.equal(scope.mode, 'full');
  assert.deepEqual(buildTurboFilterArgs('origin/main', scope), []);
  git(root, 'add', 'plugins');
  assert.doesNotThrow(() => assertCoreSubmodule(root));
});

test('an unresolved collection gitlink blocks scans before selecting any workspace', t => {
  const { root, plugins, git } = fixture(t);
  const revision = git(plugins, 'rev-parse', 'HEAD');
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: root,
    input: `0 ${'0'.repeat(40)}\tplugins\n160000 ${revision} 1\tplugins\n160000 ${revision} 2\tplugins\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.match(git(root, 'ls-files', '--unmerged', '--', 'plugins'), /160000 [a-f0-9]+ 1\tplugins/);
  assert.throws(() => assertCoreSubmodule(root), /Required Plugins submodule has an unresolved gitlink/);
  assert.throws(() => discoverWorkspaces(root), /Required Plugins submodule has an unresolved gitlink/);
});

test('linked, invalid, removed and nested plugin checkouts fail closed', t => {
  const { root, plugins, source, git, put } = fixture(t);
  rmSync(plugins, { recursive: true, force: true });
  symlinkSync(source, plugins);
  assert.throws(() => assertCoreSubmodule(root), /Required Plugins submodule is not initialized/);
  rmSync(plugins);
  for (const name of PLUGINS) put(plugins, `${name}/package.json`, '{}');
  put(plugins, '.git', 'gitdir: /does/not/exist\n');
  assert.throws(() => assertCoreSubmodule(root), /Required Plugins submodule is not a valid checkout/);
  rmSync(plugins, { recursive: true, force: true });
  initializeCoreSubmodule(root);
  git(plugins, 'update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,nested/dependency');
  assert.throws(() => assertCoreSubmodule(root), /Required Plugins submodule cannot contain unscanned nested submodules/);
  assert.throws(() => productTrackedEntries(root), /Required Plugins submodule cannot contain unscanned nested submodules/);
  git(root, 'update-index', '--force-remove', 'plugins');
  assert.throws(() => discoverWorkspaces(root), /Required Plugins submodule is declared but its indexed gitlink is missing/);
});

test('public build and test commands reject missing Plugins before running Turbo', t => {
  const { root, plugins, put } = fixture(t);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  put(root, 'package.json', JSON.stringify(manifest));
  put(root, 'scripts/core-submodule.mjs', readFileSync(new URL('./core-submodule.mjs', import.meta.url)));
  rmSync(plugins, { recursive: true, force: true });
  for (const name of ['build', 'typecheck', 'test']) {
    const result = spawnSync('pnpm', ['run', name], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' },
    });
    assert.equal(result.status, 1, `${name}: ${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /Required Plugins submodule is not initialized/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /turbo: (?:command )?not found/);
  }
});
