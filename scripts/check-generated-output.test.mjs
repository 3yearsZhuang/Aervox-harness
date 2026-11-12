import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { cleanGenerated } from './clean-generated.mjs';
import { copyModelAssets } from '../packages/live2d/scripts/copy-assets.mjs';

function fixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'aervox-generated-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const put = (file, text = 'keep') => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  };
  put('pnpm-workspace.yaml', 'packages:\n  - "plugins/*"\n  - "surfaces/*"\n');
  put('plugins/example/package.json', '{"name":"@aervox/plugin-example"}');
  execFileSync('git', ['init', '-q'], { cwd });
  return { cwd, put };
}

test('cleaner previews and removes only owned outputs, preserving ignored business data', t => {
  const { cwd, put } = fixture(t);
  for (const file of ['dist/plugin.zip', '.turbo/cache', 'plugins/example/dist/index.js', 'plugins/example/out/index.js', 'plugins/example/.turbo/cache', 'node_modules/.turbo/cache', 'data/db.sqlite', '.env', 'models/local.bin', 'plugins/example/data/identity.json']) put(file);
  cleanGenerated({ cwd, dryRun: true });
  assert.ok(existsSync(path.join(cwd, 'dist/plugin.zip')));
  cleanGenerated({ cwd });
  for (const dir of ['dist', '.turbo', 'plugins/example/dist', 'plugins/example/out', 'node_modules/.turbo']) assert.equal(existsSync(path.join(cwd, dir)), false);
  for (const file of ['data/db.sqlite', '.env', 'models/local.bin', 'plugins/example/data/identity.json']) assert.equal(readFileSync(path.join(cwd, file), 'utf8'), 'keep');
});

test('cleaner refuses links and tracked outputs before deleting any output', t => {
  const { cwd, put } = fixture(t);
  put('dist/keep');
  symlinkSync(path.join(cwd, 'dist'), path.join(cwd, 'plugins/example/dist'));
  assert.throws(() => cleanGenerated({ cwd }), /linked output/);
  assert.ok(existsSync(path.join(cwd, 'dist/keep')));
  rmSync(path.join(cwd, 'plugins/example/dist'));
  execFileSync('git', ['add', '-f', 'dist/keep'], { cwd });
  assert.throws(() => cleanGenerated({ cwd }), /tracked output/);
});

test('native cleanup removes Cargo and Gradle intermediates while preserving deliverables', t => {
  const { cwd, put } = fixture(t);
  const caches = ['native/target/debug/deps/object.rlib', 'native/target/release/incremental/state',
    'native/target/x86_64-pc-windows-msvc/debug/build/state', 'native/tools/vector-pilot/target/debug/.fingerprint/state',
    'apps/mobile/android/.gradle/state', 'apps/mobile/android/app/build/intermediates/classes'];
  const originals = ['native/target/debug/bundle/App.dmg', 'native/target/debug/aervox-runtime',
    'apps/mobile/android/app/build/outputs/apk/debug/app.apk', 'data/aervox.db', 'artifacts/avd/userdata.img'];
  for (const file of [...caches, ...originals]) put(file);
  cleanGenerated({ cwd, native: true, dryRun: true });
  for (const file of caches) assert.ok(existsSync(path.join(cwd, file)));
  cleanGenerated({ cwd, native: true });
  for (const file of caches) assert.equal(existsSync(path.join(cwd, file)), false, file);
  for (const file of originals) assert.equal(readFileSync(path.join(cwd, file), 'utf8'), 'keep', file);
  assert.doesNotThrow(() => cleanGenerated({ cwd, native: true }));
});

test('native cleanup rejects a linked target before removing ordinary outputs', t => {
  const { cwd, put } = fixture(t);
  put('dist/keep');
  put('outside/debug/deps/keep');
  mkdirSync(path.join(cwd, 'native'));
  symlinkSync(path.join(cwd, 'outside'), path.join(cwd, 'native/target'));
  assert.throws(() => cleanGenerated({ cwd, native: true }), /linked output/);
  assert.ok(existsSync(path.join(cwd, 'dist/keep')));
  assert.ok(existsSync(path.join(cwd, 'outside/debug/deps/keep')));
});

test('reference dependency cleanup is explicit and checks the subrepository index', t => {
  const { cwd, put } = fixture(t);
  put('reference/example/node_modules/dep/index.js');
  const reference = path.join(cwd, 'reference/example');
  execFileSync('git', ['init', '-q'], { cwd: reference });
  execFileSync('git', ['update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,reference/example'], { cwd });
  cleanGenerated({ cwd });
  assert.ok(existsSync(path.join(reference, 'node_modules/dep/index.js')));
  execFileSync('git', ['add', '-f', 'node_modules/dep/index.js'], { cwd: reference });
  assert.throws(() => cleanGenerated({ cwd, references: true }), /tracked reference dependencies/);
  execFileSync('git', ['update-index', '--force-remove', 'node_modules/dep/index.js'], { cwd: reference });
  cleanGenerated({ cwd, references: true });
  assert.equal(existsSync(path.join(reference, 'node_modules')), false);
  put('reference/example/node_modules/dep/index.js');
  execFileSync('git', ['config', 'core.worktree', cwd], { cwd: reference });
  assert.throws(() => cleanGenerated({ cwd, references: true }), /binding differs/);
  assert.ok(existsSync(path.join(reference, 'node_modules/dep/index.js')));
});

