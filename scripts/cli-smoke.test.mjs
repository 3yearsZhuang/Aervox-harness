import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../apps/api/dist/app.js';
import { createDatabase, initDatabaseSchema, SqliteConversationRepository, SqliteToolRegistryRepository } from '../packages/repositories/dist/index.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const token = 'cli-smoke-local-test-token';

// Build prerequisites are declared by test:cli:integration. No real provider or user database is used.
test('packed CLI + authenticated API + file SQLite survives client and API restart', { timeout: 120_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'siyu-package-smoke-'));
  let app;
  let database;
  const previous = new Map(['AERVOX_LOOP_PROVIDER', 'AERVOX_LOOP_DRIVER', 'AERVOX_TURN_EXECUTION'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { AERVOX_LOOP_PROVIDER: 'replay', AERVOX_LOOP_DRIVER: 'native', AERVOX_TURN_EXECUTION: 'background' });
  try {
    await exec('pnpm', ['--filter', '@aervox/cli', 'pack', '--pack-destination', temporary], { cwd: root, timeout: 30_000 });
    const tarball = (await readdir(temporary)).find(name => name.endsWith('.tgz'));
    assert.ok(tarball);
    const install = join(temporary, 'consumer');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(install);
    await writeFile(join(install, 'package.json'), JSON.stringify({ name: 'cli-smoke-consumer', private: true }));
    await exec('pnpm', ['add', '--prod', '--ignore-scripts', join(temporary, tarball)], { cwd: install, timeout: 30_000 });
    const manifest = JSON.parse(await readFile(join(install, 'node_modules/@aervox/cli/package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.equal(manifest.bin.siyu, './dist/index.js');
    const bin = join(install, 'node_modules/.bin/siyu');
    const env = { ...process.env, SIYU_CONFIG_FILE: join(temporary, 'cli.json'), SIYU_API_TOKEN: token };
    assert.match((await exec(bin, ['--help'], { cwd: install, env })).stdout, /思隅 CLI/);
    assert.ok((await readFile(join(install, 'node_modules/@aervox/cli/dist/LICENSE'), 'utf8')).includes('GNU AFFERO GENERAL PUBLIC LICENSE'));

    const startApi = async (initSchema) => {
      database = await createDatabase({ url: `file:${join(temporary, 'business.db')}` });
      if (initSchema) await initDatabaseSchema(database.client);
      ({ app } = await buildApp({ db: database.db, client: database.client,
        auth: { mode: 'token', token }, attachmentsRoot: join(temporary, 'attachments'),
        migrationStatePath: join(temporary, 'migration-state.json'),
      }));
      await app.listen({ host: '127.0.0.1', port: 0 });
      env.SIYU_API_URL = `http://127.0.0.1:${app.server.address().port}`;
    };
    const cli = async (args) => {
      const result = await exec(bin, [...args, '--json'], { cwd: install, env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
      assert.ok(!result.stdout.includes(token)); assert.ok(!result.stderr.includes(token));
      return JSON.parse(result.stdout);
    };
    await startApi(true);
    assert.equal((await cli(['doctor'])).data.connected, true);
    await assert.rejects(exec(bin, ['doctor', '--json'], { cwd: install, env: { ...env, SIYU_API_TOKEN: 'wrong' } }), error => error.code === 3);
    const args = ['ask', '解释闭包', '--session', 'cli_smoke', '--request-id', 'cli_smoke_request'];
    const first = await cli(args);
    assert.equal(first.ok, true); assert.equal(first.status, 'Completed'); assert.match(first.text, /收到/);
    assert.equal((await cli(args)).turnId, first.turnId);
    const repository = new SqliteConversationRepository(database.db);
    const attempts = await repository.listTurnAttempts({ workspaceId: 'local', subjectUserId: 'local' }, first.turnId);
    assert.equal(attempts.length, 1); assert.equal(attempts[0].status, 'Completed');
    assert.equal((await cli(['events', first.turnId])).text, first.text);

    await app.close(); app = undefined; database.client.close(); database = undefined;
    await startApi(false);
    assert.equal((await cli(['events', first.turnId])).text, first.text);
    assert.equal((await cli(['status', first.turnId])).ok, true);
    assert.ok((await cli(['sessions', 'list'])).data.items.some(item => item.id === 'cli_smoke'));
    const second = await cli(['ask', '继续解释', '--session', 'cli_smoke']);
    assert.equal(second.ok, true); assert.notEqual(second.turnId, first.turnId);
    const receipt = JSON.parse(await readFile(join(temporary, 'cli.json.last-run'), 'utf8'));
    assert.equal(receipt.turnId, second.turnId);
  } finally {
    await app?.close(); database?.client.close();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(temporary, { recursive: true, force: true });
  }
});

test('packed CLI tool call loop: multi-step tools and write-approval boundaries', { timeout: 120_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'siyu-tool-smoke-'));
  let app;
  let database;
  let toolRuntime;
  const previous = new Map(['AERVOX_LOOP_PROVIDER', 'AERVOX_LOOP_DRIVER', 'AERVOX_TURN_EXECUTION'].map(key => [key, process.env[key]]));
  try {
    await exec('pnpm', ['--filter', '@aervox/cli', 'pack', '--pack-destination', temporary], { cwd: root, timeout: 30_000 });
    const tarball = (await readdir(temporary)).find(name => name.endsWith('.tgz'));
    assert.ok(tarball);
    const install = join(temporary, 'consumer');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(install);
    await writeFile(join(install, 'package.json'), JSON.stringify({ name: 'cli-tool-consumer', private: true }));
    await exec('pnpm', ['add', '--prod', '--ignore-scripts', join(temporary, tarball)], { cwd: install, timeout: 30_000 });
    const bin = join(install, 'node_modules/.bin/siyu');
    const env = { ...process.env, SIYU_CONFIG_FILE: join(temporary, 'cli.json'), SIYU_API_TOKEN: token };

    const startApi = async (provider) => {
      if (app) { await app.close(); app = undefined; }
      if (database) { database.client.close(); database = undefined; }
      process.env.AERVOX_LOOP_PROVIDER = provider;
      process.env.AERVOX_LOOP_DRIVER = 'native';
      process.env.AERVOX_TURN_EXECUTION = 'background';
      database = await createDatabase({ url: `file:${join(temporary, `${provider}_business.db`)}` });
      await initDatabaseSchema(database.client);
      const built = await buildApp({
        db: database.db, client: database.client,
        auth: { mode: 'token', token }, attachmentsRoot: join(temporary, 'attachments'),
        migrationStatePath: join(temporary, 'migration-state.json'),
      });
      app = built.app;
      toolRuntime = built.toolRuntime;
      await app.listen({ host: '127.0.0.1', port: 0 });
      env.SIYU_API_URL = `http://127.0.0.1:${app.server.address().port}`;

      const registry = new SqliteToolRegistryRepository(database.db);
      await registry.registerTool({
        id: 'aervox_notes_search',
        name: 'aervox_notes_search',
        description: '检索学习笔记（只读）',
        category: 'memory',
        safetyLevel: 'read_only',
        requiredPermissions: [],
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        builtin: false,
        gatingConditions: [],
        priority: 10,
      });
      toolRuntime.registerHandler('aervox_notes_search', {
        call: async () => ({ matches: ['复习计划：今天复习三角函数'] }),
      });

      await registry.registerTool({
        id: 'aervox_save_note',
        name: 'aervox_save_note',
        description: '保存学习笔记（需审批）',
        category: 'memory',
        safetyLevel: 'write_with_approval',
        requiredPermissions: [],
        inputSchema: { type: 'object', properties: { content: { type: 'string' } } },
        builtin: false,
        gatingConditions: [],
        priority: 20,
      });
      toolRuntime.registerHandler('aervox_save_note', {
        call: async (_t, args) => ({ saved: true, content: args.content }),
      });
    };

    const cli = async (args) => {
      const result = await exec(bin, [...args, '--json'], { cwd: install, env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(result.stdout);
    };

    // 1. 验证只读工具两步往返闭环（AERVOX_LOOP_PROVIDER=scripted）
    await startApi('scripted');
    const toolRun = await cli(['ask', '帮我排复习计划', '--session', 'cli_tool_loop']);
    assert.equal(toolRun.ok, true);
    assert.equal(toolRun.status, 'Completed');
    assert.match(toolRun.text, /我先查一下学习笔记/);
    assert.match(toolRun.text, /今天复习三角函数/);

    const repository = new SqliteConversationRepository(database.db);
    const executions = await repository.listToolExecutionsByTurn({ workspaceId: 'local', subjectUserId: 'local' }, toolRun.turnId);
    assert.equal(executions.length, 1);
    assert.equal(executions[0].name, 'aervox_notes_search');
    assert.equal(executions[0].status, 'executed');

    // 2. 验证写工具非 TTY 拒绝自动授权（AERVOX_LOOP_PROVIDER=scripted-write）
    await startApi('scripted-write');
    let rejectedError;
    try {
      await exec(bin, ['ask', '保存笔记', '--session', 'cli_write_loop', '--json'], { cwd: install, env, timeout: 20_000 });
    } catch (error) {
      rejectedError = error;
    }
    assert.ok(rejectedError, '应当因需要写审批而拒绝退出');
    assert.equal(rejectedError.code, 4);
    const payload = JSON.parse(rejectedError.stdout);
    assert.equal(payload.code, 'needs_approval');
    assert.ok(payload.turnId, '失败回执包含 turnId');

    const writeRepository = new SqliteConversationRepository(database.db);
    const approvals = await writeRepository.listToolApprovalsByTurn({ workspaceId: 'local', subjectUserId: 'local' }, payload.turnId);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].state, 'pending');

    const writeExecutions = await writeRepository.listToolExecutionsByTurn({ workspaceId: 'local', subjectUserId: 'local' }, payload.turnId);
    assert.equal(writeExecutions.length, 1);
    assert.equal(writeExecutions[0].status, 'pending_approval');
  } finally {
    await app?.close(); database?.client.close();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(temporary, { recursive: true, force: true });
  }
});

