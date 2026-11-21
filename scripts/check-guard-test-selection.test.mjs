import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectGuardTests } from './test-guards.mjs';
import { readRootScripts, miseTaskCommand, assertScriptRuns, assertCommandIncludes, assertCommandOrder } from './gate-config.mjs';

const dedicated = ['cli-smoke.test.mjs', 'hls-agent.test.mjs', 'native-runtime-smoke.test.mjs', 'native-search.test.mjs'];

test('guard selection excludes only the four dedicated integration suites and retains every other root test', () => {
  const rootTests = readdirSync(new URL('.', import.meta.url)).filter(file => file.endsWith('.test.mjs'));
  assert.deepEqual(selectGuardTests([...rootTests, 'not-a-test.mjs']), rootTests.filter(file => !dedicated.includes(file)).sort());
  assert.deepEqual(selectGuardTests(['future guard.test.mjs', ...dedicated]), ['future guard.test.mjs']);
});

test('excluded suites retain explicit build prerequisites and full gate coverage', () => {
  // Semantics, not command text: each dedicated suite must still (a) run its own
  // test script and (b) keep whatever build it needs ahead of that test. Rewording,
  // reordering unrelated steps or adding flags no longer fails; dropping the build
  // or inverting the order still does.
  const scripts = readRootScripts();
  const mise = readFileSync(new URL('../mise.toml', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const task = name => miseTaskCommand(mise, name);

  const cli = scripts['test:cli:integration'];
  assertScriptRuns(assert, cli, 'scripts/cli-smoke.test.mjs', 'test:cli:integration');
  assertCommandOrder(assert, cli, 'turbo run build', 'node --test scripts/cli-smoke.test.mjs', 'test:cli:integration');
  assertCommandIncludes(assert, workflow, 'pnpm test:cli:integration', 'ci.yml');

  const hls = scripts['check:hls'];
  assertScriptRuns(assert, hls, 'scripts/hls-agent.test.mjs', 'check:hls');
  assertCommandOrder(assert, hls, 'turbo run build', 'node --test scripts/hls-agent.test.mjs', 'check:hls');

  const search = task('native-search-check');
  assertCommandOrder(assert, search, 'cargo build', 'node --test scripts/native-search.test.mjs', 'native-search-check');

  const native = task('native-runtime-check');
  assertCommandOrder(assert, native, 'turbo run native:build', 'node --test scripts/native-runtime-smoke.test.mjs', 'native-runtime-check');

  for (const gate of ['ci-code', 'ci-code-full']) {
    const command = task(gate);
    for (const entry of ['pnpm check:hls', 'mise tasks run native-search-check', 'mise tasks run native-runtime-check']) {
      assertCommandIncludes(assert, command, entry, gate);
    }
  }
});

function fixture(t, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), 'aervox guard selection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(new URL('./test-guards.mjs', import.meta.url), join(dir, 'scripts/test-guards.mjs'));
  for (const file of dedicated) writeFileSync(join(dir, 'scripts', file), "throw new Error('integration suite must use its declared entry');\n");
  for (const [index, file] of ['check-first.test.mjs', 'other guard.test.mjs'].entries()) writeFileSync(join(dir, 'scripts', file), `
import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
test('selected fixture ${index}', () => {
  appendFileSync('executed', '${index}');
  ${fail && index === 1 ? "throw new Error('selected test failure');" : ''}
});
`);
  // Exercise a standalone command, rather than Node's inherited nested-test context.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [join(dir, 'scripts/test-guards.mjs')], { cwd: tmpdir(), env, encoding: 'utf8' });
  return { result, executed: readFileSync(join(dir, 'executed'), 'utf8').split('').sort() };
}

test('router runs every selected test with spaces in paths from an unrelated directory', t => {
  const { result, executed } = fixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(executed, ['0', '1']);
});

test('router propagates a selected test failure', t => {
  const { result, executed } = fixture(t, true);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(executed, ['0', '1']);
  assert.match(result.stdout, /selected test failure/);
});
