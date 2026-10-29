import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TURBO = path.join(ROOT, 'node_modules/turbo/bin/turbo');
const SURFACES = ['companion-ui', 'panels-ui', 'proactive-ui', 'workbench-ui'];

function fixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'aervox-turbo-test-cache-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  };
  const rootPackage = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const turbo = JSON.parse(readFileSync(path.join(ROOT, 'turbo.json'), 'utf8'));
  put('package.json', JSON.stringify({ name: 'surface-cache-probe', private: true, packageManager: rootPackage.packageManager }));
  put('pnpm-workspace.yaml', 'packages:\n  - "plugins/surfaces/*"\n');
  put('pnpm-lock.yaml', `lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n${SURFACES.map(name => `  plugins/surfaces/${name}: {}`).join('\n')}\n`);
  // Exercise the repository's real inputs with Turbo; no build or test command runs.
  put('turbo.json', JSON.stringify({ tasks: { test: { inputs: turbo.tasks.test.inputs } } }));
  put('vitest.shared.ts', readFileSync(path.join(ROOT, 'vitest.shared.ts'), 'utf8'));
  put('plugins/vitest.shared.ts', readFileSync(path.join(ROOT, 'plugins/vitest.shared.ts'), 'utf8'));
  for (const name of SURFACES) {
    const dir = `plugins/surfaces/${name}`;
    put(`${dir}/package.json`, JSON.stringify({ name: `@aervox/plugin-${name}`, scripts: { test: 'vitest run' } }));
    put(`${dir}/vitest.config.ts`, readFileSync(path.join(ROOT, dir, 'vitest.config.ts'), 'utf8'));
    put(`${dir}/test/probe.test.ts`, 'export {};\n');
  }
  const hashes = () => {
    const plan = JSON.parse(execFileSync(process.execPath, [TURBO, 'run', 'test', '--dry-run=json'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
    }));
    return new Map(plan.tasks.filter(task => task.task === 'test').map(task => [task.package, task.hash]));
  };
  return { cwd, put, hashes };
}

function assertHashesChanged(before, after, input) {
  assert.equal(before.size, SURFACES.length);
  assert.equal(after.size, SURFACES.length);
  for (const name of SURFACES) {
    const pkg = `@aervox/plugin-${name}`;
    assert.notEqual(after.get(pkg), before.get(pkg), `${input} must invalidate ${pkg} tests`);
  }
}

test('root Vitest configuration changes invalidate all nested surface test caches', t => {
  const { cwd, put, hashes } = fixture(t);
  const before = hashes();
  put('vitest.shared.ts', `${readFileSync(path.join(cwd, 'vitest.shared.ts'), 'utf8')}\nexport const rootCacheProbe = true;\n`);
  assertHashesChanged(before, hashes(), 'vitest.shared.ts');
});

test('plugin Vitest forwarding changes invalidate all nested surface test caches', t => {
  const { cwd, put, hashes } = fixture(t);
  const before = hashes();
  put('plugins/vitest.shared.ts', `${readFileSync(path.join(cwd, 'plugins/vitest.shared.ts'), 'utf8')}\nexport const forwardingCacheProbe = true;\n`);
  assertHashesChanged(before, hashes(), 'plugins/vitest.shared.ts');
});
