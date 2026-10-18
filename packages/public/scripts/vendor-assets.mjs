import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = fileURLToPath(new URL('../aervox-intro/', import.meta.url));
const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(directory, 'vendor-manifest.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyVendorAssets(root = directory) {
  for (const artifact of manifest.artifacts) {
    for (const [file, hash] of [[artifact.artifact, artifact.sha256], [artifact.license, artifact.licenseSha256]]) {
      if (digest(readFileSync(path.join(root, file))) !== hash) throw new Error(`Vendor checksum mismatch: ${file}`);
    }
  }
  return manifest.artifacts.length;
}

/** Restore exact published bytes from the frozen Git input; never regenerate dynamic CDN output. */
export function restoreVendorAssets(out) {
  verifyVendorAssets();
  const files = manifest.artifacts.flatMap(artifact => {
    // HEAD contains the frozen vendored bytes even in a depth-one CI checkout.
    // The manifest hash binds them to the recorded historical sourceCommit.
    const bytes = execFileSync('git', ['show', `HEAD:${artifact.sourcePath}`], { cwd: checkout, maxBuffer: 2_000_000 });
    if (digest(bytes) !== artifact.sha256) throw new Error(`Frozen artifact checksum mismatch: ${artifact.artifact}`);
    return [[artifact.artifact, bytes], [artifact.license, readFileSync(path.join(directory, artifact.license))]];
  });
  // A new output directory is required; consumers and existing bundles cannot be overwritten.
  mkdirSync(out);
  for (const [file, bytes] of files) {
    const target = path.join(out, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx' });
  }
  verifyVendorAssets(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--verify')) console.log(`Vendor checksums verified: ${verifyVendorAssets()} artifacts and licenses`);
  else if (args.length === 2 && args[0] === '--restore') restoreVendorAssets(path.resolve(args[1]));
  else throw new Error('Usage: vendor-assets.mjs [--verify | --restore NEW_DIRECTORY]');
}