test('cleanup refuses an output opened by another process before deleting any path', async t => {
  if (process.platform === 'win32') return t.skip('POSIX open-file inspection');
  const { cwd, put } = fixture(t);
  put('dist/open');
  put('.turbo/keep');
  const child = spawn(process.execPath, ['-e', 'require("node:fs").openSync(process.argv[1], "r"); process.stdout.write("ready"); setInterval(() => {}, 1000);', path.join(cwd, 'dist/open')]);
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
  });
  assert.throws(() => cleanGenerated({ cwd }), /Build output is open/);
  assert.ok(existsSync(path.join(cwd, '.turbo/keep')));
});

test('both generated asset targets drop removed motions and preserve adjacent models', t => {
  const { cwd, put } = fixture(t);
  put('source/motion.json');
  put('source/model.json');
  const targets = ['desktop', 'web'].map(dir => path.join(cwd, dir));
  for (const dir of ['desktop', 'web']) put(`${dir}/custom-model/identity`);
  copyModelAssets(path.join(cwd, 'source'), targets);
  rmSync(path.join(cwd, 'source/motion.json'));
  copyModelAssets(path.join(cwd, 'source'), targets);
  for (const target of targets) {
    assert.equal(existsSync(path.join(target, 'mizuki/motion.json')), false);
    assert.ok(existsSync(path.join(target, 'mizuki/model.json')));
    assert.equal(readFileSync(path.join(target, 'custom-model/identity'), 'utf8'), 'keep');
  }
});

test('launcher preserves frozen-install error and never falls back to lockfile resolution', t => {
  if (process.platform === 'win32') return t.skip('bash launcher is a Unix entrypoint');
  const { cwd, put } = fixture(t);
  copyFileSync(new URL('../aervox', import.meta.url), path.join(cwd, 'aervox'));
  put('scripts/project-env.sh', readFileSync(new URL('./project-env.sh', import.meta.url)));
  put('scripts/core-submodule.mjs', readFileSync(new URL('./core-submodule.mjs', import.meta.url)));
  put('pnpm-lock.yaml', 'locked');
  put('bin/mise', '#!/bin/sh\nshift\nshift\nexec "$@"\n');
  put('bin/lsof', '#!/bin/sh\nexit 1\n');
  put('bin/pnpm', '#!/bin/sh\nprintf "%s\\n" "$*" >> calls\necho ORIGINAL_INSTALL_ERROR >&2\nexit 42\n');
  for (const name of ['mise', 'pnpm', 'lsof']) chmodSync(path.join(cwd, 'bin', name), 0o755);
  const result = spawnSync('bash', ['aervox', 'dev', 'api'], { cwd, env: { ...process.env, PATH: `${cwd}/bin:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(result.status, 42);
  assert.match(result.stderr, /ORIGINAL_INSTALL_ERROR/);
  assert.equal(readFileSync(path.join(cwd, 'calls'), 'utf8').trim(), 'install --frozen-lockfile --prefer-offline');
  assert.equal(readFileSync(path.join(cwd, 'pnpm-lock.yaml'), 'utf8'), 'locked');
  for (const file of ['clean-generated.mjs', 'workspaces.mjs']) {
    mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    copyFileSync(new URL(file, import.meta.url), path.join(cwd, 'scripts', file));
  }
  const clean = spawnSync('bash', ['aervox', 'clean', '--dry-run'], { cwd, env: { ...process.env, PATH: `${cwd}/bin:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /未删除文件/);
  assert.equal(readFileSync(path.join(cwd, 'calls'), 'utf8').trim().split('\n').length, 1);
});

test('asset synchronization refuses linked consumer directories before changing either target', t => {
  const { cwd, put } = fixture(t);
  put('source/new.json', 'new');
  put('desktop/mizuki/old.json', 'old');
  put('outside/mizuki/custom.json', 'keep');
  symlinkSync(path.join(cwd, 'outside'), path.join(cwd, 'web'), 'dir');
  assert.throws(() => copyModelAssets(path.join(cwd, 'source'), ['desktop', 'web'].map(dir => path.join(cwd, dir))), /链接资源目录/);
  assert.equal(readFileSync(path.join(cwd, 'desktop/mizuki/old.json'), 'utf8'), 'old');
  assert.equal(readFileSync(path.join(cwd, 'outside/mizuki/custom.json'), 'utf8'), 'keep');
});
