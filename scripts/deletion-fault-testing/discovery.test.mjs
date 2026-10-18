import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { discoverCandidates } from './discovery.mjs';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('./discovery.mjs', import.meta.url));

async function fixture(t, sources) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deletion-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  }
  return root;
}

test('finds lexical storage calls in TS classes, typed functions and TSX without executing source', async (t) => {
  const root = await fixture(t, {
    'store.ts': [
      'throw new Error("SCANNER_MUST_NOT_EXECUTE");',
      'class Store {',
      '  async persist<T>(record: T) {',
      '    const old = await this.db.select().from(table);',
      '    await this.db.insert(table).values(record);',
      '    await this.db.update(table).set(record);',
      '    await this.db.delete(table);',
      '    await this.db.execute("SQL_BODY_SENTINEL");',
      '    await this.appendMemoryRevision(record);',
      '    this.completeDeletion();',
      '  }',
      '}',
      'async function query(id: string) { return store.getById(id); }',
      'const embed = async (docs: string[]) => vector.addDocuments(docs);',
    ].join('\n'),
    'view.tsx': 'export const View = () => <button onClick={() => vector.addVectors([])}>Save</button>;',
  });
  const report = await discoverCandidates({ root, files: ['view.tsx', 'store.ts'] });
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.candidates.map((entry) => [entry.method, entry.kind]), [
    ['select', 'read'], ['insert', 'write'], ['update', 'write'], ['set', 'write'], ['delete', 'delete'],
    ['execute', 'write'], ['appendMemoryRevision', 'write'], ['completeDeletion', 'complete'],
    ['getById', 'read'], ['addDocuments', 'write'], ['addVectors', 'write'],
  ]);
  for (const candidate of report.candidates.slice(0, 8)) {
    assert.equal(candidate.className, 'Store');
    assert.equal(candidate.enclosingMethod, 'persist');
  }
  assert.equal(report.candidates[8].enclosingMethod, 'query');
  assert.equal(report.candidates[8].className, null);
  assert.equal(report.candidates[9].enclosingMethod, 'embed');
  assert.equal(report.candidates[10].enclosingMethod, 'View');
  assert.equal(report.candidates.find((entry) => entry.method === 'execute').classification, 'write-candidate');
  assert.ok(!JSON.stringify(report).includes('SQL_BODY_SENTINEL'));
  assert.ok(report.limitations.some((line) => line.includes('not confirmed')));
});

test('omits declarations, comments, strings and computed calls while exposing lexical false positives', async (t) => {
  const root = await fixture(t, {
    'boundaries.js': [
      '// store.delete("COMMENT_SECRET")',
      'const text = "store.insert(STRING_SECRET)";',
      'function insert(value) { return value; }',
      'const declaration = { delete() {}, unrelated() {} };',
      'store["delete"](1); store[method](2);',
      'vector.similaritySearch("PROMPT_SECRET");',
      'cache.get("not necessarily persistent storage");',
      'unrelated.upsert(3);',
      'store.getByIdentifier(4);',
    ].join('\n'),
  });
  const report = await discoverCandidates({ root, files: ['boundaries.js'] });
  assert.deepEqual(report.candidates.map(({ method }) => method), ['similaritySearch', 'get', 'upsert']);
  assert.ok(report.candidates.every(({ basis }) => basis === 'lexical-method-name'));
  for (const secret of ['COMMENT_SECRET', 'STRING_SECRET', 'PROMPT_SECRET', 'not necessarily persistent storage']) {
    assert.ok(!JSON.stringify(report).includes(secret));
  }
});

