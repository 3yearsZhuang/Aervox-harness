import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { verifyVendorAssets, restoreVendorAssets } from './vendor-assets.mjs';

test('vendored bytes and complete notices match their manifest; tampering fails offline', () => {
  assert.equal(verifyVendorAssets(), 2);
  const directory = mkdtempSync(path.join(tmpdir(), 'aervox-vendor-'));
  try {
    cpSync(new URL('../aervox-intro', import.meta.url), directory, { recursive: true });
    assert.equal(verifyVendorAssets(directory), 2);
    writeFileSync(path.join(directory, 'assets/motion.min.js'), 'changed');
    assert.throws(() => verifyVendorAssets(directory), /checksum mismatch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('frozen acquisition reconstructs a new directory and refuses overwrite', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'aervox-vendor-restore-'));
  try {
    const out = path.join(directory, 'new-bundle');
    restoreVendorAssets(out);
    assert.equal(verifyVendorAssets(out), 2);
    assert.throws(() => restoreVendorAssets(out), /EEXIST/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
