import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectAndroidEnvironment, mobileRoot } from '../scripts/check-android-environment.mjs';
import { buildAndroid } from '../scripts/build-android.mjs';

function environment(overrides = {}) {
  const root = '/project/mobile';
  const sdk = '/android-sdk';
  const files = new Map([
    [path.join(root, 'android', 'variables.gradle'), 'ext { minSdkVersion = 24\ncompileSdkVersion = 36 }'],
    [sdk, ''],
    [path.join(sdk, 'platforms/android-36/android.jar'), ''],
    [path.join(sdk, 'platform-tools/adb'), ''],
    [path.join(sdk, 'build-tools/35.0.0/aapt2'), ''],
    [path.join(sdk, 'build-tools/35.0.0/zipalign'), ''],
    [path.join(sdk, 'build-tools/35.0.0/apksigner'), ''],
  ]);
  return { env: { ANDROID_HOME: sdk }, platform: 'linux', home: '/home/test', root,
    exists: file => files.has(file), read: file => files.get(file),
    run: (command, args) => command === 'java' ? { status: 0, stderr: 'openjdk version "21.0.7"' }
      : args[0] === 'devices' ? { status: 0, stdout: 'List of devices attached\nphone\tdevice\n' }
        : { status: 0, stdout: '36\n' },
    ...overrides };
}