test('covers optional calls, TS non-null calls, batch writers and completion methods', async (t) => {
  const root = await fixture(t, {
    'optional.ts': 'async function work() { store?.get?.(1); store.upsert!(1); store.insertBatch([]); store.createMemoryEvidence(1); store.recordMemoryEvent(1); store.verifyMemoryDeletion(1); }',
  });
  const { candidates } = await discoverCandidates({ root, files: ['optional.ts'] });
  assert.deepEqual(candidates.map(({ method }) => method), [
    'get', 'upsert', 'insertBatch', 'createMemoryEvidence', 'recordMemoryEvent', 'verifyMemoryDeletion',
  ]);
  assert.ok(candidates.every(({ enclosingMethod }) => enclosingMethod === 'work'));
});

test('general storage verb rules cover noun suffixes while retaining explicit lexical false positives', async (t) => {
  const root = await fixture(t, {
    'verbs.js': [
      'index.addIndexStruct(1); vector.addNodesToVectorStores([]); storage.insertNodes([]);',
      'storage.putDocument(1); storage.appendRevision(1); storage.updateNode(1); storage.setDocument(1);',
      'storage.deleteRefDoc(1); storage.removeNodes([]);',
      'map.set(1, 2); set.add(1); setTimeout(() => {}, 0);',
      'address(1); setup(1); updated(1); deleted(1); removeall(1);',
    ].join('\n'),
  });
  const report = await discoverCandidates({ root, files: ['verbs.js'] });
  assert.deepEqual(report.candidates.map(({ method, kind }) => [method, kind]), [
    ['addIndexStruct', 'write'], ['addNodesToVectorStores', 'write'], ['insertNodes', 'write'],
    ['putDocument', 'write'], ['appendRevision', 'write'], ['updateNode', 'write'], ['setDocument', 'write'],
    ['deleteRefDoc', 'delete'], ['removeNodes', 'delete'],
    ['set', 'write'], ['add', 'write'], ['setTimeout', 'write'],
  ]);
  assert.ok(report.limitations.some((line) => line.includes('Map.set') && line.includes('false positives')));
});

test('reports named nested function scopes and lexical ownership through anonymous callbacks', async (t) => {
  const root = await fixture(t, {
    'scopes.js': [
      'const Store = class {',
      '  persist = () => { const retry = () => db.insert({}); retry(); };',
      '  read() { return (() => db.get(1))(); }',
      '};',
      'const api = { clean() { db.delete(1); } };',
      'db.select();',
    ].join('\n'),
  });
  const { candidates } = await discoverCandidates({ root, files: ['scopes.js'] });
  assert.deepEqual(candidates.map(({ method, enclosingMethod, className }) => [method, enclosingMethod, className]), [
    ['insert', 'retry', 'Store'], ['get', 'read', 'Store'], ['delete', 'clean', null], ['select', null, null],
  ]);
});

test('transaction callbacks and anonymous IIFEs preserve named lexical methods without inventing a call graph', async (t) => {
  const root = await fixture(t, {
    'transactions.ts': [
      'class Repository {',
      '  async persist() {',
      '    await db.transaction(async (tx) => {',
      '      await (async () => { await tx.insert({}); })();',
      '      const retry = async () => { await (() => tx.update({}))(); };',
      '      await retry();',
      '    });',
      '  }',
      '}',
      '(async () => { await (() => db.delete(1))(); })();',
    ].join('\n'),
  });
  const report = await discoverCandidates({ root, files: ['transactions.ts'] });
  assert.deepEqual(report.candidates.map(({ method, enclosingMethod, className }) => [method, enclosingMethod, className]), [
    ['insert', 'persist', 'Repository'], ['update', 'retry', 'Repository'], ['delete', '<anonymous>', null],
  ]);
  assert.ok(report.limitations.some(line => line.includes('lexical ownership') && line.includes('not a call graph')));
});

