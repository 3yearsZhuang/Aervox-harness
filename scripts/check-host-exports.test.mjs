import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { inspectSource } from './import-boundary.mjs';
import { inspectSubpackage } from './check-dep-hoisting.mjs';

test('host runtime publishes only explicit shared utilities and module ports', () => {
  const pkg = JSON.parse(readFileSync(new URL('../packages/host-runtime/package.json', import.meta.url)));
  for (const key of Object.keys(pkg.exports)) {
    assert.ok(key === '.' || /^\.\/shared\/[^/*]+$/.test(key) || /^\.\/modules\/[^/*]+\/[^/*]+\/index$/.test(key), key);
  }
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  assert.throws(() => require.resolve('@aervox/host-runtime/modules/companion/conversation/agent-executor'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  assert.ok(pkg.exports['./modules/companion/conversation/index']);
});

test('product code cannot consume private test aliases or research packages', () => {
  assert.ok(inspectSource('apps/web/src/unsafe.ts', 'import "@aervox/host-runtime-test/private";').some(v => v.rule === 'production-no-test-alias'));
  assert.ok(inspectSource('apps/web/src/unsafe.ts', 'import "@aervox/research-deletion-fault-testing/langchain";').some(v => v.rule === 'product-no-research'));
  assert.ok(inspectSubpackage('apps/web', { dependencies: { '@aervox/research-deletion-fault-testing': 'workspace:*' } }, new Set()).length);
});
