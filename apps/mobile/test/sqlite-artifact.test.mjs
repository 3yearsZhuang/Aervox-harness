import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { restoreSqliteArtifact, verifySqliteArtifact } from '../scripts/sqlite-artifact.mjs';
import { buildAndroid } from '../scripts/build-android.mjs';
const bytes = Buffer.from('a verified fixture artifact');
const artifact = { version: 'fixture', file: 'fixture.aar', bytes: bytes.length,
  url: 'https://sqlite.org/fixture.aar', sha3: createHash('sha3-256').update(bytes).digest('hex') };
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'aervox-sqlite-artifact-'));
  try { await mkdir(path.join(root, 'android')); await run(root, path.join(root, 'android/vendor', artifact.file)); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test('explicit restoration publishes complete verified bytes, then reuses the local artifact without fetching', async () => fixture(async (root, file) => {
  let calls = 0;
  const fetcher = async (url, options) => { calls++; assert.equal(url, artifact.url); assert.equal(options.redirect, 'error'); assert.ok(options.signal); return new Response(bytes); };
  assert.equal(await restoreSqliteArtifact({ root, artifact, fetcher }), file);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(verifySqliteArtifact({ root, artifact }), file);
  await restoreSqliteArtifact({ root, artifact, fetcher }); assert.equal(calls, 1);
  assert.deepEqual(await readdir(path.dirname(file)), [artifact.file]);
}));
test('missing artifacts fail locally without generating assets or starting Gradle', async () => fixture(async root => {
  const calls = [];
  assert.throws(() => verifySqliteArtifact({ root, artifact }), /missing/);
  const original = console.error; console.error = () => {};
  try { assert.equal(buildAndroid({ root, inspect: () => ({ ok: true, checks: [] }), report: () => {}, run: (...args) => calls.push(args) }), 1); }
  finally { console.error = original; }
  assert.deepEqual(calls, []);
}));
test('an invalid existing artifact is preserved and never triggers a replacement download', async () => fixture(async (root, file) => {
  await mkdir(path.dirname(file)); await writeFile(file, 'preserve this evidence');
  let calls = 0;
  await assert.rejects(restoreSqliteArtifact({ root, artifact, fetcher: async () => { calls++; return new Response(bytes); } }), /verification failed/);
  assert.equal(calls, 0); assert.equal(await readFile(file, 'utf8'), 'preserve this evidence');
}));
for (const [name, body, headers] of [
  ['oversized', Buffer.concat([bytes, Buffer.from('extra')]), {}],
  ['truncated', bytes.subarray(0, -1), {}],
  ['wrong digest', Buffer.alloc(bytes.length, 120), {}],
  ['wrong advertised size', bytes, { 'content-length': '1' }],
]) test(`rejects ${name} downloads without publishing or leaving partial files`, async () => fixture(async (root, file) => {
  await assert.rejects(restoreSqliteArtifact({ root, artifact, fetcher: async () => new Response(body, { headers }) }));
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.dirname(file)), []);
}));
test('network body failure cannot publish an incomplete artifact', async () => fixture(async (root, file) => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 1)); controller.error(new Error('fixture disconnection')); } });
  await assert.rejects(restoreSqliteArtifact({ root, artifact, fetcher: async () => new Response(stream) }));
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.dirname(file)), []);
}));
test('simultaneous restorations converge without replacing another file', async () => fixture(async (root, file) => {
  const results = await Promise.all(Array.from({ length: 3 }, () => restoreSqliteArtifact({ root, artifact, fetcher: async () => new Response(bytes) })));
  assert.deepEqual(results, [file, file, file]); assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await readdir(path.dirname(file)), [artifact.file]);
}));
test('a competing unverified writer remains intact and makes restoration fail', async () => fixture(async (root, file) => {
  const fetcher = async () => { await writeFile(file, 'other writer'); return new Response(bytes); };
  await assert.rejects(restoreSqliteArtifact({ root, artifact, fetcher }), /verification failed/);
  assert.equal(await readFile(file, 'utf8'), 'other writer');
  assert.deepEqual(await readdir(path.dirname(file)), [artifact.file]);
}));
test('symlink artifacts and vendor directories are rejected without writing through them', async () => fixture(async (root, file) => {
  const other = path.join(root, 'other'); await mkdir(other);
  await symlink(other, path.dirname(file), 'dir');
  await assert.rejects(restoreSqliteArtifact({ root, artifact, fetcher: async () => new Response(bytes) }), /real directory/);
  assert.deepEqual(await readdir(other), []);
}));

test('an artifact symlink is rejected without replacing its target', async () => fixture(async (root, file) => {
  const target = path.join(root, 'original.aar'); await writeFile(target, bytes);
  await mkdir(path.dirname(file)); await symlink(target, file);
  await assert.rejects(restoreSqliteArtifact({ root, artifact, fetcher: async () => { throw new Error('must not fetch'); } }), /not a regular file/);
  assert.deepEqual(await readFile(target), bytes);
}));
