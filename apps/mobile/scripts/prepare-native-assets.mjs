import { createHash } from 'node:crypto';
import { readFile, rename, rm, cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const coreArtifact = {
  url: 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
  sha256: '25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f',
  bytes: 207155,
};

/** The pinned bytes are the only acceptable Cubism Core: no "close enough" file. */
function verifyCore(core) {
  if (core.length !== coreArtifact.bytes || createHash('sha256').update(core).digest('hex') !== coreArtifact.sha256) {
    throw new Error('Pinned Cubism Core missing or invalid; restore the documented development artifact first.');
  }
  return core;
}

/**
 * Explicit restoration for cold checkouts (CI and new machines). A present but
 * invalid file is evidence of a bad download and is left untouched.
 */
export async function restoreCoreArtifact(root = fileURLToPath(new URL('../', import.meta.url)), fetcher = fetch) {
  const directory = path.join(root, 'android/vendor');
  const file = path.join(directory, 'live2dcubismcore.min.js');
  try { return verifyCore(await readFile(file)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetcher(coreArtifact.url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error('Cubism Core download failed.');
  }
  const core = verifyCore(Buffer.from(await response.arrayBuffer()));
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.live2dcubismcore.${process.pid}.partial`);
  await writeFile(temporary, core);
  await rename(temporary, file);
  return core;
}

export async function prepareNativeAssets(root = fileURLToPath(new URL('../', import.meta.url)), {
  source = path.resolve(root, '../web/dist'), target = path.join(root, 'android/app/src/main/assets/m0'),
} = {}) {
  const core = verifyCore(await readFile(path.join(root, 'android/vendor/live2dcubismcore.min.js')));
  let html = await readFile(path.join(source, 'index.html'), 'utf8');
  if (!html.includes('/m0/assets/')) throw new Error('Native assets require build:web:native base /m0/.');
  html = html.replace(/<script src="https:\/\/cubism\.live2d\.com[^\"]+"><\/script>/, '<script src="/m0/vendor/live2dcubismcore.min.js"></script>')
    .replace(/\s*<script src="https:\/\/cdn\.jsdelivr\.net[^\"]+"><\/script>/, '');
  if (/<script[^>]+src="https?:/.test(html)) throw new Error('Remote native script rejected.');
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  await mkdir(path.join(target, 'vendor'), { recursive: true });
  await writeFile(path.join(target, 'index.html'), html);
  await writeFile(path.join(target, 'vendor/live2dcubismcore.min.js'), core);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--restore')) await restoreCoreArtifact();
  else if (process.argv.includes('--termination-probe')) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    await prepareNativeAssets(root, { source: path.join(root, 'dist/process-termination'),
      target: path.join(root, 'android/app/src/deterministicProbe/assets/m0') });
  } else await prepareNativeAssets();
}
