import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const assetParts = ['apps', 'mobile', 'android', 'app', 'src', 'main', 'assets'];
const assetName = 'aervox-schema-main.json';

async function entry(path) {
  try { return await fs.lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function checkParents(root, create = false) {
  let current = root;
  for (const part of assetParts) {
    current = join(current, part);
    let info = await entry(current);
    if (!info && create) {
      try { await fs.mkdir(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      info = await entry(current);
    }
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new Error(`Refusing non-directory or symlink in generated schema path: ${current}`);
    }
  }
}

async function readExisting(path) {
  const info = await entry(path);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Refusing non-regular generated schema target: ${path}`);
  }
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Refusing non-regular generated schema target: ${path}`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function loadBuiltArtifact(root) {
  const built = join(root, 'packages', 'repositories', 'dist', 'schema', 'portable-artifact.js');
  const info = await entry(built);
  if (!info?.isFile()) {
    throw new Error('Portable schema build is missing. Run mise exec -- pnpm exec turbo run build --filter=@aervox/repositories before generating mobile assets.');
  }
  // Import only when generation is requested; importing this script or running
  // its filesystem tests never requires an existing workspace dist directory.
  const { buildPortableSchemaArtifact } = await import(pathToFileURL(built).href);
  return buildPortableSchemaArtifact('main');
}

/** Generate one rebuildable main-scope asset, never a database or ledger copy.
 * The returned byte hash is build evidence, not authentication or schema identity.
 * Native consumers still verify the trusted packaged release and empty-DB gate.
 */
export async function generateMobileSchema({ repositoryRoot = defaultRoot, loadArtifact } = {}) {
  const root = await fs.realpath(repositoryRoot);
  const artifact = await (loadArtifact ? loadArtifact('main') : loadBuiltArtifact(root));
  if (!artifact || artifact.formatVersion !== 1 || artifact.scope !== 'main'
    || !Number.isSafeInteger(artifact.schemaVersion) || artifact.schemaVersion < 1
    || typeof artifact.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.fingerprint)) {
    throw new Error('Portable schema builder returned an incompatible main artifact.');
  }
  const bytes = Buffer.from(JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  const target = join(root, ...assetParts, assetName);
  const result = { path: target, scope: 'main', schemaVersion: artifact.schemaVersion,
    fingerprint: artifact.fingerprint, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };

  await checkParents(root);
  const previous = await readExisting(target);
  if (previous?.equals(bytes)) return { ...result, changed: false };
  await checkParents(root, true);
  const temporary = join(dirname(target), `.${assetName}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o644);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }

    // Recheck changes observable before publication. The following rename is
    // atomic, but this preflight is not a filesystem compare-and-swap.
    await checkParents(root);
    const current = await readExisting(target);
    if (current?.equals(bytes)) return { ...result, changed: false };
    if ((previous === null) !== (current === null) || (previous && !previous.equals(current))) {
      throw new Error('Generated schema target changed while preparing the artifact.');
    }
    await fs.rename(temporary, target);
    return { ...result, changed: true };
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error('Usage: node scripts/generate-mobile-schema.mjs');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await generateMobileSchema())); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
