import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('the real test:unit entry selects every migrated UI package', () => {
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
    '--silent', 'run', 'test:unit', '--dry-run=json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const plan = JSON.parse(result.stdout);
  for (const name of ['companion-ui', 'panels-ui', 'proactive-ui', 'workbench-ui']) {
    const task = plan.tasks.find(task => task.taskId === `@aervox/plugin-${name}#test`);
    assert.ok(task, `test:unit omitted @aervox/plugin-${name}`);
    assert.equal(path.normalize(task.directory), path.normalize(`plugins/surfaces/${name}`));
  }
});
