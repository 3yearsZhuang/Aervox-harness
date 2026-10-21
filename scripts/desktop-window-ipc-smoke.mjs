#!/usr/bin/env node
/** Real Electron IPC acceptance; native mode opens two folder pickers and a browser tab. */
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const options = { native: false, timeoutMs: undefined, directory: undefined, externalUrl: undefined };
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--help') {
    console.log('Usage: mise exec -- pnpm test:desktop:ipc [--native-interactive --expected-directory PATH] [--external-url HTTPS_URL] [--timeout-ms N]');
    console.log('Default: real Electron windows and renderer IPC, isolated from Aervox user data.');
    console.log('Native mode: select PATH in the first system folder picker, cancel the second; then the default browser opens HTTPS_URL.');
    console.log('JSON markers identify each native step. Browser dispatch is recorded separately from observing the opened browser tab.');
    process.exit(0);
  }
  if (argument === '--native-interactive') { options.native = true; continue; }
  const key = { '--expected-directory': 'directory', '--external-url': 'externalUrl', '--timeout-ms': 'timeoutMs' }[argument];
  if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid argument: ${argument}`);
  options[key] = args[++index];
}
if (options.native && !options.directory) throw new Error('--native-interactive requires --expected-directory PATH');
if (!options.native && (options.directory || options.externalUrl)) throw new Error('Native options require --native-interactive');
const timeoutMs = Number(options.timeoutMs ?? (options.native ? 180_000 : 60_000));
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('--timeout-ms must be an integer >= 1000');
if (options.directory) {
  options.directory = await realpath(options.directory);
  if (!(await stat(options.directory)).isDirectory()) throw new Error('Expected path must be a directory');
}
if (process.platform === 'darwin') {
  const session = execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8' });
  if (/"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(session)) {
    throw new Error('macOS screen is locked. Unlock this Mac before running real window and native dialog acceptance.');
  }
}
const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'aervox-window-ipc-smoke-'));
const externalUrl = options.externalUrl ?? `https://example.com/?aervox-ipc-smoke=${path.basename(evidenceDir)}`;
if (new URL(externalUrl).protocol !== 'https:') throw new Error('--external-url must use HTTPS');
console.log(JSON.stringify({ type: 'evidence', directory: evidenceDir, mode: options.native ? 'native-interactive' : 'electron' }));
await mkdir(path.join(evidenceDir, 'profile'));
const compiled = path.join(evidenceDir, 'window-ipc.cjs');
const preload = path.join(evidenceDir, 'preload.cjs');
const source = path.join(root, 'apps/desktop/src/main/window-ipc.ts');
const sourceSha256 = createHash('sha256').update(await readFile(source)).digest('hex');
await build({ entryPoints: [source], outfile: compiled,
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
await writeFile(preload, "const { contextBridge, ipcRenderer } = require('electron');\ncontextBridge.exposeInMainWorld('ipcSmoke', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });\n");
const requireDesktop = createRequire(path.join(root, 'apps/desktop/package.json'));
const executable = requireDesktop('electron');
const env = { ...process.env, AERVOX_IPC_SMOKE_HOME: evidenceDir, AERVOX_IPC_SMOKE_MODULE: compiled,
  AERVOX_IPC_SMOKE_PRELOAD: preload, AERVOX_IPC_SMOKE_NATIVE: options.native ? '1' : '0',
  AERVOX_IPC_SMOKE_DIRECTORY: options.directory ?? '', AERVOX_IPC_SMOKE_EXTERNAL_URL: externalUrl };
delete env.ELECTRON_RUN_AS_NODE;
const fixture = path.join(root, 'scripts/fixtures/desktop-window-ipc-smoke.cjs');
const child = spawn(executable, [`--user-data-dir=${path.join(evidenceDir, 'profile')}`, fixture], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const stdout = createWriteStream(path.join(evidenceDir, 'stdout.jsonl'));
const stderr = createWriteStream(path.join(evidenceDir, 'stderr.log'));
let pending = '', result, timedOut = false, forceTimer, interrupted, outputError;
const terminate = () => {
  child.kill('SIGTERM');
  forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 3_000);
};
const onInterrupt = () => { interrupted = 'SIGINT'; terminate(); };
const onTerminate = () => { interrupted = 'SIGTERM'; terminate(); };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
for (const output of [stdout, stderr]) output.on('error', error => { outputError = String(error); terminate(); });
child.stdout.on('data', chunk => {
  stdout.write(chunk);
  process.stdout.write(chunk);
  pending += chunk.toString();
  let boundary;
  while ((boundary = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
    try { const event = JSON.parse(line); if (event.type === 'result') result = event; } catch { /* Electron may emit diagnostic text. */ }
  }
});
child.stderr.on('data', chunk => { stderr.write(chunk); process.stderr.write(chunk); });
const timer = setTimeout(() => {
  timedOut = true;
  terminate();
}, timeoutMs);
let exitCode, signal, launchError;
try {
  [exitCode, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, reason) => resolve([code, reason]));
  });
} catch (error) { launchError = String(error); }
finally {
  clearTimeout(timer); clearTimeout(forceTimer);
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
  stdout.end(); stderr.end();
  await Promise.all([finished(stdout), finished(stderr)]).catch(error => { outputError = String(error); });
}
const sourceUnchanged = sourceSha256 === createHash('sha256').update(await readFile(source)).digest('hex');
const passed = !timedOut && !interrupted && !outputError && !launchError && sourceUnchanged && exitCode === 0 && result?.passed === true;
const report = { passed, exitCode, signal, timedOut, interrupted, outputError, launchError, mode: options.native ? 'native-interactive' : 'electron',
  platform: process.platform, arch: process.arch, node: process.version, electron: requireDesktop('electron/package.json').version,
  source, sourceSha256, sourceUnchanged, expectedDirectory: options.directory, externalUrl: options.native ? externalUrl : undefined,
  result, scope: 'Actual IPC module in an isolated Electron fixture; browser dispatch does not prove the browser loaded the URL.' };
await writeFile(path.join(evidenceDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ type: 'summary', passed, evidenceDir }));
if (!passed) process.exitCode = 1;
