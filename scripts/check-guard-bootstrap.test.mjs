import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aervox guard bootstrap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'scripts'));
  // Shell glob expansion must keep a test filename containing spaces intact.
  const testFile = 'scripts/check-fixture case.test.mjs';
  writeFileSync(join(dir, testFile), '');
  const put = (name, source) => writeFileSync(join(dir, 'bin', name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  put('pnpm', `
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync('calls', JSON.stringify({ command: 'pnpm', args }) + '\\n');
if (JSON.stringify(args) !== JSON.stringify(['--filter', '@aervox/contracts', 'build'])) process.exit(90);
if (process.env.GUARD_FIXTURE_BUILD_EXIT) process.exit(Number(process.env.GUARD_FIXTURE_BUILD_EXIT));
fs.writeFileSync('contracts-built', 'ready');
`);
  put('node', `
import fs from 'node:fs';
fs.appendFileSync('calls', JSON.stringify({ command: 'node', args: process.argv.slice(2) }) + '\\n');
if (!fs.existsSync('contracts-built')) process.exit(91);
`);
  const run = (entry, env = {}) => spawnSync('sh', ['-c', scripts[entry]], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, ...env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  });
  const calls = () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  return { run, calls, testFile };
}

for (const entry of ['check:guards', 'test:guards']) {
  test(`${entry} builds the owning contracts package before cold guard tests`, t => {
    const { run, calls, testFile } = fixture(t);
    const result = run(entry);
    assert.equal(result.status, 0, result.stderr);
    const recorded = calls();
    assert.deepEqual(recorded[0], { command: 'pnpm', args: ['--filter', '@aervox/contracts', 'build'] });
    assert.deepEqual(recorded[1], { command: 'node', args: entry === 'check:guards' ? ['--test', testFile] : ['scripts/test-guards.mjs'] });
    assert.equal(recorded.filter(call => call.command === 'pnpm').length, 1);
  });

  test(`${entry} preserves contracts build failure without starting guards`, t => {
    const { run, calls } = fixture(t);
    const result = run(entry, { GUARD_FIXTURE_BUILD_EXIT: '72' });
    assert.equal(result.status, 72, result.stderr);
    assert.deepEqual(calls(), [{ command: 'pnpm', args: ['--filter', '@aervox/contracts', 'build'] }]);
  });
}
