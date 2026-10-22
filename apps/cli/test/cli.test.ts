import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { runCli, type CliIO } from '../src/cli.js';
import { write } from '../src/output.js';
import { stripVTControlCharacters } from 'node:util';

let dir: string;
let base: string;
let server: ReturnType<typeof createServer>;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let requests: { method?: string; url?: string; auth?: string; key?: string; body: string }[];
const event = (sequence: number, eventType: string, data: unknown) =>
  `data: ${JSON.stringify({ eventId: `e${sequence}`, turnId: 'turn_1', sequence, eventType, data })}\n\n`;
const done = (status = 'Completed') => event(3, 'done', { status, isComplete: true, lastSequence: 3 });
const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
};
const normal = (req: IncomingMessage, res: ServerResponse) => {
  if (req.url?.endsWith('/turns')) json(res, { turnId: 'turn_1' }, 201);
  else if (req.url?.endsWith('/events')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(event(1, 'delta', { text: '答案' }) + event(2, 'delta', { text: '\u001b[31m安全\u001b[0m\u001b]52;c;secret\u0007' }) + done());
  } else if (req.url?.startsWith('/v1/sessions?')) json(res, { items: [{ id: 'session' }] });
  else json(res, { accepted: true });
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'siyu-cli-'));
  requests = []; handler = normal;
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, key: req.headers['idempotency-key'] as string, body });
    handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

async function invoke(args: string[], options: { input?: CliIO['input']; signal?: AbortSignal; env?: NodeJS.ProcessEnv; ttyOutput?: boolean; onErrorText?: (text: string) => void } = {}) {
  let stdout = ''; let stderr = '';
  const code = await runCli(args, {
    input: options.input ?? Readable.from([]),
    output: Object.assign(new Writable({ write(chunk, _enc, cb) { stdout += chunk; cb(); } }), { isTTY: options.ttyOutput, columns: 80 }),
    error: Object.assign(new Writable({ write(chunk, _enc, cb) { stderr += chunk; options.onErrorText?.(String(chunk)); cb(); } }), { isTTY: options.ttyOutput, columns: 80 }),
    env: { SIYU_CONFIG_FILE: join(dir, 'config.json'), SIYU_API_URL: base, SIYU_API_TOKEN: 'test-token', ...options.env },
    signal: options.signal,
  });
  return { code, stdout, stderr };
}