function fileEnvironment(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'aervox-android-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const android = path.join(root, 'android');
  mkdirSync(android);
  writeFileSync(path.join(android, 'variables.gradle'), 'ext { minSdkVersion = 24\ncompileSdkVersion = 36 }');
  const sdk = path.join(root, 'SDK with spaces');
  for (const relative of ['platforms/android-36/android.jar', 'build-tools/35.0.0/aapt2',
    'build-tools/35.0.0/zipalign', 'build-tools/35.0.0/apksigner']) {
    const file = path.join(sdk, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  const properties = path.join(android, 'local.properties');
  const encode = value => value.replace(/\\/g, '\\\\').replace(/ /g, '\\ ');
  writeFileSync(properties, `sdk.dir=${encode(sdk)}\n`);
  const inspect = overrides => inspectAndroidEnvironment({ root, home: root, platform: 'linux',
    env: { ANDROID_HOME: sdk }, run: command => ({ status: 0,
      stderr: `openjdk version "${command.includes('jdk17') ? 17 : 21}.0.7"` }), ...overrides });
  return { root, android, sdk, properties, encode, inspect };
}

test('SDK environment conflicts with real local.properties fail before native build', t => {
  const fixture = fileEnvironment(t);
  const before = readFileSync(fixture.properties);
  for (const env of [{ ANDROID_HOME: '/other-sdk' }, { ANDROID_SDK_ROOT: '/other-sdk' },
    { ANDROID_HOME: fixture.sdk, ANDROID_SDK_ROOT: '/other-sdk' }]) {
    const result = fixture.inspect({ env });
    assert.equal(result.ok, false);
    assert.equal(result.sdkRoot, undefined);
    assert.match(result.checks.find(check => check.id === 'sdk').message, /same SDK/);
    const calls = [];
    assert.equal(buildAndroid({ env, root: fixture.root, inspect: fixture.inspect,
      report: () => {}, run: (...args) => calls.push(args) }), 1);
    assert.deepEqual(calls, []);
  }
  assert.deepEqual(readFileSync(fixture.properties), before);
});

test('the real local SDK is selected without env and equivalent normalized paths agree', t => {
  const fixture = fileEnvironment(t);
  const before = readFileSync(fixture.properties);
  for (const env of [{}, { ANDROID_HOME: `${fixture.sdk}/../SDK with spaces/`, ANDROID_SDK_ROOT: fixture.sdk }]) {
    const result = fixture.inspect({ env });
    assert.equal(result.ok, true);
    assert.equal(result.sdkRoot, realpathSync(fixture.sdk));
  }
  assert.deepEqual(readFileSync(fixture.properties), before);
});

test('SDK aliases use real paths and Java property syntax instead of bypassing sdk.dir', t => {
  const fixture = fileEnvironment(t);
  const alias = path.join(fixture.root, 'sdk-link');
  symlinkSync(fixture.sdk, alias, 'junction');
  // Java Properties accepts colon separators, continuations and escaped Unicode.
  writeFileSync(fixture.properties, `# comment ending in a slash\\\nsdk.dir=/obsolete\nsdk\\.dir : ${fixture.encode(fixture.sdk).replace('SDK', '\\u0053DK')}\\\n  /\n`);
  const before = readFileSync(fixture.properties);
  const result = fixture.inspect({ env: { ANDROID_HOME: alias } });
  assert.equal(result.ok, true);
  assert.equal(result.sdkRoot, realpathSync(fixture.sdk));
  assert.deepEqual(readFileSync(fixture.properties), before);
});

test('non-escaped UTF-8 SDK paths match the Android Gradle local.properties reader', t => {
  const fixture = fileEnvironment(t);
  const alias = path.join(fixture.root, '中文 SDK');
  symlinkSync(fixture.sdk, alias, 'junction');
  writeFileSync(fixture.properties, `sdk.dir=${fixture.encode(alias)}\n`, 'utf8');
  const before = readFileSync(fixture.properties);
  const result = fixture.inspect();
  assert.equal(result.ok, true);
  assert.equal(result.sdkRoot, realpathSync(fixture.sdk));
  assert.deepEqual(readFileSync(fixture.properties), before);
});

test('empty or malformed local sdk.dir cannot be hidden by a valid environment SDK', t => {
  const fixture = fileEnvironment(t);
  for (const contents of ['sdk.dir=\n', 'sdk.dir=\\uZZZZ\n']) {
    writeFileSync(fixture.properties, contents);
    const result = fixture.inspect();
    assert.equal(result.ok, false);
    assert.equal(result.sdkRoot, undefined);
  }
});

test('Windows SDK properties and environment paths agree after platform normalization', () => {
  const root = 'C:\\project\\mobile';
  const sdk = 'C:\\Android\\Sdk';
  const files = new Map([
    [path.win32.join(root, 'android/variables.gradle'), 'ext { minSdkVersion = 24\ncompileSdkVersion = 36 }'],
    [path.win32.join(root, 'android/local.properties'), 'sdk.dir=C\\:\\\\Android\\\\Sdk\n'],
    [sdk, ''], [path.win32.join(sdk, 'platforms/android-36/android.jar'), ''],
    [path.win32.join(sdk, 'build-tools/35.0.0/aapt2.exe'), ''],
    [path.win32.join(sdk, 'build-tools/35.0.0/zipalign.exe'), ''],
    [path.win32.join(sdk, 'build-tools/35.0.0/apksigner.bat'), ''],
  ].map(([file, value]) => [file.toLowerCase(), value]));
  const result = inspectAndroidEnvironment({ root, home: 'C:\\Users\\test', platform: 'win32',
    env: { ANDROID_HOME: 'c:/android/sdk/../sdk/' }, realpath: file => file,
    exists: file => files.has(file.toLowerCase()), read: file => files.get(file.toLowerCase()),
    run: () => ({ status: 0, stderr: 'openjdk version "21.0.7"' }) });
  assert.equal(result.ok, true);
  assert.equal(result.sdkRoot, sdk);
});

test('the Gradle JVM override is checked separately from the Java 21 launcher', t => {
  const fixture = fileEnvironment(t);
  const properties = path.join(fixture.android, 'gradle.properties');
  const jdk17 = path.join(fixture.root, 'jdk17');
  writeFileSync(properties, `org.gradle.java.home=${fixture.encode(jdk17)}\n`);
  const before = readFileSync(properties);
  const result = fixture.inspect();
  assert.equal(result.checks.find(check => check.id === 'java').ok, true);
  assert.equal(result.checks.find(check => check.id === 'gradle-java').ok, false);
  assert.equal(result.ok, false);
  assert.deepEqual(readFileSync(properties), before);
});

test('Gradle user properties take precedence and respect GRADLE_USER_HOME', t => {
  const fixture = fileEnvironment(t);
  writeFileSync(path.join(fixture.android, 'gradle.properties'), 'org.gradle.java.home=/jdk17\n');
  for (const userHome of [path.join(fixture.root, '.gradle'), path.join(fixture.root, 'selected-gradle')]) {
    mkdirSync(userHome);
    writeFileSync(path.join(userHome, 'gradle.properties'), 'org.gradle.java.home=/jdk21\n');
  }
  assert.equal(fixture.inspect().ok, true);
  const selected = path.join(fixture.root, 'selected-gradle');
  writeFileSync(path.join(selected, 'gradle.properties'), 'org.gradle.java.home=/jdk17\n');
  const result = fixture.inspect({ env: { ANDROID_HOME: fixture.sdk, GRADLE_USER_HOME: selected } });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.id === 'gradle-java').ok, false);
});

