import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const mobileRoot = fileURLToPath(new URL('../', import.meta.url));

/** Match Java Properties separators, escaping, continuations and last-key wins. */
function parseProperties(contents) {
  const properties = new Map();
  const decode = value => {
    let result = '';
    for (let index = 0; index < value.length; index++) {
      if (value[index] !== '\\') { result += value[index]; continue; }
      const escaped = value[++index];
      if (escaped === undefined) break;
      if (escaped === 'u') {
        const hex = value.slice(index + 1, index + 5);
        if (!/^[a-f\d]{4}$/i.test(hex)) throw new Error('Invalid Java property Unicode escape.');
        result += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
      } else result += ({ t: '\t', n: '\n', r: '\r', f: '\f' })[escaped] ?? escaped;
    }
    return result;
  };
  const consume = line => {
    if (!line || /^[#!]/.test(line)) return;
    let end = 0;
    while (end < line.length && !/[\t\f :=]/.test(line[end])) {
      if (line[end] === '\\') end++;
      end++;
    }
    let start = end;
    while (/[\t\f ]/.test(line[start] ?? '')) start++;
    if (line[start] === ':' || line[start] === '=') start++;
    while (/[\t\f ]/.test(line[start] ?? '')) start++;
    properties.set(decode(line.slice(0, end)), decode(line.slice(start)));
  };
  let logical = '';
  let continuing = false;
  for (const line of contents.split(/\r\n|\n|\r/)) {
    if (!continuing && /^[\t\f ]*(?:[#!]|$)/.test(line)) continue;
    logical += line.replace(/^[\t\f ]+/, '');
    const trailing = logical.match(/\\+$/)?.[0].length ?? 0;
    if (trailing % 2) { logical = logical.slice(0, -1); continuing = true; continue; }
    consume(logical);
    logical = '';
    continuing = false;
  }
  if (logical) consume(logical);
  return properties;
}

/** Read-only preflight. It never installs SDKs, accepts licenses or runs Gradle. */
export function inspectAndroidEnvironment({
  env = process.env, platform = process.platform, home = homedir(), root = mobileRoot,
  exists = existsSync, read = (file, encoding = 'utf8') => readFileSync(file, encoding), realpath = realpathSync, run = spawnSync,
  device = false,
} = {}) {
  const checks = [];
  const add = (id, ok, message) => checks.push({ id, ok, message });
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = value => {
    if (!value || !paths.isAbsolute(value)) return undefined;
    const absolute = paths.resolve(value);
    try { return realpath(absolute); } catch { return absolute; }
  };
  const samePath = (left, right) => platform === 'win32'
    ? left?.toLowerCase() === right?.toLowerCase() : left === right;
  // Gradle properties use Properties.load(InputStream), while AGP reads its
  // local.properties as UTF-8 text before Properties.load(Reader).
  const properties = (file, encoding = 'latin1') => exists(file) ? parseProperties(read(file, encoding)) : new Map();
  const binary = name => platform === 'win32' ? `${name}.exe` : name;
  const inspectJava = command => {
    const result = run(command, ['-version'], { env, encoding: 'utf8', timeout: 10_000 });
    const version = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(/version\s+"(?:1\.)?(\d+)/);
    return { major: Number(version?.[1] ?? 0), status: result.status };
  };
  const java = env.JAVA_HOME ? paths.join(env.JAVA_HOME, 'bin', binary('java')) : binary('java');
  const javaResult = inspectJava(java);
  const javaMajor = javaResult.major;
  // Capacitor emits Java 21 source; the pinned Gradle 8.14.3 supports JVMs through 24.
  const javaSupported = javaResult.status === 0 && javaMajor >= 21 && javaMajor <= 24;
  add('java', javaSupported,
    javaSupported ? `JDK ${javaMajor}` : 'Use JDK 21–24 for the pinned Gradle 8.14.3; set JAVA_HOME or PATH (JDK 21 recommended).');

  try {
    const androidRoot = paths.join(root, 'android');
    const userHome = env.GRADLE_USER_HOME ? paths.resolve(androidRoot, env.GRADLE_USER_HOME) : paths.join(home, '.gradle');
    const userProperties = properties(paths.join(userHome, 'gradle.properties'));
    const projectProperties = properties(paths.join(androidRoot, 'gradle.properties'));
    const unknownOverride = exists(paths.join(androidRoot, 'gradle', 'gradle-daemon-jvm.properties'))
      || ['GRADLE_OPTS', 'JAVA_OPTS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS']
        .some(name => /org\.gradle\.java\.home|(?:gradle\.)?user\.home/.test(env[name] ?? ''))
      || Object.keys(env).some(name => name.startsWith('ORG_GRADLE_PROJECT_') && /org\.gradle\.java\.home|gradle\.user\.home/.test(name))
      || userProperties.has('systemProp.org.gradle.java.home') || projectProperties.has('systemProp.org.gradle.java.home');
    if (unknownOverride) {
      add('gradle-java', false, 'Explicit daemon JVM criteria or JVM option overrides are not inspected; resolve them before building.');
    } else {
      // Gradle user properties override project properties and JAVA_HOME.
      const gradleJava = userProperties.get('org.gradle.java.home') ?? projectProperties.get('org.gradle.java.home');
      if (gradleJava !== undefined) {
        const normalized = normalize(gradleJava);
        const result = normalized ? inspectJava(paths.join(normalized, 'bin', binary('java'))) : { major: 0, status: null };
        const supported = result.status === 0 && result.major >= 21 && result.major <= 24;
        add('gradle-java', supported, supported ? `Configured Gradle JDK ${result.major}.`
          : 'org.gradle.java.home must select JDK 21–24; JAVA_HOME does not override Gradle properties.');
      }
    }
  } catch {
    add('gradle-java', false, 'Gradle JVM properties could not be read; resolve the local configuration before building.');
  }

  const variablesFile = paths.join(root, 'android', 'variables.gradle');
  const variables = exists(variablesFile) ? read(variablesFile) : '';
  const compileSdk = Number(variables.match(/compileSdkVersion\s*=\s*(\d+)/)?.[1] ?? 0);
  const minimumSdk = Number(variables.match(/minSdkVersion\s*=\s*(\d+)/)?.[1] ?? 0);
  add('project', compileSdk > 0 && minimumSdk > 0,
    compileSdk > 0 && minimumSdk > 0 ? `Android project: compile API ${compileSdk}, minimum API ${minimumSdk}` : 'Android project variables are missing or invalid.');

  let localSdk;
  let localSdkError = false;
  try { localSdk = properties(paths.join(root, 'android', 'local.properties'), 'utf8').get('sdk.dir'); }
  catch { localSdkError = true; }
  // AGP selects sdk.dir before the environment. Injecting ANDROID_HOME into a
  // child cannot override an existing local.properties selection.
  const sources = [localSdk, env.ANDROID_HOME || undefined, env.ANDROID_SDK_ROOT || undefined]
    .filter(value => value !== undefined);
  const fallback = platform === 'darwin' ? paths.join(home, 'Library', 'Android', 'sdk')
    : platform === 'win32' ? paths.join(home, 'AppData', 'Local', 'Android', 'Sdk')
      : paths.join(home, 'Android', 'Sdk');
  const sdk = normalize(sources[0] ?? fallback);
  const conflictingSdk = sources.some(value => !samePath(normalize(value), sdk));
  const validSdkRoot = !localSdkError && !conflictingSdk && !!sdk && exists(sdk);
  add('sdk', validSdkRoot, localSdkError ? 'android/local.properties could not be read as Java Properties.'
    : conflictingSdk ? 'ANDROID_HOME, ANDROID_SDK_ROOT and android/local.properties sdk.dir must refer to the same SDK.'
    : validSdkRoot ? 'Android SDK directory found.' : 'Android SDK directory is missing; set ANDROID_HOME or android/local.properties.');
  const platformInstalled = validSdkRoot && compileSdk > 0 && exists(paths.join(sdk, 'platforms', `android-${compileSdk}`, 'android.jar'));
  add('sdk-platform', platformInstalled,
    platformInstalled ? `SDK platform API ${compileSdk} installed.` : `Install SDK platform API ${compileSdk || '(project unavailable)'} before building.`);
  // AGP 8.13.0 in the official template selects Build Tools 35.0.0 by default.
  const buildTools = '35.0.0';
  const buildToolsInstalled = validSdkRoot && ['aapt2', 'zipalign'].every(name => exists(paths.join(sdk, 'build-tools', buildTools, binary(name))))
    && exists(paths.join(sdk, 'build-tools', buildTools, platform === 'win32' ? 'apksigner.bat' : 'apksigner'));
  add('sdk-build-tools', buildToolsInstalled,
    buildToolsInstalled ? `SDK Build Tools ${buildTools} installed.` : `Install SDK Build Tools ${buildTools}; Gradle automatic SDK downloads are disabled.`);

  if (device) {
    const adb = sdk ? paths.join(sdk, 'platform-tools', binary('adb')) : '';
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