test('locations are one-based UTF-16 columns and hashes bind exact UTF-8 source bytes', async (t) => {
  const source = 'const title = "记忆 🧠"; store.delete(1);\r\nstore.getById(2);\r\n';
  const root = await fixture(t, { 'utf8.ts': source });
  const report = await discoverCandidates({ root, files: ['utf8.ts'] });
  assert.equal(report.candidates[0].line, 1);
  assert.equal(report.candidates[0].column, source.indexOf('delete') + 1);
  assert.notEqual(report.candidates[0].column, Buffer.byteLength(source.slice(0, source.indexOf('delete'))) + 1);
  assert.equal(report.candidates[1].line, 2);
  assert.equal(report.candidates[1].column, 7);
  const expectedHash = createHash('sha256').update(Buffer.from(source)).digest('hex');
  assert.equal(report.files[0].sha256, expectedHash);
  assert.ok(report.candidates.every(({ sourceSha256 }) => sourceSha256 === expectedHash));
});

test('preserves a UTF-8 BOM in source location accounting', async (t) => {
  const root = await fixture(t, { 'bom.js': '\uFEFFdb.delete(1);' });
  const { candidates } = await discoverCandidates({ root, files: ['bom.js'] });
  assert.equal(candidates[0].line, 1);
  assert.equal(candidates[0].column, 5);
});

test('deduplicates file arguments and returns deterministic file, location and identifier order', async (t) => {
  const root = await fixture(t, { 'a.js': 'db.insert(1); db.insert(2);', 'z.js': 'db.delete(1);' });
  const first = await discoverCandidates({ root, files: ['z.js', './a.js', 'a.js'] });
  const second = await discoverCandidates({ root, files: ['a.js', 'z.js'] });
  assert.deepEqual(first, second);
  assert.deepEqual(first.files.map(({ path: file }) => file), ['a.js', 'z.js']);
  assert.equal(new Set(first.candidates.map(({ id }) => id)).size, 3);
  await writeFile(path.join(root, 'a.js'), '// revision\ndb.insert(1); db.insert(2);');
  const changed = await discoverCandidates({ root, files: ['a.js', 'z.js'] });
  assert.notEqual(first.candidates[0].id, changed.candidates[0].id);
  assert.equal(first.candidates[2].id, changed.candidates[2].id);
});

test('does not recursively scan imports or adjacent files', async (t) => {
  const root = await fixture(t, { 'entry.js': 'import "./other.js"; db.select();', 'other.js': 'db.delete(1);' });
  const report = await discoverCandidates({ root, files: ['entry.js'] });
  assert.deepEqual(report.files.map(({ path: file }) => file), ['entry.js']);
  assert.deepEqual(report.candidates.map(({ method }) => method), ['select']);
});

test('rejects traversal, absolute paths, unsupported files and external symlinks', async (t) => {
  const root = await fixture(t, { 'ok.js': 'db.get(1);' });
  const outside = await fixture(t, { 'external.js': 'db.delete(1);' });
  await symlink(path.join(outside, 'external.js'), path.join(root, 'escaped.js'));
  await symlink(outside, path.join(root, 'external-directory'));
  for (const file of ['../external.js', 'nested/../ok.js', path.join(root, 'ok.js'), 'C:\\external.js', 'node_modules/pkg/file.js']) {
    await assert.rejects(discoverCandidates({ root, files: [file] }), { code: 'INVALID_PATH' });
  }
  for (const file of ['escaped.js', 'external-directory/external.js']) {
    await assert.rejects(discoverCandidates({ root, files: [file] }), { code: 'INVALID_PATH' });
  }
  await assert.rejects(discoverCandidates({ root, files: ['data.json'] }), { code: 'UNSUPPORTED_FILE' });
});

