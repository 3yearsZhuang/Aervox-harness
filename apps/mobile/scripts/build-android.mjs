import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { inspectAndroidEnvironment, mobileRoot, printAndroidChecks } from './check-android-environment.mjs';

/** Explicit native build: missing prerequisites fail before asset generation or downloads. */
export function buildAndroid({ inspect = inspectAndroidEnvironment, report = printAndroidChecks,
  run = spawnSync, root = mobileRoot, platform = process.platform, env = process.env } = {}) {
  const prerequisites = inspect({ env, root });
  report(prerequisites);
  if (!prerequisites.ok) return 1;
  const buildEnv = { ...env, ...(prerequisites.sdkRoot
    ? { ANDROID_HOME: prerequisites.sdkRoot, ANDROID_SDK_ROOT: prerequisites.sdkRoot } : {}) };
  const pnpm = platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const steps = [
    { command: pnpm, args: ['run', 'build:web'], cwd: root },
    { command: pnpm, args: ['exec', 'cap', 'sync', 'android'], cwd: root },
    { command: platform === 'win32' ? 'gradlew.bat' : './gradlew', args: ['assembleDebug'], cwd: path.join(root, 'android') },
  ];
  for (const step of steps) {
    const result = run(step.command, step.args, { cwd: step.cwd, env: buildEnv, stdio: 'inherit', shell: platform === 'win32' });
    if (result.error || result.status !== 0) return result.status || 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = buildAndroid();
}
