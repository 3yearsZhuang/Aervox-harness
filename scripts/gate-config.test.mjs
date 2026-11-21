import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  referencedScripts, assertScriptRuns, assertScriptRunsAll,
  assertGateNotWeakened, assertCommandIncludes, assertCommandOrder,
  miseTaskCommand, readRootScripts,
} from './gate-config.mjs';

// 这个助手决定"脚本是否仍在门禁里"。它自身必须被测试，否则一旦解析退化成
// 永远返回 true，所有依赖它的守卫都会静默失效。

test('extracts scripts from the two node invocation shapes the repo uses', () => {
  assert.deepEqual(
    referencedScripts('node --test scripts/a.test.mjs scripts/b.test.mjs && node scripts/audit.mjs'),
    ['scripts/a.test.mjs', 'scripts/b.test.mjs', 'scripts/audit.mjs'],
  );
  assert.deepEqual(referencedScripts('mise exec -- node --test scripts/a.test.mjs'), ['scripts/a.test.mjs']);
  assert.deepEqual(referencedScripts('turbo run build && node --test scripts/a.test.mjs'), ['scripts/a.test.mjs']);
  assert.deepEqual(referencedScripts('node --test --experimental-strip-types scripts/a.test.mjs'), ['scripts/a.test.mjs']);
  // 引号不应留在路径里，否则合法路径会被误判为缺失
  assert.deepEqual(referencedScripts('node --test "scripts/a.test.mjs"'), ['scripts/a.test.mjs']);
});

test('unknown command shapes yield no scripts, so callers fail closed rather than pass', () => {
  // 这些形态本模块不解析；返回空集合会让 assertScriptRuns* 失败，正是期望行为。
  assert.deepEqual(referencedScripts('NODE_OPTIONS=x node --test scripts/a.test.mjs'), []);
  assert.deepEqual(referencedScripts('pnpm exec node --test scripts/a.test.mjs'), []);
  assert.deepEqual(referencedScripts('mise tasks run dep-audit'), []);
  assert.deepEqual(referencedScripts(''), []);
  assert.deepEqual(referencedScripts(undefined), []);
});

test('adding or reordering scripts keeps coverage assertions green', () => {
  const target = ['scripts/a.test.mjs'];
  assertScriptRunsAll(assert, 'node --test scripts/a.test.mjs scripts/b.test.mjs', target, 'gate');
  assertScriptRunsAll(assert, 'node --test scripts/b.test.mjs scripts/a.test.mjs', target, 'gate');
  assertScriptRuns(assert, 'node --test scripts/a.test.mjs', 'scripts/a.test.mjs', 'gate');
});

test('dropping a script fails with a message that names it', () => {
  assert.throws(
    () => assertScriptRunsAll(assert, 'node --test scripts/b.test.mjs', ['scripts/a.test.mjs'], 'gate'),
    /gate dropped scripts\/a\.test\.mjs/,
  );
  assert.throws(
    () => assertScriptRuns(assert, 'node --test scripts/b.test.mjs', 'scripts/a.test.mjs', 'gate'),
    /must run scripts\/a\.test\.mjs/,
  );
});

// 关键回归：脚本仍出现在命令里，但失败不再传播，等于覆盖被废除。
// 早期实现只做成员判定，这四种改写全部会判为"覆盖完好"。
test('rejects rewrites that would keep the script but swallow its failure', () => {
  const cmd = 'node --test scripts/a.test.mjs';
  for (const weakened of [
    `${cmd} || true`,
    `${cmd} || :`,
    `${cmd} || exit 0`,
    `${cmd} | cat`,
    `${cmd} | tee run.log`,
    `${cmd} ; echo done`,
    `${cmd} ; true`,
  ]) {
    assert.throws(
      () => assertScriptRunsAll(assert, weakened, ['scripts/a.test.mjs'], 'gate'),
      /must not/,
      `expected to block: ${weakened}`,
    );
    assert.throws(() => assertGateNotWeakened(assert, weakened, 'gate'));
  }
  // 正常形态不受影响
  assert.doesNotThrow(() => assertGateNotWeakened(assert, 'node --test scripts/a.test.mjs && node scripts/b.mjs'));
});

test('miseTaskCommand returns the command or null, never a silent empty string', () => {
  const mise = 'ci-code = "pnpm a && pnpm b"\nother = "x"\n';
  assert.equal(miseTaskCommand(mise, 'ci-code'), 'pnpm a && pnpm b');
  assert.equal(miseTaskCommand(mise, 'missing'), null);
});

test('the real repository gates still satisfy the patch-test coverage contract', () => {
  const scripts = readRootScripts();
  assertScriptRunsAll(assert, scripts['check:dependency-audit'], [
    'scripts/check-deepmerge-patch.test.mjs',
    'scripts/check-minimatch-patches.test.mjs',
    'scripts/check-glob-patch.test.mjs',
    'scripts/check-cli-dependency-fixes.test.mjs',
    'scripts/check-dependency-audit.mjs',
  ], 'check:dependency-audit');
});

// 顺序断言用于"构建必须先于测试"这类真实约束：整条命令正则会把无关步骤的
// 增删也算作失败，而只比较 token 位置既能放过无关改动，又能抓住顺序反转。
test('assertCommandOrder enforces ordering without freezing the command text', () => {
  const build = 'turbo run build';
  const run = 'node --test scripts/cli-smoke.test.mjs';
  assert.doesNotThrow(() => assertCommandOrder(assert, `${build} --filter=a && ${run}`, build, run));
  assert.doesNotThrow(() => assertCommandOrder(assert, `pnpm x && ${build} --filter=a --filter=b && pnpm y && ${run}`, build, run));
  assert.throws(() => assertCommandOrder(assert, `${run} && ${build}`, build, run), /must run .* before/);
  assert.throws(() => assertCommandOrder(assert, run, build, run), /must include/);
  assert.throws(() => assertCommandOrder(assert, build, build, run), /must include/);
});

test('assertCommandIncludes finds an action token and rejects weakening', () => {
  assert.doesNotThrow(() => assertCommandIncludes(assert, 'pnpm build && pnpm check:standards', 'pnpm check:standards'));
  assert.throws(() => assertCommandIncludes(assert, 'pnpm build', 'pnpm check:standards'), /must include/);
  assert.throws(() => assertCommandIncludes(assert, 'pnpm check:standards || true', 'pnpm check:standards'), /must not/);
  // A missing command is reported as missing rather than as a missing token.
  assert.throws(() => assertCommandIncludes(assert, undefined, 'x'), /command is missing/);
});

test('miseTaskCommand reads both inline tasks and [tasks.*] sections', () => {
  const toml = [
    'ci-code = "pnpm a && pnpm b"',
    '',
    '[tasks.native-search-check]',
    'description = "x"',
    'run = "cargo build && node --test s.mjs"',
    '',
    '[tasks.other]',
    'description = "no run field"',
  ].join('\n');
  assert.equal(miseTaskCommand(toml, 'ci-code'), 'pnpm a && pnpm b');
  assert.equal(miseTaskCommand(toml, 'native-search-check'), 'cargo build && node --test s.mjs');
  assert.equal(miseTaskCommand(toml, 'other'), null);
  assert.equal(miseTaskCommand(toml, 'absent'), null);
  assert.equal(miseTaskCommand(undefined, 'ci-code'), null);
});