test('uninspected Gradle JVM overrides fail explicitly instead of claiming prerequisites pass', t => {
  const fixture = fileEnvironment(t);
  for (const name of ['GRADLE_OPTS', 'JAVA_OPTS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS']) {
    assert.equal(fixture.inspect({ env: { ANDROID_HOME: fixture.sdk, [name]: '-Dorg.gradle.java.home=/jdk17' } }).ok, false);
  }
  assert.equal(fixture.inspect({ env: { ANDROID_HOME: fixture.sdk, GRADLE_OPTS: '-Dgradle.user.home=/other' } }).ok, false);
  mkdirSync(path.join(fixture.android, 'gradle'));
  writeFileSync(path.join(fixture.android, 'gradle/gradle-daemon-jvm.properties'), 'toolchainVersion=17\n');
  assert.equal(fixture.inspect().ok, false);
});

test('preflight requires the actual project SDK platform and Java 21', () => {
  assert.equal(inspectAndroidEnvironment(environment()).ok, true);
  const java17 = inspectAndroidEnvironment(environment({ run: () => ({ status: 0, stderr: 'openjdk version "17.0.16"' }) }));
  assert.equal(java17.checks.find(check => check.id === 'java').ok, false);
  const fixture = environment();
  const missingPlatform = inspectAndroidEnvironment({ ...fixture, exists: file => !file.endsWith('android.jar') && fixture.exists(file) });
  assert.equal(missingPlatform.checks.find(check => check.id === 'sdk-platform').ok, false);
});

test('preflight rejects a newer JVM unsupported by the pinned Gradle wrapper', () => {
  const result = inspectAndroidEnvironment(environment({ run: () => ({ status: 0, stderr: 'openjdk version "27"' }) }));
  assert.equal(result.checks.find(check => check.id === 'java').ok, false);
});

test('preflight rejects missing Build Tools instead of downloading packages into the SDK', () => {
  const fixture = environment();
  const result = inspectAndroidEnvironment({ ...fixture, exists: file => !file.includes('/build-tools/') && fixture.exists(file) });
  assert.equal(result.checks.find(check => check.id === 'sdk-build-tools').ok, false);
  const properties = readFileSync(path.join(mobileRoot, 'android/gradle.properties'), 'utf8');
  assert.match(properties, /^android\.builder\.sdkDownload=false$/m);
});

test('an explicitly missing SDK does not silently fall back to another installation', () => {
  const fixture = environment({ env: { ANDROID_HOME: '/missing' } });
  const result = inspectAndroidEnvironment(fixture);
  assert.equal(result.checks.find(check => check.id === 'sdk').ok, false);
  assert.equal(result.ok, false);
});

test('conflicting SDK environment variables reject even when either directory exists', () => {
  const result = inspectAndroidEnvironment(environment({ env: { ANDROID_HOME: '/android-sdk', ANDROID_SDK_ROOT: '/different-sdk' } }));
  assert.equal(result.checks.find(check => check.id === 'sdk').ok, false);
});

test('Android Studio local.properties is supported without changing the file', () => {
  const fixture = environment({ env: {} });
  const local = path.join(fixture.root, 'android/local.properties');
  const result = inspectAndroidEnvironment({ ...fixture,
    exists: file => file === local || fixture.exists(file),
    read: file => file === local ? 'sdk.dir=/android-sdk\n' : fixture.read(file),
  });
  assert.equal(result.ok, true);
});

