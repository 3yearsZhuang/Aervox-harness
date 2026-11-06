import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// These suites have dedicated entries that prepare their business/native builds:
// test:cli:integration, check:hls, native-runtime-check and native-search-check.
const integrationTests = new Set([
  'cli-smoke.test.mjs',
  'hls-agent.test.mjs',
  'native-runtime-smoke.test.mjs',
  'native-search.test.mjs',
]);

export function selectGuardTests(files) {
  return files.filter(file => file.endsWith('.test.mjs') && !integrationTests.has(file)).sort();
}

if (import.meta.main) {
  const directory = dirname(fileURLToPath(import.meta.url));
  const files = selectGuardTests(readdirSync(directory)).map(file => join(directory, file));
  if (!files.length) throw new Error('No root guard tests were found');
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: dirname(directory), stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
