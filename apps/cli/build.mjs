import { build } from 'esbuild';
import { chmod, copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts'], outfile: 'dist/index.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  banner: { js: '#!/usr/bin/env node' },
});
await chmod('dist/index.js', 0o755);
await copyFile('../../LICENSE', 'dist/LICENSE');
