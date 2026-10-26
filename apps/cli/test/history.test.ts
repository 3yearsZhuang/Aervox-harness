import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { runCli } from '../src/cli.js';

let directory: string;
let base: string;
let server: ReturnType<typeof createServer>;
let handler: (response: ServerResponse) => void;
let requests: { method?: string; url?: string; auth?: string }[];
const page = () => ({ sessionId: 'session', items: [{ turnId: 'turn', status: 'Interrupted', isComplete: false,
  createdAt: '2026-10-26T00:00:00Z', messages: [
    { messageId: 'user', versionId: 'user', version: 1, role: 'user', contentKind: 'accepted_input', content: 'accepted question', visibility: 'available', legacy: false, readOnly: false, createdAt: '2026-10-26T00:00:00Z' },
    { messageId: 'assistant', versionId: 'version', version: 3, role: 'assistant', contentKind: 'message', content: 'saved prefix' as string | null, visibility: 'available', legacy: false, readOnly: false, createdAt: '2026-10-26T00:00:00Z' },
  ] }], nextCursor: 'eyJ2IjoxfQ' });
const send = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'siyu-history-')); requests = [];
  handler = response => send(response, page());
  server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, auth: request.headers.authorization });
    handler(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

async function invoke(args: string[], mode = 'json', signal?: AbortSignal) {
  let stdout = ''; let stderr = '';
  const code = await runCli(args.concat(mode === 'text' ? [] : [`--${mode}`]), {
    input: Readable.from([]),
    output: Object.assign(new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }), { isTTY: true }),
    error: new Writable({ write(chunk, _encoding, done) { stderr += chunk; done(); } }),
    env: { SIYU_CONFIG_FILE: join(directory, 'cli.json'), SIYU_API_URL: base, SIYU_API_TOKEN: 'auth-canary' }, signal,
  });
  return { code, stdout, stderr };
}

describe('read-only session history CLI', () => {
  it.each(['中文/会话', '中'.repeat(128), '会话\u001b]52;c;private\u0007'])('reads shared-contract session identities through an encoded path', async sessionId => {
    handler = response => send(response, { ...page(), sessionId });
    const result = await invoke(['sessions', 'history', sessionId], 'text');
    expect(result.code).toBe(0);
    expect(requests[0]?.url).toBe(`/v1/sessions/${encodeURIComponent(sessionId)}/history?limit=20`);
    expect(result.stdout).not.toMatch(/\u001b|52;c;private/);
  });
  it.each(['json', 'jsonl'])('reads only the explicit page in %s and preserves the shared DTO', async mode => {
    const result = await invoke(['sessions', 'history', 'session', '--limit', '2', '--cursor', 'eyJ2IjoxfQ'], mode);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: 1, data: page() });
    expect(requests).toEqual([{ method: 'GET', url: '/v1/sessions/session/history?limit=2&cursor=eyJ2IjoxfQ', auth: 'Bearer auth-canary' }]);
    expect(result.stdout + result.stderr).not.toContain('auth-canary');
  });
  it('distinguishes effective input, incomplete prefix and withheld records while stripping terminal controls', async () => {
    const value = page();
    value.items[0]!.messages[1]!.content = 'saved\u001b]52;c;private\u0007 prefix';
    value.items[0]!.messages.push({ ...value.items[0]!.messages[1]!, versionId: 'withheld', content: null, visibility: 'withheld', readOnly: true });
    handler = response => send(response, value);
    const result = await invoke(['sessions', 'history', 'session'], 'text');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('本轮输入'); expect(result.stdout).toContain('未完成');
    expect(result.stdout).toContain('这条记录当前不可显示');
    expect(result.stdout).toContain('--cursor eyJ2IjoxfQ');
    expect(result.stdout).not.toMatch(/\u001b|52;c;private|auth-canary/);
    expect(requests).toHaveLength(1);
  });
  it.each([
    ['sessions', 'history'], ['sessions', 'history', 'session', '--limit', '51'],
    ['sessions', 'history', '中'.repeat(129)],
    ['sessions', 'history', 'session', '--limit', '2x'], ['sessions', 'history', 'session', '--offset', '1'],
    ['sessions', 'list', '--cursor', 'token'], ['doctor', '--cursor', 'token'],
  ])('rejects incompatible flags or invalid limits before contacting the service: %s', async (...args) => {
    expect((await invoke(args)).code).toBe(2); expect(requests).toEqual([]);
  });
  it.each([[410, 'HISTORY_CURSOR_EXPIRED', 'history_cursor_expired'], [422, 'HISTORY_ITEM_TOO_LARGE', 'history_limit']])('reports HTTP %s without retry or server diagnostics', async (status, code, expected) => {
    handler = response => send(response, { code, message: 'private-server-canary' }, status as number);
    const result = await invoke(['sessions', 'history', 'session']);
    expect(result.code).toBe(1); expect(JSON.parse(result.stdout).code).toBe(expected);
    expect(result.stdout + result.stderr).not.toContain('private-server-canary'); expect(requests).toHaveLength(1);
  });
  it('rejects a malformed withheld response and never outputs its hidden body', async () => {
    const value = page(); value.items[0]!.messages[1]!.visibility = 'withheld';
    value.items[0]!.messages[1]!.content = 'hidden-body-canary';
    handler = response => send(response, value);
    const result = await invoke(['sessions', 'history', 'session']);
    expect(result.code).toBe(1); expect(result.stdout + result.stderr).not.toContain('hidden-body-canary'); expect(requests).toHaveLength(1);
  });
  it('interruption releases the read without cancelling or submitting a Turn', async () => {
    const controller = new AbortController();
    handler = () => { controller.abort('SIGINT'); };
    const result = await invoke(['sessions', 'history', 'session'], 'json', controller.signal);
    expect(result.code).toBe(130); expect(requests).toHaveLength(1); expect(requests[0]?.method).toBe('GET');
  });
});
