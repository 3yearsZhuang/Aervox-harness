import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aervox-dev-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(new URL('../aervox', import.meta.url), join(dir, 'aervox'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(new URL('./project-env.sh', import.meta.url), join(dir, 'scripts/project-env.sh'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'apps/cli/dist'), { recursive: true });
  // Bundle the actual launcher validator, while stubbing installs and services.
  buildSync({ entryPoints: [fileURLToPath(new URL('../apps/cli/src/validate-api-url.ts', import.meta.url))],
    outfile: join(dir, 'apps/cli/dist/validate-api-url.js'), bundle: true, platform: 'node', format: 'esm' });
  const put = (name, source) => writeFileSync(join(dir, 'bin', name), source, { mode: 0o755 });
  put('mise', '#!/bin/sh\n[ "$1" = exec ] || exit 90\nshift\n[ "$1" = -- ] || exit 91\nshift\nexec "$@"\n');
  put('pnpm', `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync('calls', JSON.stringify({ args: process.argv.slice(2), url: process.env.DATABASE_URL, port: process.env.PORT }) + '\\n');
`);
  put('lsof', `#!/bin/sh
printf '%s\\n' "$*" >> port-calls
case "$*" in
  *-tiTCP:3000*)
    if [ "\${FIXTURE_OCCUPIED:-0}" = 1 ] && { [ ! -f stopped ] || [ "\${FIXTURE_KEEP_LISTENING:-0}" = 1 ]; }; then printf '12345\\n'; fi
    ;;
esac
`);
  put('curl', `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync('probe-calls', JSON.stringify({ args, input: args.includes('@-') ? fs.readFileSync(0, 'utf8') : '' }) + '\\n');
const calls = fs.existsSync('calls') ? fs.readFileSync('calls', 'utf8') : '';
const started = calls.includes('--filter=@aervox/api');
process.exit(process.env.FIXTURE_CURL_MODE === 'existing' || (process.env.FIXTURE_CURL_MODE === 'ready-after-start' && started) ? 0 : 22);
`);
  put('node', `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv[2]?.endsWith('validate-api-url.js')) {
  const result = spawnSync(${JSON.stringify(process.execPath)}, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
fs.appendFileSync('calls', JSON.stringify({ cli: true, args: process.argv.slice(2), api: process.env.SIYU_API_URL }) + '\\n');
process.exit(Number(process.env.FIXTURE_CLI_EXIT_CODE || 0));
`);
  writeFileSync(join(dir, 'bash-env'), 'kill() { printf "%s\\n" "$*" >> kill-calls; if [ "$1" = -0 ]; then [ "${FIXTURE_EARLY_EXIT:-0}" != 1 ]; else touch stopped; fi; }\nsleep() { SECONDS=$((SECONDS + 1)); }\n');
  const run = (args, env = {}) => spawnSync('bash', [join(dir, 'aervox'), 'dev', ...args], {
    cwd: tmpdir(), encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '', PORT: '3000', AERVOX_WEB_PORT: '5173', AERVOX_DESKTOP_PORT: '5174', ...env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`, BASH_ENV: env.BASH_ENV ?? join(dir, 'bash-env') },
  });
  const calls = () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  return { dir, run, calls };
}

test('dev dispatches selected services and TUI flags, installs dependencies once', t => {
  const { run, calls } = fixture(t);
  const result = run(['--tui', 'web']);
  assert.equal(result.status, 0, result.stderr);
  const recorded = calls();
  assert.deepEqual(recorded[0].args, ['install', '--frozen-lockfile', '--prefer-offline']);
  assert.deepEqual(recorded[1].args, ['exec', 'turbo', 'run', 'dev', '--output-logs=new-only', '--ui', 'tui', '--filter=@aervox/api', '--filter=@aervox/web']);
  assert.equal(recorded.length, 2);
});

test('dev preserves exported settings over .env and preserves SQLite URI identities', t => {
  const { dir, run, calls } = fixture(t);
  writeFileSync(join(dir, '.env'), 'DATABASE_URL=file:wrong.db\nPORT=5999\n');
  for (const url of ['file:aervox.db', 'file:data/aervox.db', 'file:custom%20db.sqlite', 'file::memory:?cache=shared', ':memory:', 'file://localhost/tmp/example.db']) {
    const result = run(['worker'], { DATABASE_URL: url, PORT: '4123' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls().at(-1).url, url);
    assert.equal(calls().at(-1).port, '4123');
  }
});

test('dev uses .env values when the caller has not exported them', t => {
  const { dir, run, calls } = fixture(t);
  writeFileSync(join(dir, '.env'), 'DATABASE_URL=file:from-env.db\nPORT=5999\n');
  const result = run(['worker'], { DATABASE_URL: undefined, PORT: undefined });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().at(-1).url, 'file:from-env.db');
  assert.equal(calls().at(-1).port, '5999');
});

test('dev rejects an occupied API listener before installing dependencies', t => {
  const { dir, run } = fixture(t);
  const result = run(['api'], { FIXTURE_OCCUPIED: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /端口冲突/);
  assert.equal(existsSync(join(dir, 'calls')), false);
  assert.equal(readFileSync(join(dir, 'port-calls'), 'utf8').trim(), '-nP -tiTCP:3000 -sTCP:LISTEN');
});

test('clean-ports targets only selected listeners and uses graceful termination', t => {
  const { dir, run } = fixture(t);
  const result = run(['api', '--clean-ports'], { FIXTURE_OCCUPIED: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, 'kill-calls'), 'utf8').trim(), '-TERM 12345');
  const probes = readFileSync(join(dir, 'port-calls'), 'utf8').trim().split('\n');
  assert.ok(probes.length >= 2);
  assert.ok(probes.every(line => line === '-nP -tiTCP:3000 -sTCP:LISTEN'));
});

test('clean-ports fails when a listener remains, and worker never probes application ports', t => {
  const { dir, run } = fixture(t);
  const result = run(['api', '-k'], { FIXTURE_OCCUPIED: '1', FIXTURE_KEEP_LISTENING: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /尚未退出/);
  assert.equal(existsSync(join(dir, 'calls')), false);
  rmSync(join(dir, 'port-calls'));
  const worker = run(['worker', '-k']);
  assert.equal(worker.status, 0, worker.stderr);
  assert.equal(existsSync(join(dir, 'port-calls')), false);
});

test('dev rejects unknown options and targets before starting tools', t => {
  const { dir, run } = fixture(t);
  for (const args of [['--missing'], ['missing']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /未知 dev/);
  }
  assert.equal(existsSync(join(dir, 'calls')), false);
});


test('dev validates every selected port before probing or terminating listeners', t => {
  const { dir, run } = fixture(t);
  for (const port of ['1-65535', '3000,3001', ' 3000', '0', '65536', '99999999999999999999']) {
    const result = run(['api', '-k'], { PORT: port });
    assert.equal(result.status, 1, port);
    assert.match(result.stderr, /开发端口必须是/);
    assert.equal(existsSync(join(dir, 'port-calls')), false);
    assert.equal(existsSync(join(dir, 'kill-calls')), false);
    assert.equal(existsSync(join(dir, 'calls')), false);
  }
  const result = run(['web', '-k'], { AERVOX_WEB_PORT: '5173,5174' });
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(dir, 'port-calls')), false);
});

test('dev cli reuses an existing API, follows PORT, and preserves CLI failures', t => {
  const { dir, run, calls } = fixture(t);
  const result = run(['cli'], { PORT: '4123', FIXTURE_CURL_MODE: 'existing', FIXTURE_CLI_EXIT_CODE: '7' });
  assert.equal(result.status, 7, result.stderr);
  const recorded = calls();
  assert.equal(recorded.at(-1).api, 'http://127.0.0.1:4123');
  assert.equal(recorded.filter(call => call.args[0] === 'install').length, 1);
  assert.equal(recorded.some(call => call.args.includes('--filter=@aervox/api')), false);
  assert.equal(existsSync(join(dir, 'kill-calls')), false);
  const probe = JSON.parse(readFileSync(join(dir, 'probe-calls'), 'utf8').trim());
  assert.ok(probe.args.includes('--fail'));
  assert.ok(probe.args.includes('--max-time'));
  assert.equal(probe.args.at(-1), 'http://127.0.0.1:4123/v1/sessions?limit=1');
});

test('dev cli starts its API and terminates only that process group after chat', t => {
  const { dir, run, calls } = fixture(t);
  const result = run(['cli'], { FIXTURE_CURL_MODE: 'ready-after-start' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().at(-1).cli, true);
  const commands = readFileSync(join(dir, 'kill-calls'), 'utf8').trim().split('\n');
  assert.ok(commands.some(command => /^-0 \d+$/.test(command)));
  assert.equal(commands.filter(command => /^-TERM -- -\d+$/.test(command)).length, 1);
});

test('dev cli readiness timeout fails and cleans the service without starting chat', t => {
  const { dir, run, calls } = fixture(t);
  const result = run(['cli'], { FIXTURE_CURL_MODE: 'failed' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /等待 API 就绪超时/);
  assert.equal(calls().some(call => call.cli), false);
  assert.match(readFileSync(join(dir, 'kill-calls'), 'utf8'), /-TERM -- -\d+/);
});

test('dev cli detects a failed service process and cleans it without starting chat', t => {
  const { dir, run, calls } = fixture(t);
  const result = run(['cli'], { FIXTURE_EARLY_EXIT: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /API 启动失败/);
  assert.equal(calls().some(call => call.cli), false);
  assert.match(readFileSync(join(dir, 'kill-calls'), 'utf8'), /-TERM -- -\d+/);
});

test('dev cli preserves a specified API and sends auth through stdin', t => {
  const { dir, run, calls } = fixture(t);
  const result = run(['cli'], { FIXTURE_CURL_MODE: 'existing', SIYU_API_URL: 'http://localhost:4124/', SIYU_API_TOKEN: 'fixture-token' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().at(-1).api, 'http://localhost:4124');
  const probe = JSON.parse(readFileSync(join(dir, 'probe-calls'), 'utf8').trim());
  assert.equal(probe.input, 'Authorization: Bearer fixture-token\n');
  assert.equal(probe.args.some(arg => arg.includes('fixture-token')), false);
  assert.equal(existsSync(join(dir, 'kill-calls')), false);
});

test('dev cli fails an unavailable custom API without starting a different service', t => {
  const { dir, run, calls } = fixture(t);
  const result = run(['cli'], { SIYU_API_URL: 'http://localhost:4124' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /指定 API 地址尚未就绪/);
  assert.equal(calls().some(call => call.cli || call.args.includes('--filter=@aervox/api')), false);
  assert.equal(existsSync(join(dir, 'kill-calls')), false);
});

test('dev cli validates local root URLs before sending a token or probing', t => {
  const { dir, run, calls } = fixture(t);
  for (const url of ['https://remote.invalid', 'http://localhost:3000/path', 'http://user:secret@localhost:3000',
    'http://localhost:3000/?token=secret', 'http://localhost:3000/#secret', 'file:///tmp/api', 'bad-url']) {
    const result = run(['cli'], { SIYU_API_URL: url, SIYU_API_TOKEN: 'fixture-token', FIXTURE_CURL_MODE: 'existing' });
    assert.equal(result.status, 2, url);
    assert.match(result.stderr, /仅支持本机/);
    assert.doesNotMatch(result.stdout + result.stderr, /secret|fixture-token/);
    assert.equal(existsSync(join(dir, 'probe-calls')), false);
    assert.equal(calls().some(call => call.cli || call.args.includes('--filter=@aervox/api')), false);
  }
});

test('dev cli EXIT trap reaches a real service and its descendant process', async t => {
  const { dir, run } = fixture(t);
  writeFileSync(join(dir, 'bin/pnpm'), `#!${process.execPath}
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
fs.appendFileSync('calls', JSON.stringify({ args }) + '\\n');
if (args.includes('--filter=@aervox/api')) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => { require('fs').writeFileSync('descendant-stopped', 'yes'); process.exit(0); }); setInterval(() => {}, 1000); require('fs').writeFileSync('descendant-pid', String(process.pid));"], { stdio: 'inherit' });
  fs.writeFileSync('service-pid', String(process.pid));
  process.on('SIGTERM', () => { fs.writeFileSync('service-stopped', 'yes'); });
  child.on('exit', () => process.exit(0));
}
`, { mode: 0o755 });
  // Probe readiness only after both processes have registered signal handlers.
  writeFileSync(join(dir, 'bin/curl'), `#!/bin/sh
[ -f descendant-pid ] || exit 22
`, { mode: 0o755 });
  const pids = () => ['service-pid', 'descendant-pid'].filter(name => existsSync(join(dir, name)))
    .map(name => Number(readFileSync(join(dir, name), 'utf8')));
  t.after(() => { for (const pid of pids()) { try { process.kill(pid, 'SIGTERM'); } catch {} } });
  const result = run(['cli'], { BASH_ENV: '/dev/null' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(dir, 'service-stopped')), true);
  assert.equal(existsSync(join(dir, 'descendant-stopped')), true);
  const isRunning = pid => {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    if (process.platform === 'linux') {
      try {
        // kill(0) also succeeds for exited zombies until PID 1 reaps them.
        // Such a process cannot execute or retain service resources.
        return !/^State:\s+[ZX]\b/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'));
      } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }
    return true;
  };
  const deadline = Date.now() + 3_000;
  while (pids().some(isRunning) && Date.now() < deadline) await delay(25);
  for (const pid of pids()) {
    assert.equal(isRunning(pid), false, `service process ${pid} must stop after CLI exit`);
  }
});

test('real mise exec and tasks preserve caller exports, .env, then project defaults', t => {
  const { dir } = fixture(t);
  const env = { ...process.env, MISE_TRUSTED_CONFIG_PATHS: dir, PORT: '4123', DATABASE_URL: 'file:caller.db',
    AERVOX_LOOP_PROVIDER: 'replay', AERVOX_PROJECT: undefined, AERVOX_NODE_MIN: undefined };
  writeFileSync(join(dir, 'mise.toml'), `[tools]\nnode = "24"\n[env]\n_.source = "scripts/project-env.sh"\n[tasks.inspect]\nrun = "node inspect.cjs"\n`);
  writeFileSync(join(dir, 'inspect.cjs'), `process.stdout.write(JSON.stringify({ port: process.env.PORT,
    database: process.env.DATABASE_URL, provider: process.env.AERVOX_LOOP_PROVIDER, project: process.env.AERVOX_PROJECT }));`);
  writeFileSync(join(dir, '.env'), 'PORT=5999\nDATABASE_URL=file:dotenv.db\nAERVOX_LOOP_PROVIDER=scripted\n');
  for (const command of [['exec', '--', 'node', 'inspect.cjs'], ['tasks', 'run', 'inspect']]) {
    const inherited = spawnSync('mise', command, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.deepEqual(JSON.parse(inherited.stdout), { port: '4123', database: 'file:caller.db', provider: 'replay', project: 'aervox-harness' });
    const dotenv = spawnSync('mise', command, { cwd: dir,
      env: { ...env, PORT: undefined, DATABASE_URL: undefined, AERVOX_LOOP_PROVIDER: undefined }, encoding: 'utf8' });
    assert.equal(dotenv.status, 0, dotenv.stderr);
    assert.deepEqual(JSON.parse(dotenv.stdout), { port: '5999', database: 'file:dotenv.db', provider: 'scripted', project: 'aervox-harness' });
  }
});
