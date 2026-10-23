#!/usr/bin/env node
/** Actual Electron Turn IPC using production main, preload and renderer transport. */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(desktop, '../..');
const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'aervox-turn-ipc-smoke-'));
const sources = [
  'apps/desktop/src/main/turn-bridge.ts', 'apps/desktop/src/main/renderer-boundary.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/preload/domains/aervox-api.ts',
  'packages/api-client/src/transport.ts', 'packages/api-client/src/desktop-transport.ts', 'packages/api-client/src/projector.ts',
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async source => [source,
  createHash('sha256').update(await readFile(path.join(root, source))).digest('hex')])));
const sourceSha256 = await hashes();
const mainSource = path.join(evidenceDir, 'main.ts');
const rendererSource = path.join(evidenceDir, 'renderer.ts');
const main = path.join(evidenceDir, 'main.cjs');
const preload = path.join(evidenceDir, 'preload.cjs');
await writeFile(mainSource, [
  `export {createDesktopTurnBridge} from ${JSON.stringify(path.join(desktop, 'src/main/turn-bridge.ts'))};`,
  `export {createRendererBoundary} from ${JSON.stringify(path.join(desktop, 'src/main/renderer-boundary.ts'))};`,
  `export {rendererEntryArgument} from ${JSON.stringify(path.join(desktop, 'src/shared/renderer-trust.ts'))};`,
].join('\n'));
await writeFile(rendererSource, `import {desktopTransport} from ${JSON.stringify(path.join(root, 'packages/api-client/src/desktop-transport.ts'))}; window.turnSmoke = desktopTransport;\n`);
const shared = {bundle: true, logLevel: 'silent', alias: {'@aervox/api-client/transport': path.join(root, 'packages/api-client/src/transport.ts')}};
await build({...shared, entryPoints: [mainSource], outfile: main, platform: 'node', format: 'cjs', external: ['electron']});
await build({...shared, entryPoints: [path.join(desktop, 'src/preload/index.ts')], outfile: preload, platform: 'node', format: 'cjs', external: ['electron']});
await build({...shared, entryPoints: [rendererSource], outfile: path.join(evidenceDir, 'renderer.js'), platform: 'browser', format: 'iife'});
await writeFile(path.join(evidenceDir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Aervox Turn IPC acceptance</title><script src="./renderer.js"></script>');
const requireDesktop = createRequire(path.join(desktop, 'package.json'));
const executable = requireDesktop('electron');
const env = {...process.env, AERVOX_TURN_IPC_SMOKE_DIR: evidenceDir};
delete env.ELECTRON_RUN_AS_NODE;
console.log(JSON.stringify({type: 'evidence', evidenceDir}));
const child = spawn(executable, [path.join(desktop, 'test/fixtures/turn-ipc-smoke.cjs')], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
let stdout = '', stderr = '', timedOut = false, launchError;
child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
const terminate = () => child.kill('SIGTERM');
const interrupt = () => { terminate(); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
let forceTimer;
const timer = setTimeout(() => { timedOut = true; terminate(); forceTimer = setTimeout(() => child.kill('SIGKILL'), 3000); }, 60_000);
let exitCode, signal;
try {
  [exitCode, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, reason) => resolve([code, reason]));
  });
} catch (error) { launchError = String(error); }
finally {
  clearTimeout(timer); clearTimeout(forceTimer);
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
let result;
for (const line of stdout.split('\n')) {
  try { const value = JSON.parse(line); if (value.type === 'result') result = value; } catch { /* Electron diagnostics are kept separately. */ }
}
const sourceUnchanged = JSON.stringify(sourceSha256) === JSON.stringify(await hashes());
const passed = exitCode === 0 && !timedOut && !launchError && sourceUnchanged && result?.passed === true;
await writeFile(path.join(evidenceDir, 'stdout.jsonl'), stdout);
await writeFile(path.join(evidenceDir, 'stderr.log'), stderr);
await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify({passed, exitCode, signal, timedOut, launchError, sourceSha256, sourceUnchanged,
  platform: process.platform, arch: process.arch, electron: requireDesktop('electron/package.json').version, result,
  scope: 'Production Turn modules bundled into an isolated Electron fixture with real BrowserWindow/contextBridge/IPC and loopback HTTP; no user database or full application session.'}, null, 2) + '\n');
console.log(JSON.stringify({type: 'summary', passed, evidenceDir}));
if (!passed) process.exitCode = 1;
