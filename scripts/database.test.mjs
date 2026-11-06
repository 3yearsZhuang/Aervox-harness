import assert from 'node:assert/strict';
import test from 'node:test';
import { runDatabaseCommand } from './database.mjs';

test('migration receives credentials only from environment and prints a safe receipt', async () => {
  let input, output;
  await runDatabaseCommand(['migrate', '--source', '/source.db', '--schema', 'dedicated', '--backup', '/backup', '--vault', '/vault.db'], {
    preparePostgresqlDatabaseMigration: async value => { input = value; return { phase: 'verified', receiptPath: '/receipt.json', target: { locality: 'verified-local', schema: 'dedicated' } }; },
  }, { AERVOX_POSTGRESQL_URL: 'postgresql://user:secret@example/db' }, text => { output = text; });
  assert.equal(input.connectionString, 'postgresql://user:secret@example/db');
  assert.equal(input.protectedVaultPath, '/vault.db');
  assert.equal(JSON.parse(output).activated, false);
  assert.equal(output.includes('secret'), false);
});

test('rejects inline URL, unknown/repeated flags and missing migration fields before calling API', async () => {
  for (const argv of [
    ['migrate', '--url', 'postgresql://user:secret@example/db'],
    ['status', '--source', '/a.db'], ['activate', '--receipt', '/a', '--receipt', '/b'],
    ['migrate', '--source', '/a', '--schema', 'dedicated'],
  ]) await assert.rejects(runDatabaseCommand(argv, {}, {}, () => {}));
});

test('status and abort work without a PostgreSQL credential', async () => {
  let source;
  await runDatabaseCommand(['status'], { getDatabaseSelectionStatus: async () => ({ backend: 'sqlite' }) }, {}, () => {});
  await runDatabaseCommand(['abort', '--source', '/source.db'], { abortSqliteToPostgresqlMigration: async input => { source = input.sourcePath; return {}; } }, {}, () => {});
  assert.equal(source, '/source.db');
});
