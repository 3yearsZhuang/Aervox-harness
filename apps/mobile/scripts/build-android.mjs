import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifySqliteArtifact } from './sqlite-artifact.mjs';
import { inspectAndroidEnvironment, mobileRoot, printAndroidChecks } from './check-android-environment.mjs';

/** Explicit native build: missing prerequisites fail before asset generation or downloads. */
export function buildAndroid({ inspect = inspectAndroidEnvironment, report = printAndroidChecks,
  run = spawnSync, verifySqlite = verifySqliteArtifact, root = mobileRoot, platform = process.platform, env = process.env,
  terminationProbe = false } = {}) {
  const prerequisites = inspect({ env, root });
  report(prerequisites);
  if (!prerequisites.ok) return 1;
  try { verifySqlite({ root }); } catch (error) { console.error(error.message); return 1; }
  const buildEnv = { ...env, ...(prerequisites.sdkRoot
    ? { ANDROID_HOME: prerequisites.sdkRoot, ANDROID_SDK_ROOT: prerequisites.sdkRoot } : {}) };
  const pnpm = platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const workspaceRoot = path.resolve(root, '../..');
  const steps = [
    // Restore the Web dependency graph through the root submodule guard.
    // Excluding Web keeps its native base separate; two filters avoid cmd.exe's ^ escaping.
    { command: pnpm, args: ['run', 'build', '--filter=@aervox/web...', '--filter=!@aervox/web'], cwd: workspaceRoot },
    { command: pnpm, args: ['run', 'mobile:schema'], cwd: workspaceRoot },
    { command: pnpm, args: ['run', 'build:web:native'], cwd: root },
    { command: pnpm, args: ['exec', 'cap', 'sync', 'android'], cwd: root },
    { command: pnpm, args: ['run', 'prepare:native'], cwd: root },
    ...(terminationProbe ? [
      { command: pnpm, args: ['exec', 'vite', 'build', '--config', 'test/fixtures/termination-probe.vite.config.ts', '--base', '/m0/'],
        cwd: path.resolve(root, '../web'), env: { ...buildEnv, VITE_AERVOX_PLATFORM: 'mobile' } },
      { command: pnpm, args: ['run', 'prepare:native:termination-probe'], cwd: root },
    ] : []),
    { command: platform === 'win32' ? 'gradlew.bat' : './gradlew', args: [terminationProbe ? 'assembleDeterministicProbe' : 'assembleDebug'], cwd: path.join(root, 'android') },
  ];
  for (const step of steps) {
    const result = run(step.command, step.args, { cwd: step.cwd, env: step.env ?? buildEnv, stdio: 'inherit', shell: platform === 'win32' });
    if (result.error || result.status !== 0) return result.status || 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = buildAndroid({ terminationProbe: process.argv.includes('--termination-probe') });
}
