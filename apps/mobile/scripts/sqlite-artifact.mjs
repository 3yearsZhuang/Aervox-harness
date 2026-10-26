import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mobileRoot } from './check-android-environment.mjs';

export const SQLITE_ANDROID = Object.freeze({
  version: '3.54.1', file: 'sqlite-android-3540100.aar', bytes: 3_688_530,
  url: 'https://sqlite.org/2026/sqlite-android-3540100.aar',
  sha3: '3afb0568a107d753b640e4d65cdb1d9a2247e9833c25e72ca7d1086b78365de1',
});
const digest = bytes => createHash('sha3-256').update(bytes).digest('hex');
const artifactPath = (root, artifact) => path.join(root, 'android', 'vendor', artifact.file);
function regular(file) {
  try { return lstatSync(file).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Local check only: building never downloads or replaces an unverified file. */
export function verifySqliteArtifact({ root = mobileRoot, artifact = SQLITE_ANDROID } = {}) {
  const file = artifactPath(root, artifact);
  try {
    const directory = lstatSync(path.dirname(file));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('SQLite vendor directory must be a real directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!regular(file)) throw new Error('SQLite artifact missing or not a regular file; run sqlite:restore explicitly.');
  const stat = lstatSync(file);
  if (stat.size !== artifact.bytes || digest(readFileSync(file)) !== artifact.sha3) {
    throw new Error('SQLite artifact verification failed; preserve/remove the invalid file before restoring.');
  }
  return file;
}

/** Explicit, bounded HTTPS restoration. Publish only complete verified bytes. */
export async function restoreSqliteArtifact({ root = mobileRoot, artifact = SQLITE_ANDROID,
  fetcher = fetch } = {}) {
  const file = artifactPath(root, artifact);
  // An existing unverified file is evidence, not a cache entry to overwrite.
  try { lstatSync(file); return verifySqliteArtifact({ root, artifact }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('SQLite vendor directory must be a real directory.');
  const temporary = path.join(directory, `.${artifact.file}.${randomUUID()}.partial`);
  let handle;
  try {
    const response = await fetcher(artifact.url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error('SQLite artifact download failed.'); }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== artifact.bytes) { await response.body.cancel(); throw new Error('SQLite artifact length is invalid.'); }
    handle = await open(temporary, 'wx', 0o644);
    const reader = response.body.getReader();
    const hash = createHash('sha3-256');
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > artifact.bytes) throw new Error('SQLite artifact exceeds its byte budget.');
        hash.update(value);
        await handle.writeFile(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    if (size !== artifact.bytes || hash.digest('hex') !== artifact.sha3) throw new Error('SQLite artifact verification failed.');
    await handle.sync();
    await handle.close(); handle = undefined;
    // Atomic no-replace publication: even a concurrent writer cannot lose its file.
    try { await link(temporary, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return verifySqliteArtifact({ root, artifact });
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('Usage: node scripts/sqlite-artifact.mjs [--check]'); process.exitCode = 2;
  } else {
    try {
      if (args[0] === '--check') verifySqliteArtifact(); else await restoreSqliteArtifact();
      console.log(`Verified SQLite Android ${SQLITE_ANDROID.version}.`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