describe('连接版命令合同', () => {
  it.each(['sessions', 'doctor', 'config'])('TTY 人类可读呈现不改变 %s 的 JSON/JSONL 协议', async command => {
    const args = command === 'sessions' ? ['sessions', 'list'] : command === 'config' ? ['config', 'show'] : ['doctor'];
    const human = await invoke(args, { ttyOutput: true });
    expect(human.code).toBe(0);
    expect(human.stdout).not.toContain('"version"');
    expect(human.stdout).not.toContain('test-token');
    for (const mode of ['json', 'jsonl']) {
      const machine = await invoke([...args, `--${mode}`], { ttyOutput: true });
      expect(machine.code).toBe(0);
      expect(JSON.parse(machine.stdout)).toMatchObject({ version: 1, data: expect.any(Object) });
      expect(machine.stdout).not.toContain('\x1b');
    }
  });

  it.each([{}, { NO_COLOR: '1' }, { TERM: 'dumb' }])('TTY 会话列表清理服务端控制序列和换行：%j', async env => {
    handler = (_req, res) => json(res, { items: [{
      id: 'session\x1b]52;c;secret\x07', title: '正常\x1b[31m标题\x1b[0m\n伪造行',
    }] });
    const result = await invoke(['sessions', 'list'], { ttyOutput: true, env });
    expect(result.code).toBe(0);
    const rendered = stripVTControlCharacters(result.stdout);
    expect(rendered).toContain('session "正常标题 伪造行"');
    expect(result.stdout).not.toMatch(/\x1b\]|secret|\n伪造行/);
    if ('NO_COLOR' in env || env.TERM === 'dumb') expect(result.stdout).not.toContain('\x1b');
  });

  it('TTY 展示完整本页，机器输出保持原信封，空列表清楚呈现', async () => {
    const items = Array.from({ length: 35 }, (_, index) => ({ id: `session_${index}` }));
    handler = (_req, res) => json(res, { items });
    const human = await invoke(['sessions', 'list'], { ttyOutput: true, env: { NO_COLOR: '1' } });
    expect(human.stdout).toContain('本页会话 (35 个，limit=100，offset=0)');
    expect(human.stdout).toContain('session_34');
    expect(human.stdout).not.toContain('继续查看');
    expect(JSON.parse((await invoke(['sessions', 'list', '--json'], { ttyOutput: true })).stdout).data.items).toHaveLength(35);
    handler = (_req, res) => json(res, { items: [] });
    expect((await invoke(['sessions', 'list'], { ttyOutput: true })).stdout).toContain('暂无会话记录');
  });

  it.each(['text', 'json', 'jsonl'])('会话分页只读一页并保留认证和机器协议：%s', async mode => {
    const items = [{ id: 'page_100' }, { id: 'page_101', title: '第二页' }];
    handler = (_req, res) => json(res, { items });
    const result = await invoke(['sessions', 'list', '--limit', '2', '--offset', '100',
      ...(mode === 'text' ? [] : [`--${mode}`])], { ttyOutput: true, env: { NO_COLOR: '1' } });
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: 'GET', url: '/v1/sessions?limit=2&offset=100', auth: 'Bearer test-token', key: undefined, body: '' }]);
    expect(result.stderr).toBe('');
    if (mode === 'text') {
      expect(result.stdout).toContain('本页会话 (2 个，limit=2，offset=100)');
      expect(result.stdout).toContain('page_101');
      expect(result.stdout).toContain('--limit 2 --offset 102');
      expect(result.stdout).toContain('下一页可能为空');
      expect(result.stdout).not.toContain('共');
    } else {
      expect(JSON.parse(result.stdout)).toEqual({ version: 1, data: { items } });
      expect(result.stdout).not.toContain('\x1b');
    }
  });

  it('默认请求兼容；只指定 offset 或 limit 时保留其它默认值，重定向仍是 JSON', async () => {
    for (const args of [[], ['--offset', '100'], ['--limit', '1'], ['--offset', '0']]) {
      const result = await invoke(['sessions', 'list', ...args]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ version: 1, data: { items: [{ id: 'session' }] } });
    }
    expect(requests.map(request => request.url)).toEqual([
      '/v1/sessions?limit=100', '/v1/sessions?limit=100&offset=100',
      '/v1/sessions?limit=1', '/v1/sessions?limit=100&offset=0',
    ]);
  });

  it('空的后续页不宣称全库为空，也不触发继续查询', async () => {
    handler = (_req, res) => json(res, { items: [] });
    const result = await invoke(['sessions', 'list', '--offset', '100'], { ttyOutput: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('此页无会话（offset=100）');
    expect(result.stdout).not.toMatch(/暂无会话记录|继续查看/);
    expect(requests).toHaveLength(1);
  });

  it('最大安全整数 offset 不产生溢出的翻页提示', async () => {
    const result = await invoke(['sessions', 'list', '--limit', '1', '--offset', String(Number.MAX_SAFE_INTEGER)], { ttyOutput: true });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('继续查看');
    expect(requests[0]?.url).toBe(`/v1/sessions?limit=1&offset=${Number.MAX_SAFE_INTEGER}`);
  });

  it.each([
    ['--limit', '0'], ['--limit', '101'], ['--limit', '-1'], ['--limit', '1.5'],
    ['--limit', '1e2'], ['--limit', '0x10'], ['--limit', ' 2'], ['--limit', '2x'], ['--limit', ''],
    ['--offset', '-1'], ['--offset', '0.5'], ['--offset', '1e2'], ['--offset', '+1'],
    ['--offset', 'NaN'], ['--offset', 'Infinity'], ['--offset', '9007199254740992'], ['--offset', ''],
  ])('分页参数 %s=%s 在发送 HTTP 前拒绝', async (option, value) => {
    const result = await invoke(['sessions', 'list', `${option}=${value}`, '--json']);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).code).toBe('usage');
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['doctor', '--limit', '1'], ['config', 'show', '--offset', '0'],
    ['ask', 'hello', '--limit', '2'], ['chat', '--offset', '10'],
    ['events', 'turn_1', '--limit', '1'], ['status', 'turn_1', '--offset', '0'],
    ['sessions', 'show', '--offset', '0'], ['sessions', 'list', 'extra', '--limit', '1'],
  ])('不适用的分页参数不能被静默忽略：%j', async (...args) => {
    const result = await invoke([...args, '--json']);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).code).toBe('usage');
    expect(requests).toHaveLength(0);
  });

  it('服务端忽略 limit 时拒绝超额页', async () => {
    handler = (_req, res) => json(res, { items: [{ id: 'a' }, { id: 'b' }] });
    const result = await invoke(['sessions', 'list', '--limit', '1', '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe('protocol');
    expect(result.stdout).not.toContain('"items"');
  });

  it.each([null, {}, { items: [null] }, { items: [{ id: 3 }] }, { items: [{ id: 'session', title: {} }] }])('不兼容的会话响应有明确协议错误：%j', async payload => {
    handler = (_req, res) => json(res, payload);
    const result = await invoke(['sessions', 'list', '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'protocol' });
  });

  it.each(['text', 'json', 'jsonl'])('正文、控制字符、认证、幂等回执：%s', async mode => {
    const r = await invoke(['ask', 'hello', '--session', 'session', '--request-id', 'request_1', ...(mode === 'text' ? [] : [`--${mode}`])]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/\u001b|test-token|secret/);
    expect(r.stderr).not.toContain('test-token');
    if (mode === 'text') expect(r.stdout).toBe('答案安全\n');
    if (mode === 'json') expect(JSON.parse(r.stdout)).toMatchObject({ version: 1, ok: true, text: '答案安全', turnId: 'turn_1' });
    if (mode === 'jsonl') expect(r.stdout.trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['submitted', 'accepted', 'delta', 'delta', 'result']);
    expect(requests.every(r => r.auth === 'Bearer test-token')).toBe(true);
    expect(requests[0]?.key).toBe('request_1');
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ toolApprovalMode: 'ask', message: { content: 'hello' } });
    const receipt = await readFile(join(dir, 'config.json.last-run'), 'utf8');
    expect(JSON.parse(receipt)).toMatchObject({ sessionId: 'session', requestId: 'request_1', turnId: 'turn_1' });
    expect(receipt).not.toMatch(/hello|test-token/);
    if (process.platform !== 'win32') expect((await stat(join(dir, 'config.json.last-run'))).mode & 0o777).toBe(0o600);
  });

  it('stdin 和显式文件输入，超额内容不发送', async () => {
    expect((await invoke(['ask', '--json'], { input: Readable.from(['管道问题']) })).code).toBe(0);
    expect(JSON.parse(requests[0]!.body).message.content).toBe('管道问题');
    const file = join(dir, 'question.txt'); await writeFile(file, '文件问题');
    expect((await invoke(['ask', '--file', file, '--json'])).code).toBe(0);
    const count = requests.length;
    expect((await invoke(['ask', '--json'], { input: Readable.from(['x'.repeat(65_537)]) })).code).toBe(2);
    expect(requests).toHaveLength(count);
  });

  it.each(['Failed', 'Cancelled', 'Unknown'])('终态 %s 不报成功', async status => {
    handler = (req, res) => req.url?.endsWith('/events') ? res.end(done(status)) : normal(req, res);
    const r = await invoke(['ask', 'hello', '--json']);
    expect(r.code).toBe(1); expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  it('认证错误不回显服务端敏感响应', async () => {
    handler = (_req, res) => json(res, { secret: 'do-not-echo' }, 401);
    const r = await invoke(['doctor', '--json']);
    expect(r.code).toBe(3); expect(r.stdout + r.stderr).not.toContain('do-not-echo');
  });

  it('非 TTY 写审批有界返回，绝不提交批准', async () => {
    handler = (req, res) => req.url?.endsWith('/events')
      ? res.end(event(1, 'tool_approval_required', { approvalId: 'approval_1', toolName: 'write_note', argumentsHash: 'hash' })) : normal(req, res);
    const r = await invoke(['ask', 'write', '--json']);
    expect(r.code).toBe(4); expect(JSON.parse(r.stdout).code).toBe('needs_approval');
    expect(requests.some(r => r.url?.endsWith('/tool-approvals'))).toBe(false);
  });

  it('TTY 批准只记录决定，不自动重发问题', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    handler = (req, res) => req.url?.endsWith('/events') ? res.end(event(1, 'tool_approval_required', { approvalId: 'approval_1', toolName: 'write_note', argumentsHash: 'hash' }) + done()) : normal(req, res);
    const r = await invoke(['ask', 'write', '--json'], { input, onErrorText(text) { if (text.includes('[y/N]')) setImmediate(() => input.write('y\n')); } });
    expect(r.code).toBe(4); expect(JSON.parse(r.stdout).code).toBe('approval_recorded');
    expect(requests.filter(r => r.url?.endsWith('/turns'))).toHaveLength(1);
    expect(JSON.parse(requests.find(r => r.url?.endsWith('/tool-approvals'))!.body)).toMatchObject({ decision: 'granted', approvalId: 'approval_1' });
    input.destroy();
  });

  it('TTY 用户问题提交后继续消费权威终态', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    handler = (req, res) => req.url?.endsWith('/events') ? res.end(event(1, 'user_question_required', { questions: [{ id: 'q1', question: '语言？' }] }) + done()) : normal(req, res);
    const r = await invoke(['ask', 'hello', '--json'], { input, onErrorText(text) { if (text.includes('回答 >')) setImmediate(() => input.write('TypeScript\n')); } });
    expect(r.code).toBe(0);
    expect(JSON.parse(requests.find(r => r.url?.endsWith('/questions/answers'))!.body)).toEqual({ answers: [{ id: 'q1', selected: [], custom: 'TypeScript' }] });
    input.destroy();
  });

  it('chat 连续两轮保持会话且每轮更换幂等键', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const lines = ['第一问', '第二问', '/exit'];
    const r = await invoke(['chat', '--session', 'chat_session'], { input, onErrorText(text) { if (text.includes('❯ ')) setImmediate(() => input.write(lines.shift() + '\n')); } });
    expect(r.code).toBe(0);
    const posts = requests.filter(r => r.url?.endsWith('/turns'));
    expect(posts).toHaveLength(2); expect(new Set(posts.map(p => p.key)).size).toBe(2);
    expect(posts.every(p => p.url === '/v1/sessions/chat_session/turns')).toBe(true);
    input.destroy();
  });

  it('TTY 呈现欢迎、回答与真实终态，日常对话不刷内部 JSON', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const lines = ['hello', '/exit'];
    const r = await invoke(['chat', '--session', 'pretty_session'], { input, ttyOutput: true,
      onErrorText(text) { if (text.includes('❯ ')) setImmediate(() => input.write(lines.shift() + '\n')); },
    });
    expect(r.code).toBe(0);
    const rendered = stripVTControlCharacters(r.stdout + r.stderr);
    expect(rendered).toContain('SIYU CLI 0.1.0');
    expect(rendered).toContain('● 思隅');
    expect(rendered).toContain('答案安全');
    expect(rendered).toContain('✓ 已完成');
    expect(rendered).not.toMatch(/"ok"|session=|request=|test-token|secret/);
    input.destroy();
  });

  it.each([false, true])('对话命令留在本地，多行合为一轮，新会话不覆盖旧会话（TTY 呈现 %s）', async ttyOutput => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const lines = ['/help', '/session', '/unknown', '第一行\\', '第二行', '/session', '/new', '//literal', '/exit'];
    const r = await invoke(['chat', '--session', 'old_session'], { input, ttyOutput, env: { NO_COLOR: '1' },
      onErrorText(text) { if (text === '❯ ' || text === '  · ') setImmediate(() => input.write(lines.shift() + '\n')); },
    });
    expect(r.code).toBe(0);
    const posts = requests.filter(r => r.url?.endsWith('/turns'));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.url).toContain('/old_session/');
    expect(JSON.parse(posts[0]!.body).message.content).toBe('第一行\n第二行');
    expect(posts[1]!.url).not.toContain('/old_session/');
    expect(JSON.parse(posts[1]!.body).message.content).toBe('/literal');
    expect(r.stderr).toContain('未知对话命令');
    expect(r.stderr).toContain('回合  turn_1');
    input.destroy();
  });

  it('TTY 的 JSONL 保持机器协议，无欢迎区和颜色混入', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const lines = ['hello', '/exit'];
    const r = await invoke(['chat', '--jsonl'], { input, ttyOutput: true,
      onErrorText(text) { if (text.includes('❯ ')) setImmediate(() => input.write(lines.shift() + '\n')); },
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['submitted', 'accepted', 'delta', 'delta', 'result']);
    expect(r.stderr).not.toContain('SIYU CLI');
    input.destroy();
  });

  it('真实 readline Ctrl-C 中断 TTY 回合并请求服务端取消', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    handler = (req, res) => {
      if (req.url?.endsWith('/events')) {
        res.writeHead(200); res.write(': heartbeat\n\n');
        setImmediate(() => input.write('\x03'));
      } else normal(req, res);
    };
    const r = await invoke(['chat'], { input, ttyOutput: true,
      onErrorText(text) { if (text.includes('❯ ')) setImmediate(() => input.write('hello\n')); },
    });
    expect(r.code).toBe(130);
    expect(r.stderr).toContain('已请求服务端取消');
    expect(requests.filter(r => r.url?.endsWith('/cancel'))).toHaveLength(1);
    expect(r.stderr).not.toContain('✓ 已完成');
    input.destroy();
  });

  it.each(['SIGINT', 'SIGTERM'])('%s 取消当前受理任务并报告请求状态', async reason => {
    const control = new AbortController();
    handler = (req, res) => {
      if (req.url?.endsWith('/events')) { res.writeHead(200); res.write(': heartbeat\n\n'); control.abort(reason); }
      else normal(req, res);
    };
    const r = await invoke(['ask', 'hello', '--json'], { signal: control.signal });
    expect(r.code).toBe(reason === 'SIGINT' ? 130 : 143);
    expect(JSON.parse(r.stdout)).toMatchObject({ turnId: 'turn_1', cancellation: 'requested' });
    expect(requests.filter(r => r.url?.endsWith('/cancel'))).toHaveLength(1);
  });

  it('查询旧任务超时不会取消它（全局选项在命令前）', async () => {
    handler = (_req, res) => { res.writeHead(200); res.write(': wait\n\n'); };
    const r = await invoke(['--json', 'status', 'turn_1', '--timeout', '1000']);
    expect(r.code).toBe(5); expect(requests.some(r => r.method === 'POST')).toBe(false);
  });

  it('超时属于状态未知：已受理回合不替用户取消，仅中断才取消', async () => {
    // CR-058 把服务端取消绑定在中断（Ctrl-C / SIGTERM / 断管）上；超时等失败路径下
    // 服务端回合可能仍在推进，客户端擅自取消会误杀用户的工作。此处断言 ownsTurn=true
    // 的超时路径不得发出 /cancel，且回执不虚报 cancellation。
    handler = (req, res) => {
      if (req.url?.endsWith('/turns')) json(res, { turnId: 'turn_1' }, 201);
      else if (req.url?.endsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': wait\n\n'); }
      else json(res, { accepted: true });
    };
    const r = await invoke(['ask', 'hello', '--json', '--timeout', '1000']);
    expect(r.code).toBe(5);
    expect(requests.filter(x => x.url?.endsWith('/cancel'))).toHaveLength(0);
    const payload = JSON.parse(r.stdout);
    expect(payload).toMatchObject({ turnId: 'turn_1' });
    expect(payload.cancellation).toBeUndefined();
  });

  it('events 补读与 status 不创建回合、不重复交互', async () => {
    const read = await invoke(['events', 'turn_1', '--json']);
    expect(JSON.parse(read.stdout).text).toBe('答案安全');
    const status = await invoke(['status', 'turn_1', '--json']);
    expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, text: '' });
    expect(requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('配置只存普通字段，参数优先，拒绝远程地址和无会话重试', async () => {
    expect((await invoke(['config', 'set', 'sessionId', 'saved_session'])).code).toBe(0);
    const show = await invoke(['config', 'show', '--session', 'flag_session', '--json']);
    expect(JSON.parse(show.stdout).data.sessionId).toBe('flag_session');
    expect(await readFile(join(dir, 'config.json'), 'utf8')).not.toContain('test-token');
    expect((await invoke(['doctor', '--api-base', 'https://example.com', '--json'])).code).toBe(2);
    expect((await invoke(['config', 'set', 'token', 'secret', '--json'])).code).toBe(2);
    await rm(join(dir, 'config.json'));
    expect((await invoke(['ask', 'hello', '--request-id', 'retry', '--json'])).code).toBe(2);
    expect(requests).toHaveLength(0);
  });

  it('慢消费者可被取消且等待不会无限增加缓冲', async () => {
    const control = new AbortController();
    const output = new Writable({ highWaterMark: 1, write() { control.abort(new Error('stop')); } });
    await expect(write(output, 'blocked', control.signal)).rejects.toThrow('stop');
    expect(output.writableLength).toBeLessThan(100); output.destroy();
  });

  it('TTY EOF 正常退出 chat，审批期间 EOF 返回需要交互', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    expect((await invoke(['chat'], { input, onErrorText(text) { if (text.includes('❯ ')) setImmediate(() => input.end()); } })).code).toBe(0);
    const approvalInput = Object.assign(new PassThrough(), { isTTY: true });
    handler = (req, res) => req.url?.endsWith('/events') ? res.end(event(1, 'tool_approval_required', { approvalId: 'a', toolName: 'write' })) : normal(req, res);
    const result = await invoke(['ask', 'write', '--json'], { input: approvalInput, onErrorText(text) { if (text.includes('[y/N]')) setImmediate(() => approvalInput.end()); } });
    expect(result.code).toBe(4);
    expect(requests.some(r => r.url?.endsWith('/tool-approvals'))).toBe(false);
  });

  it('超过正文限额停止消费，不把缺失完整标记的 Completed 报成成功', async () => {
    handler = (req, res) => req.url?.endsWith('/events') ? res.end(Array.from({ length: 5 }, (_, index) => event(index + 1, 'delta', { text: 'x'.repeat(500_000) })).join('')) : normal(req, res);
    const large = await invoke(['ask', 'large', '--json']);
    expect(large.code).toBe(1); expect(JSON.parse(large.stdout).code).toBe('output_limit');
    handler = (req, res) => req.url?.endsWith('/events') ? res.end(event(1, 'done', { status: 'Completed' })) : normal(req, res);
    expect((await invoke(['ask', 'incomplete', '--json'])).code).toBe(1);
  });
});
