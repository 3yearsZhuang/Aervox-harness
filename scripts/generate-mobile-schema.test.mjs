import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateMobileSchema } from './generate-mobile-schema.mjs';

const relativeAsset = 'apps/mobile/android/app/src/main/assets/aervox-schema-main.json';
const fixture = () => ({ formatVersion: 1, scope: 'main', schemaVersion: 1, fingerprint: 'f'.repeat(64),
  initialization: { requiredDatabaseState: 'empty', statements: ['CREATE TABLE "测试" (id TEXT PRIMARY KEY, body TEXT DEFAULT \'含\\0字符\')'],
    journal: { sql: 'INSERT INTO journal VALUES(:scope, :version, :fingerprint, :applied_at)',
      parameters: { scope: 'main', version: '1', fingerprint: 'f'.repeat(64) }, requiredRuntimeParameters: ['applied_at'] } },
  projections: { rebuildable: true, statements: [] } });

async function temporary(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'aervox-schema-generator-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('writes the exact JSON DTO once at the fixed path and returns its actual UTF-8 digest', async t => {
  const root = await temporary(t), artifact = fixture();
  const requested = [];
  const options = { repositoryRoot: root, loadArtifact: scope => { requested.push(scope); return artifact; } };
  const first = await generateMobileSchema(options);
  const bytes = await fs.readFile(join(root, relativeAsset));
  assert.deepEqual(JSON.parse(bytes), artifact);
  assert.equal(bytes.toString(), JSON.stringify(artifact, null, 2) + '\n');
  assert.equal(first.path, join(await fs.realpath(root), relativeAsset));
  assert.equal(first.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(first.bytes, bytes.length); assert.equal(first.changed, true);
  const before = await fs.stat(first.path);
  const second = await generateMobileSchema(options);
  assert.deepEqual(second, { ...first, changed: false });
  assert.equal((await fs.stat(first.path)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readdir(dirname(first.path)), ['aervox-schema-main.json']);
  assert.deepEqual(requested, ['main', 'main']);
});

test('replaces an ordinary prior asset atomically without preserving stale content', async t => {
  const root = await temporary(t), path = join(root, relativeAsset);
  await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'old artifact');
  const result = await generateMobileSchema({ repositoryRoot: root, loadArtifact: fixture });
  assert.equal(result.changed, true); assert.deepEqual(JSON.parse(await fs.readFile(path)), fixture());
  assert.deepEqual(await fs.readdir(dirname(path)), ['aervox-schema-main.json']);
});

test('a missing build fails clearly before creating mobile directories and never compiles implicitly', async t => {
  const root = await temporary(t);
  await assert.rejects(generateMobileSchema({ repositoryRoot: root }), /Portable schema build is missing/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('the artifact loader is lazy and invalid scope or failed loading leaves no files', async t => {
  const root = await temporary(t);
  await assert.rejects(generateMobileSchema({ repositoryRoot: root, loadArtifact: () => { throw new Error('builder failed'); } }), /builder failed/);
  await assert.rejects(generateMobileSchema({ repositoryRoot: root, loadArtifact: () => ({ ...fixture(), scope: 'ledger' }) }), /incompatible main artifact/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('rejects a symlink target without following or replacing it and without partial output', async t => {
  const root = await temporary(t), path = join(root, relativeAsset), outside = join(root, 'outside.json');
  await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(outside, 'keep outside');
  await fs.symlink(outside, path);
  await assert.rejects(generateMobileSchema({ repositoryRoot: root, loadArtifact: fixture }), /non-regular generated schema target/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep outside');
  assert.equal((await fs.lstat(path)).isSymbolicLink(), true);
  assert.deepEqual(await fs.readdir(dirname(path)), ['aervox-schema-main.json']);
});

test('rejects symlink ancestors and non-regular targets before writing into them', async t => {
  const root = await temporary(t), outside = join(root, 'outside');
  await fs.mkdir(outside); await fs.symlink(outside, join(root, 'apps'), 'dir');
  await assert.rejects(generateMobileSchema({ repositoryRoot: root, loadArtifact: fixture }), /symlink in generated schema path/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(join(root, 'apps'));
  const path = join(root, relativeAsset); await fs.mkdir(path, { recursive: true });
  await assert.rejects(generateMobileSchema({ repositoryRoot: root, loadArtifact: fixture }), /non-regular generated schema target/);
  assert.deepEqual(await fs.readdir(path), []);
});

test('a failed atomic publication preserves the previous asset and removes staging bytes', async t => {
  const root = await temporary(t), path = join(root, relativeAsset);
  await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'previous asset');
  t.mock.method(fs, 'rename', async () => { throw new Error('publish failed'); });
  await assert.rejects(generateMobileSchema({ repositoryRoot: root, loadArtifact: fixture }), /publish failed/);
  assert.equal(await fs.readFile(path, 'utf8'), 'previous asset');
  assert.deepEqual(await fs.readdir(dirname(path)), ['aervox-schema-main.json']);
});

test('preserves a different result written after the initial path snapshot', async t => {
  const root = await temporary(t), path = join(root, relativeAsset);
  await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'previous asset');
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (target, ...args) => {
    if (String(target).endsWith('.tmp')) await fs.writeFile(path, 'another writer');
    return open(target, ...args);
  });
  await assert.rejects(generateMobileSchema({ repositoryRoot: root, loadArtifact: fixture }), /target changed/);
  assert.equal(await fs.readFile(path, 'utf8'), 'another writer');
  assert.deepEqual(await fs.readdir(dirname(path)), ['aervox-schema-main.json']);
});
