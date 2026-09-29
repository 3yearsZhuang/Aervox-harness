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

  it('对话命令留在本地，多行合为一轮，新会话不覆盖旧会话', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const lines = ['/help', '/session', '/unknown', '第一行\\', '第二行', '/session', '/new', '//literal', '/exit'];
    const r = await invoke(['chat', '--session', 'old_session'], { input,
      onErrorText(text) { if (text.includes('❯ ') || text.includes('  · ')) setImmediate(() => input.write(lines.shift() + '\n')); },
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