test('dependency scanning requires explicit boolean opt-in and never follows adjacent imports', async (t) => {
  const dependency = 'node_modules/.pnpm/example@1.0.0/node_modules/example/index.js';
  const root = await fixture(t, {
    [dependency]: 'import "./other.js"; storage.insertNodes([]);',
    'node_modules/.pnpm/example@1.0.0/node_modules/example/other.js': 'storage.deleteRefDoc(1);',
  });
  await symlink(path.join(root, dependency), path.join(root, 'dependency-alias.js'));
  for (const file of [dependency, 'dependency-alias.js']) {
    await assert.rejects(discoverCandidates({ root, files: [file] }), { code: 'INVALID_PATH' });
  }
  await assert.rejects(discoverCandidates({ root, files: [dependency], allowDependencies: 'true' }), { code: 'INVALID_ARGUMENT' });
  const report = await discoverCandidates({ root, files: [dependency], allowDependencies: true });
  assert.deepEqual(report.files.map(({ path: file }) => file), [dependency]);
  assert.deepEqual(report.candidates.map(({ method }) => method), ['insertNodes']);
  assert.equal(report.files[0].sha256, createHash('sha256').update(await readFile(path.join(root, dependency))).digest('hex'));
});

test('CLI dependency opt-in permits explicit installed files but preserves root and symlink boundaries', async (t) => {
  const dependency = 'node_modules/example/index.js';
  const root = await fixture(t, { [dependency]: 'vector.addNodes([]);' });
  const outside = await fixture(t, { 'external.js': 'storage.deleteRefDoc(1);' });
  await symlink(path.join(outside, 'external.js'), path.join(root, 'node_modules/example/escaped.js'));
  const output = path.join(root, 'dependency-report.json');
  const args = [cli, `--root=${root}`, `--file=${dependency}`, `--out=${output}`];
  await assert.rejects(execFileAsync(process.execPath, args), (error) => error.stderr.startsWith('INVALID_PATH:'));
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await execFileAsync(process.execPath, [...args, '--allow-dependencies']);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).candidates[0].method, 'addNodes');
  for (const file of ['node_modules/example/escaped.js', '../external.js', path.join(outside, 'external.js')]) {
    await assert.rejects(discoverCandidates({ root, files: [file], allowDependencies: true }), { code: 'INVALID_PATH' });
  }
});

test('bad syntax and invalid UTF-8 reject the entire report without exposing source fragments', async (t) => {
  const root = await fixture(t, { 'ok.js': 'db.get(1);', 'broken.ts': 'const privatePayload = "DO_NOT_EXPOSE"; function broken( {' });
  await assert.rejects(discoverCandidates({ root, files: ['ok.js', 'broken.ts'] }), (error) => {
    assert.equal(error.code, 'PARSE_ERROR');
    assert.match(error.message, /^Cannot parse source: broken\.ts:\d+:\d+$/);
    assert.ok(!error.message.includes('DO_NOT_EXPOSE'));
    return true;
  });
  await writeFile(path.join(root, 'invalid.js'), Buffer.from([0xff]));
  await assert.rejects(discoverCandidates({ root, files: ['invalid.js'] }), { code: 'INVALID_ENCODING' });
});

test('CLI writes a new report, refuses overwrite and leaves no partial output after parse failure', async (t) => {
  const root = await fixture(t, { 'ok.js': 'db.get(1);', 'broken.js': 'const value = ;' });
  const output = path.join(root, 'report.json');
  const args = [cli, `--root=${root}`, '--file=ok.js', `--out=${output}`];
  const first = await execFileAsync(process.execPath, args);
  assert.equal(JSON.parse(first.stdout).candidates, 1);
  const original = await readFile(output, 'utf8');
  assert.equal(JSON.parse(original).candidates[0].method, 'get');
  await assert.rejects(execFileAsync(process.execPath, args), (error) => error.stderr.startsWith('EEXIST:'));
  assert.equal(await readFile(output, 'utf8'), original);
  const invalidOutput = path.join(root, 'invalid-report.json');
  await assert.rejects(execFileAsync(process.execPath, [cli, `--root=${root}`, '--file=broken.js', `--out=${invalidOutput}`]), (error) => error.stderr.startsWith('PARSE_ERROR:'));
  await assert.rejects(readFile(invalidOutput), { code: 'ENOENT' });
});
