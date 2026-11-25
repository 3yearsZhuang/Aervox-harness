import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreArtifact, prepareNativeAssets } from '../scripts/prepare-native-assets.mjs';

const mobileRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

async function fixture(t, html) {
  const root = await mkdtemp(path.join(tmpdir(), 'aervox-m0-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'dist');
  const target = path.join(root, 'm0');
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await writeFile(path.join(source, 'index.html'), html);
  await writeFile(path.join(source, 'assets/app.js'), 'export {};');
  return { root, source, target };
}

const page = script => `<!doctype html><html><head>${script}</head>` +
  '<body><div id="app"></div><script type="module" src="/m0/assets/app.js"></script></body></html>';

test('copies the packaged Cubism Core and keeps the local script reference', async t => {
  const { source, target } = await fixture(t, page('<script src="./vendor/live2dcubismcore.min.js"></script>'));
  await prepareNativeAssets(mobileRoot, { source, target });
  const html = await readFile(path.join(target, 'index.html'), 'utf8');
  assert.match(html, /vendor\/live2dcubismcore\.min\.js/);
  const copied = await readFile(path.join(target, 'vendor', 'live2dcubismcore.min.js'));
  assert.equal(createHash('sha256').update(copied).digest('hex'), coreArtifact.sha256);
});

test('rejects a remote script instead of rewriting it', async t => {
  const { source, target } = await fixture(t, page(
    '<script src="https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"></script>'));
  await assert.rejects(
    () => prepareNativeAssets(mobileRoot, { source, target }),
    /Remote native script rejected/,
  );
});

test('rejects a build that never referenced the packaged Core', async t => {
  // A build whose Live2D script silently disappeared would otherwise ship an APK that
  // fails at first model load; the pipeline must fail loudly instead.
  const { source, target } = await fixture(t, page(''));
  await assert.rejects(
    () => prepareNativeAssets(mobileRoot, { source, target }),
    /must reference the packaged Cubism Core/,
  );
});

test('rejects a build without the native /m0/ base', async t => {
  const { source, target } = await fixture(t,
    '<html><head><script src="./vendor/live2dcubismcore.min.js"></script></head><body></body></html>');
  await assert.rejects(
    () => prepareNativeAssets(mobileRoot, { source, target }),
    /require build:web:native base \/m0\//,
  );
});
