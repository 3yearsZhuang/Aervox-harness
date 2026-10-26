import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  const code = buildAndroid({ inspect: () => ({ ok: false, checks: [] }), report: () => {}, run: (...args) => calls.push(args) });
  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

test('native build supplies the discovered SDK to child processes without changing the caller environment', () => {
  const env = { PATH: '/tools' };
  const calls = [];
  const code = buildAndroid({ env, inspect: () => ({ ok: true, checks: [], sdkRoot: '/android-sdk' }), report: () => {},
    platform: 'linux', run: (command, args, options) => { calls.push(options); return { status: 0 }; } });
  assert.equal(code, 0);
  assert.equal(calls.at(-1).env.ANDROID_HOME, '/android-sdk');
  assert.equal(calls.at(-1).env.ANDROID_SDK_ROOT, '/android-sdk');
  assert.deepEqual(env, { PATH: '/tools' });
});

test('native build stops on Web or sync failure and preserves the failing exit status', () => {
  for (const failAt of [0, 1, 2]) {
    const calls = [];
    const code = buildAndroid({ root: mobileRoot, inspect: () => ({ ok: true, checks: [] }), report: () => {},
      platform: 'linux', run: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return { status: calls.length - 1 === failAt ? 7 : 0 };
      } });
    assert.equal(code, 7);
    assert.equal(calls.length, failAt + 1);
    if (failAt === 2) assert.deepEqual(calls[2], { command: './gradlew', args: ['assembleDebug'], cwd: path.join(mobileRoot, 'android') });
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
