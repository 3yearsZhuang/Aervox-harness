import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertCoreSubmodule, initializeCoreSubmodule, productTrackedEntries } from './core-submodule.mjs';
import { collectFiles } from './source-files.mjs';
import { discoverWorkspaces, workspaceOwner } from './workspaces.mjs';
import { inspectTrackedFiles } from './check-tracked-files.mjs';
import { cleanGenerated } from './clean-generated.mjs';
import { getChangedFiles, resolveChangeScope, buildTurboFilterArgs } from './ci-scope.mjs';

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'aervox-core-submodule-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'host'), source = path.join(home, 'kernel');
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
  put(source, 'package.json', '{"name":"@aervox/core"}');
  put(source, 'src/index.ts', 'export {};');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'fixture core');
  put(root, 'pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
  put(root, 'package.json', '{"private":true}');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'packages/core');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture host');
  const core = path.join(root, 'packages/core');
  git(core, 'config', 'user.name', 'Test Fixture');
  git(core, 'config', 'user.email', 'fixture@example.invalid');
  return { root, core, source, put, git };
}

test('required Core is scanned as a workspace and tracked product source; references stay optional', t => {
  const { root, core, put, git } = fixture(t);
  git(root, 'update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,reference/unused');
  put(core, 'ignored/business.db', 'must not inspect untracked user data');
  assert.doesNotThrow(() => assertCoreSubmodule(root));
  const workspaces = discoverWorkspaces(root);
  assert.equal(workspaces[0].name, '@aervox/core');
  assert.equal(workspaceOwner('packages/core', workspaces).name, '@aervox/core');
  assert.ok(collectFiles(['packages'], { cwd: root, extensions: /\.ts$/, ignoreDirectories: /(?:^|\/)(?:\.git|node_modules)(?:\/|$)/ }).includes('packages/core/src/index.ts'));
  const files = productTrackedEntries(root).map(entry => entry.file);
  assert.ok(files.includes('packages/core/src/index.ts'));
  assert.equal(files.some(file => file.startsWith('reference/') || file.includes('business.db')), false);
  assert.deepEqual(inspectTrackedFiles({ cwd: root }).violations, []);
  put(core, '.env', 'EXAMPLE=secret');
  git(core, 'add', '-f', '.env');
  assert.ok(inspectTrackedFiles({ cwd: root }).violations.some(v => v.file === 'packages/core/.env' && v.rule === 'credential-file'));
});

test('missing Core blocks workspace/source/safety scans and explicit initialization restores it', t => {
  const { root, core } = fixture(t);
  rmSync(core, { recursive: true, force: true });
  for (const inspect of [
    () => assertCoreSubmodule(root),
    () => discoverWorkspaces(root),
    () => collectFiles(['packages'], { cwd: root, extensions: /\.ts$/, ignoreDirectories: /node_modules/ }),
    () => inspectTrackedFiles({ cwd: root }),
  ]) assert.throws(inspect, /Required Core submodule is not initialized/);
  initializeCoreSubmodule(root);
  assert.doesNotThrow(() => assertCoreSubmodule(root));
});

test('root public commands reject missing Core before reaching Turbo or stale build output', t => {
  const { root, core, put } = fixture(t);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  put(root, 'package.json', JSON.stringify(manifest));
  put(root, 'scripts/core-submodule.mjs', readFileSync(new URL('./core-submodule.mjs', import.meta.url)));
  rmSync(core, { recursive: true, force: true });
  put(core, 'dist/index.js', 'throw new Error("stale build output must never run");');
  const commands = Object.entries(manifest.scripts)
    .filter(([name, command]) => /(?:^|&&\s+)turbo\s/.test(command) || ['benchmark:core', 'test:all'].includes(name))
    .map(([name]) => name);
  for (const name of ['build', 'typecheck', 'test', 'dev', 'benchmark:core']) assert.ok(commands.includes(name), name);
  for (const name of commands) {
    const result = spawnSync('pnpm', ['run', name], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      // This fixture tests dispatch with stale outputs, without installing the product dependency graph.
      env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' },
    });
    assert.equal(result.status, 1, `${name}: ${result.stdout}\n${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /Required Core submodule is not initialized/, `${name} must fail at dependency validation`);
    assert.doesNotMatch(output, /(?:turbo: (?:command )?not found|stale build output must never run)/);
  }
});

test('mismatched Core revision blocks scans until the intended gitlink is staged', t => {
  const { root, core, put, git } = fixture(t);
  put(core, 'src/new.ts', 'export {};');
  git(core, 'add', '.');
  git(core, 'commit', '-qm', 'fixture new core');
  assert.throws(() => assertCoreSubmodule(root), /revision differs from the indexed gitlink/);
  git(root, 'config', 'diff.ignoreSubmodules', 'all');
  git(root, 'config', 'submodule.packages/core.ignore', 'all');
  assert.ok(getChangedFiles(null, root).includes('packages/core'));
  git(root, 'add', 'packages/core');
  assert.doesNotThrow(() => assertCoreSubmodule(root));
  const scope = resolveChangeScope(['packages/core'], { packageInputs: [], sharedInputs: [], globalDependencies: [] });
  assert.equal(scope.mode, 'scoped');
  assert.deepEqual(scope.packages, ['@aervox/core']);
  assert.ok(buildTurboFilterArgs('origin/main', scope).includes('--filter=...@aervox/core...'));
});

test('linked or invalid Core checkouts cannot impersonate an initialized dependency', t => {
  const { root, core, source } = fixture(t);
  rmSync(core, { recursive: true, force: true });
  symlinkSync(source, core);
  assert.throws(() => assertCoreSubmodule(root), /not initialized/);
  rmSync(core);
  mkdirSync(core);
  writeFileSync(path.join(core, '.git'), 'gitdir: /does/not/exist\n');
  writeFileSync(path.join(core, 'package.json'), '{}');
  assert.throws(() => assertCoreSubmodule(root), /not a valid checkout/);
});

test('declared Core with a removed indexed gitlink cannot silently disappear from validation', t => {
  const { root, git } = fixture(t);
  git(root, 'update-index', '--force-remove', 'packages/core');
  assert.throws(() => discoverWorkspaces(root), /indexed gitlink is missing/);
  assert.throws(() => initializeCoreSubmodule(root), /indexed gitlink is missing/);
});

test('nested Core gitlinks fail closed and tracked Core output is never cleaned', t => {
  const { root, core, put, git } = fixture(t);
  put(core, 'dist/owned.js', 'owned source artifact');
  git(core, 'add', '-f', 'dist/owned.js');
  assert.throws(() => cleanGenerated({ cwd: root }), /Refusing tracked output: packages\/core\/dist/);
  assert.equal(readFileSync(path.join(core, 'dist/owned.js'), 'utf8'), 'owned source artifact');
  git(core, 'update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,nested/dependency');
  assert.throws(() => productTrackedEntries(root), /unscanned nested submodules/);
});

test('pre-migration ordinary Core and non-Git workspace fixtures remain supported', t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'aervox-core-ordinary-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, 'packages/core'), { recursive: true });
  writeFileSync(path.join(cwd, 'packages/core/package.json'), '{"name":"@aervox/core"}');
  assert.doesNotThrow(() => assertCoreSubmodule(cwd));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['add', '.'], { cwd });
  assert.doesNotThrow(() => assertCoreSubmodule(cwd));
  assert.ok(productTrackedEntries(cwd).some(entry => entry.file === 'packages/core/package.json'));
});