test('device preflight rejects unauthorized targets, ambiguous selection and old Android versions', () => {
  const fixture = environment({ device: true });
  assert.equal(inspectAndroidEnvironment(fixture).ok, true);
  for (const listing of ['phone\tunauthorized\n', 'phone\tdevice\ntablet\tdevice\n']) {
    const result = inspectAndroidEnvironment({ ...fixture,
      run: (command, args) => args[0] === 'devices' ? { status: 0, stdout: listing } : fixture.run(command, args),
    });
    assert.equal(result.checks.find(check => check.id === 'device').ok, false);
  }
  const old = inspectAndroidEnvironment({ ...fixture,
    run: (command, args) => args.includes('getprop') ? { status: 0, stdout: '23\n' } : fixture.run(command, args),
  });
  assert.equal(old.checks.find(check => check.id === 'device-api').ok, false);
});

test('ANDROID_SERIAL chooses an authorized target explicitly and binds the API query', () => {
  const fixture = environment({ device: true, env: { ANDROID_HOME: '/android-sdk', ANDROID_SERIAL: 'tablet' } });
  const calls = [];
  const result = inspectAndroidEnvironment({ ...fixture, run: (command, args) => {
    calls.push(args);
    return args[0] === 'devices' ? { status: 0, stdout: 'phone\tdevice\ntablet\tdevice\n' } : fixture.run(command, args);
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.at(-1), ['-s', 'tablet', 'shell', 'getprop', 'ro.build.version.sdk']);
});

test('native build fails before touching assets or running Gradle when prerequisites are missing', () => {
  const calls = [];
  const code = buildAndroid({ verifySqlite: () => {}, inspect: () => ({ ok: false, checks: [] }), report: () => {}, run: (...args) => calls.push(args) });
  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

test('native build supplies the discovered SDK to child processes without changing the caller environment', () => {
  const env = { PATH: '/tools' };
  const calls = [];
  const code = buildAndroid({ verifySqlite: () => {}, env, inspect: () => ({ ok: true, checks: [], sdkRoot: '/android-sdk' }), report: () => {},
    platform: 'linux', run: (command, args, options) => { calls.push(options); return { status: 0 }; } });
  assert.equal(code, 0);
  assert.equal(calls.at(-1).env.ANDROID_HOME, '/android-sdk');
  assert.equal(calls.at(-1).env.ANDROID_SDK_ROOT, '/android-sdk');
  assert.deepEqual(env, { PATH: '/tools' });
});

test('native build stops on schema generation, Web, sync or Gradle failure and preserves the failing exit status', () => {
  for (const failAt of [0, 1, 2, 3]) {
    const calls = [];
    const code = buildAndroid({ verifySqlite: () => {}, root: mobileRoot, inspect: () => ({ ok: true, checks: [] }), report: () => {},
      platform: 'linux', run: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return { status: calls.length - 1 === failAt ? 7 : 0 };
      } });
    assert.equal(code, 7);
    assert.equal(calls.length, failAt + 1);
    assert.deepEqual(calls[0], { command: 'pnpm', args: ['run', 'mobile:schema'], cwd: path.resolve(mobileRoot, '../..') });
    if (failAt === 3) assert.deepEqual(calls[3], { command: './gradlew', args: ['assembleDebug'], cwd: path.join(mobileRoot, 'android') });
  }
});

test('native source is tracked while generated assets, build files and credentials are ignored', () => {
  const gitRoot = path.resolve(mobileRoot, '../..');
  const ignored = file => {
    try { execFileSync('git', ['check-ignore', '--no-index', '-q', `apps/mobile/android/${file}`], { cwd: gitRoot }); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  for (const file of ['app/src/main/java/com/aervox/mobile/MainActivity.java', 'gradle/wrapper/gradle-wrapper.jar']) assert.equal(ignored(file), false, file);
  for (const file of ['local.properties', 'app/build/outputs/app.apk', 'app/src/main/assets/public/index.html', 'app/src/main/assets/capacitor.config.json', 'capacitor.settings.gradle', 'app/capacitor.build.gradle', 'release.keystore', 'signing.jks', 'app/google-services.json']) assert.equal(ignored(file), true, file);
  const config = JSON.parse(readFileSync(path.join(mobileRoot, 'capacitor.config.json'), 'utf8'));
  const gradle = readFileSync(path.join(mobileRoot, 'android/app/build.gradle'), 'utf8');
  assert.ok(gradle.includes(`namespace = "${config.appId}"`));
  assert.ok(gradle.includes(`applicationId "${config.appId}"`));
});
