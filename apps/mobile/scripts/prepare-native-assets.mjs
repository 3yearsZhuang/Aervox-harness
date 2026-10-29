import { createHash } from 'node:crypto';
import { readFile, rm, cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const coreArtifact = {
  url: 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
  sha256: '25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f',
  bytes: 207155,
};
export async function prepareNativeAssets(root = fileURLToPath(new URL('../', import.meta.url))) {
  const core = await readFile(path.join(root, 'android/vendor/live2dcubismcore.min.js'));
  if (core.length !== coreArtifact.bytes || createHash('sha256').update(core).digest('hex') !== coreArtifact.sha256) {
    throw new Error('Pinned Cubism Core missing or invalid; restore the documented development artifact first.');
  }
  const source = path.resolve(root, '../web/dist');
  let html = await readFile(path.join(source, 'index.html'), 'utf8');
  if (!html.includes('/m0/assets/')) throw new Error('Native assets require build:web:native base /m0/.');
  html = html.replace(/<script src="https:\/\/cubism\.live2d\.com[^\"]+"><\/script>/, '<script src="/m0/vendor/live2dcubismcore.min.js"></script>')
    .replace(/\s*<script src="https:\/\/cdn\.jsdelivr\.net[^\"]+"><\/script>/, '');
  if (/<script[^>]+src="https?:/.test(html)) throw new Error('Remote native script rejected.');
  const target = path.join(root, 'android/app/src/main/assets/m0');
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  await mkdir(path.join(target, 'vendor'), { recursive: true });
  await writeFile(path.join(target, 'index.html'), html);
  await writeFile(path.join(target, 'vendor/live2dcubismcore.min.js'), core);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareNativeAssets();
}
