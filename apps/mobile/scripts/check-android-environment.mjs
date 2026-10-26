import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const mobileRoot = fileURLToPath(new URL('../', import.meta.url));

/** Read-only preflight. It never installs SDKs, accepts licenses or runs Gradle. */
export function inspectAndroidEnvironment({
  env = process.env, platform = process.platform, home = homedir(), root = mobileRoot,
  exists = existsSync, read = file => readFileSync(file, 'utf8'), run = spawnSync,
  device = false,
} = {}) {
  const checks = [];
  const add = (id, ok, message) => checks.push({ id, ok, message });
  const binary = name => platform === 'win32' ? `${name}.exe` : name;
  const java = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', binary('java')) : binary('java');
  const javaResult = run(java, ['-version'], { encoding: 'utf8', timeout: 10_000 });
  const javaVersion = `${javaResult.stdout ?? ''}\n${javaResult.stderr ?? ''}`.match(/version\s+"(?:1\.)?(\d+)/);
  const javaMajor = Number(javaVersion?.[1] ?? 0);
  // Capacitor emits Java 21 source; the pinned Gradle 8.14.3 supports JVMs through 24.
  const javaSupported = javaResult.status === 0 && javaMajor >= 21 && javaMajor <= 24;
  add('java', javaSupported,
    javaSupported ? `JDK ${javaMajor}` : 'Use JDK 21–24 for the pinned Gradle 8.14.3; set JAVA_HOME or PATH (JDK 21 recommended).');

  const variablesFile = path.join(root, 'android', 'variables.gradle');
  const variables = exists(variablesFile) ? read(variablesFile) : '';
  const compileSdk = Number(variables.match(/compileSdkVersion\s*=\s*(\d+)/)?.[1] ?? 0);
  const minimumSdk = Number(variables.match(/minSdkVersion\s*=\s*(\d+)/)?.[1] ?? 0);
  add('project', compileSdk > 0 && minimumSdk > 0,
    compileSdk > 0 && minimumSdk > 0 ? `Android project: compile API ${compileSdk}, minimum API ${minimumSdk}` : 'Android project variables are missing or invalid.');

  let sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  const conflictingSdk = !!(env.ANDROID_HOME && env.ANDROID_SDK_ROOT
    && path.resolve(env.ANDROID_HOME) !== path.resolve(env.ANDROID_SDK_ROOT));
  const localProperties = path.join(root, 'android', 'local.properties');
  if (!sdk && exists(localProperties)) {
    sdk = read(localProperties).match(/^\s*sdk\.dir\s*=\s*(.+?)\s*$/m)?.[1]
      ?.replace(/\\u([a-f\d]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\(.)/g, '$1');
  }
  sdk ||= platform === 'darwin' ? path.join(home, 'Library', 'Android', 'sdk')
    : platform === 'win32' ? path.join(home, 'AppData', 'Local', 'Android', 'Sdk')
      : path.join(home, 'Android', 'Sdk');
  const validSdkRoot = !conflictingSdk && path.isAbsolute(sdk) && exists(sdk);
  add('sdk', validSdkRoot, conflictingSdk ? 'ANDROID_HOME and ANDROID_SDK_ROOT must refer to the same SDK.'
    : validSdkRoot ? 'Android SDK directory found.' : 'Android SDK directory is missing; set ANDROID_HOME or android/local.properties.');
  const platformInstalled = validSdkRoot && compileSdk > 0 && exists(path.join(sdk, 'platforms', `android-${compileSdk}`, 'android.jar'));
  add('sdk-platform', platformInstalled,
    platformInstalled ? `SDK platform API ${compileSdk} installed.` : `Install SDK platform API ${compileSdk || '(project unavailable)'} before building.`);
  // AGP 8.13.0 in the official template selects Build Tools 35.0.0 by default.
  const buildTools = '35.0.0';
  const buildToolsInstalled = validSdkRoot && ['aapt2', 'zipalign'].every(name => exists(path.join(sdk, 'build-tools', buildTools, binary(name))))
    && exists(path.join(sdk, 'build-tools', buildTools, platform === 'win32' ? 'apksigner.bat' : 'apksigner'));
  add('sdk-build-tools', buildToolsInstalled,
    buildToolsInstalled ? `SDK Build Tools ${buildTools} installed.` : `Install SDK Build Tools ${buildTools}; Gradle automatic SDK downloads are disabled.`);

  if (device) {
    const adb = path.join(sdk, 'platform-tools', binary('adb'));
    const adbInstalled = validSdkRoot && exists(adb);
    add('adb', adbInstalled, adbInstalled ? 'SDK adb found.' : 'Install SDK platform-tools before checking a device.');
    if (adbInstalled) {
      const result = run(adb, ['devices'], { encoding: 'utf8', timeout: 10_000 });
      const available = String(result.stdout ?? '').split(/\r?\n/)
        .map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === 'device').map(parts => parts[0]);
      const selected = env.ANDROID_SERIAL
        ? available.find(serial => serial === env.ANDROID_SERIAL)
        : available.length === 1 ? available[0] : undefined;
      add('device', result.status === 0 && !!selected,
        selected ? 'Authorized Android target selected.' : 'Connect one authorized target, or select it with ANDROID_SERIAL.');
      if (result.status === 0 && selected) {
        const version = run(adb, ['-s', selected, 'shell', 'getprop', 'ro.build.version.sdk'], { encoding: 'utf8', timeout: 10_000 });
        const api = Number(String(version.stdout ?? '').trim());
        add('device-api', version.status === 0 && minimumSdk > 0 && Number.isInteger(api) && api >= minimumSdk,
          version.status === 0 && api >= minimumSdk ? `Target API ${api}.` : `Target must run API ${minimumSdk} or newer.`);
      }
    }
  }
  return { ok: checks.every(check => check.ok), checks, sdkRoot: validSdkRoot ? sdk : undefined };
}

export function printAndroidChecks(result, log = console.log) {
  for (const check of result.checks) log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.message}`);
  log('Preflight checks prerequisites only; APK compilation and device acceptance remain separate.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--device')) {
    console.error('Usage: node scripts/check-android-environment.mjs [--device]');
    process.exitCode = 2;
  } else {
    const result = inspectAndroidEnvironment({ device: args.includes('--device') });
    printAndroidChecks(result);
    if (!result.ok) process.exitCode = 1;
  }
}
