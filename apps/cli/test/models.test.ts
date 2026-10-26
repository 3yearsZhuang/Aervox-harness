import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { runCli } from '../src/cli.js';

const FILE_KEY = 'sk-file-canary';
const ENV_KEY = 'sk-environment-canary';
const RESPONSE_KEY = 'sk-response-canary';
const secretUrl = 'https://user-canary:password-canary@provider.invalid/v1?query-canary#fragment-canary';
const config = { enabled: true, providerType: 'openai', baseUrl: secretUrl, apiKey: RESPONSE_KEY,
  modelId: 'model-id', temperature: 0.7, maxTokens: 4096, settings: { raw: 'settings-canary' } };
const preset = { ...config, id: 'preset_1', name: '日常模型', isActive: true };
let dir: string;
let base: string;
let server: ReturnType<typeof createServer>;
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;
let requests: { method?: string; url?: string; auth?: string; body: string }[];
const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'siyu-models-'));
  requests = [];
  handler = (req, res) => {
    if (req.url === '/v1/llm/providers') json(res, { generation: 2, providers: [{
      id: 'openai', name: 'name-canary', description: 'description-canary', protocol: 'openai-compat',
      defaultBaseUrl: secretUrl, recommendedModels: ['recommended-canary'], requiresApiKey: true,
      isLocal: false, available: true, unavailableReason: 'reason-canary',
    }] });
    else if (req.url === '/v1/llm/test-connection') json(res, { ok: true, latencyMs: 10,
      message: 'server-message-canary', availableModels: ['available-canary'], capabilities: { contextWindow: 8192, supportsToolCalls: true } });
    else if (req.url === '/v1/llm/presets' && req.method === 'GET') json(res, { presets: [preset], activeId: preset.id });
    else if (req.url === '/v1/llm/presets') json(res, preset, 201);
    else if (req.method === 'DELETE') json(res, { deleted: true, presetId: preset.id });
    else if (req.url?.endsWith('/activate')) json(res, preset);
    else json(res, config);
  };
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    handler(req, res, body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

async function invoke(args: string[], mode = 'json', env: NodeJS.ProcessEnv = {}) {
  let stdout = ''; let stderr = '';
  const code = await runCli(['models', ...args, ...(mode === 'text' ? [] : [`--${mode}`])], {
    input: Readable.from([]),
    output: Object.assign(new Writable({ write(chunk, _enc, done) { stdout += chunk; done(); } }), { isTTY: true, columns: 80 }),
    error: Object.assign(new Writable({ write(chunk, _enc, done) { stderr += chunk; done(); } }), { isTTY: true, columns: 80 }),
    env: { SIYU_CONFIG_FILE: join(dir, 'cli.json'), SIYU_API_URL: base, SIYU_API_TOKEN: 'local-auth-canary', ...env },
  });
  return { code, stdout, stderr };
}
async function inputFile(value: unknown = { ...config, apiKey: FILE_KEY }) {
  const file = join(dir, 'model.json'); await writeFile(file, JSON.stringify(value)); return file;
}
function expectSafe(result: { stdout: string; stderr: string }) {
  expect(result.stdout + result.stderr).not.toMatch(/sk-file-canary|sk-environment-canary|sk-response-canary|local-auth-canary|user-canary|password-canary|query-canary|fragment-canary|settings-canary|server-message-canary|available-canary|recommended-canary|description-canary|reason-canary|name-canary/);
  expect(result.stdout + result.stderr).not.toMatch(/"apiKey"\s*:|"settings"\s*:/);
}

describe('model configuration CLI', () => {
  it.each(['text', 'json', 'jsonl'])('shows a whitelisted configuration in %s without credentials or URL secrets', async mode => {
    const result = await invoke(['config', 'show'], mode, { SIYU_MODEL_API_KEY: ENV_KEY });
    expect(result.code).toBe(0); expectSafe(result);
    expect(JSON.parse(result.stdout)).toEqual({ version: 1, data: {
      enabled: true, providerType: 'openai', baseUrl: 'https://provider.invalid/v1', modelId: 'model-id',
      temperature: 0.7, maxTokens: 4096, apiKeyConfigured: true,
    } });
    expect(requests).toEqual([{ method: 'GET', url: '/v1/llm/config', auth: 'Bearer local-auth-canary', body: '' }]);
    await expect(stat(join(dir, 'cli.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lists capabilities without free-form provider descriptions, diagnostics or model recommendations', async () => {
    const result = await invoke(['providers']);
    expect(result.code).toBe(0); expectSafe(result);
    expect(JSON.parse(result.stdout).data).toEqual({ generation: 2, providers: [{ id: 'openai',
      protocol: 'openai-compat', defaultBaseUrl: 'https://provider.invalid/v1',
      requiresApiKey: true, isLocal: false, available: true,
    }] });
    expect(requests.map(req => req.url)).toEqual(['/v1/llm/providers']);
  });

  it('saves one explicit file request with an optional environment key override and never persists a CLI secret', async () => {
    const file = await inputFile();
    const result = await invoke(['config', 'set', '--file', file], 'json', { SIYU_MODEL_API_KEY: ENV_KEY });
    expect(result.code).toBe(0); expectSafe(result);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ apiKey: ENV_KEY, modelId: 'model-id' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'PUT', url: '/v1/llm/config' });
    expect(JSON.parse(result.stdout).data).toMatchObject({ saved: true, apiKeyConfigured: true });
    await expect(stat(join(dir, 'cli.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(dir, 'cli.json.last-run'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([true, false])('reports connection success=%s without saving input, echoing messages or raw model names', async ok => {
    handler = (_req, res) => json(res, { ok, latencyMs: 12, message: 'server-message-canary',
      availableModels: ['available-canary'], capabilities: { contextWindow: 8192, supportsToolCalls: true } });
    const result = await invoke(['test', '--file', await inputFile({ providerType: 'openai', baseUrl: secretUrl, modelId: 'model-id', apiKey: FILE_KEY })]);
    expect(result.code).toBe(ok ? 0 : 1); expectSafe(result);
    expect(JSON.parse(result.stdout).data).toEqual({ ok, latencyMs: 12, availableModelCount: 1,
      capabilities: { contextWindow: 8192, supportsToolCalls: true } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/v1/llm/test-connection' });
    expect(JSON.parse(requests[0]!.body).apiKey).toBe(FILE_KEY);
  });

  it('lists, creates, activates and deletes presets using bounded, redacted summaries', async () => {
    const file = await inputFile();
    for (const args of [['presets', 'list'], ['presets', 'create', '日常模型', '--file', file], ['presets', 'activate', preset.id], ['presets', 'delete', preset.id]]) {
      const result = await invoke(args); expect(result.code).toBe(0); expectSafe(result);
      expect(result.stdout).toContain('preset_1');
    }
    expect(requests.map(req => [req.method, req.url])).toEqual([
      ['GET', '/v1/llm/presets'], ['POST', '/v1/llm/presets'],
      ['POST', '/v1/llm/presets/preset_1/activate'], ['DELETE', '/v1/llm/presets/preset_1'],
    ]);
    expect(JSON.parse(requests[1]!.body)).toMatchObject({ name: '日常模型', config: { apiKey: FILE_KEY } });
  });

  it('redacts keys from every preset and treats URL-like labels as URLs', async () => {
    handler = (_req, res) => json(res, { activeId: preset.id, presets: [
      { ...preset, name: FILE_KEY, apiKey: RESPONSE_KEY,
        modelId: 'https://user-canary:password-canary@model.invalid/name?query-canary#fragment-canary' },
      { ...preset, id: 'preset_2', apiKey: FILE_KEY },
    ] });
    const result = await invoke(['presets', 'list']); expect(result.code).toBe(0); expectSafe(result);
    expect(JSON.parse(result.stdout).data.presets[0]).toMatchObject({ name: '[redacted]', modelId: 'https://model.invalid/name' });
  });

  it.each(['sk%2fencoded-canary', 'sk%252fencoded-canary', 'sk%25252Fencoded-canary'])(
    'redacts mixed-case and repeatedly encoded key paths: %s', async encodedKey => {
      handler = (_req, res) => json(res, { ...config, apiKey: 'sk/encoded-canary',
        baseUrl: `https://provider.invalid/v1/${encodedKey}` });
      const result = await invoke(['config', 'show']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).data.baseUrl).toBe('https://provider.invalid/[redacted]');
      expect(result.stdout + result.stderr).not.toContain('encoded-canary');
    },
  );

  it.each(['s%6b-key-canary', 's%256b-key-canary', `s%${'25'.repeat(10)}6b-key-canary`])(
    'redacts encoded unreserved ASCII and deep percent layers: %s', async encodedKey => {
      handler = (_req, res) => json(res, { ...config, apiKey: 'sk-key-canary',
        baseUrl: `https://provider.invalid/v1/%zz/${encodedKey}` });
      const result = await invoke(['config', 'show']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).data.baseUrl).toBe('https://provider.invalid/[redacted]');
      expect(result.stdout + result.stderr).not.toContain('key-canary');
    },
  );

  it('preserves unrelated case-sensitive text and malformed percent sequences', async () => {
    handler = (_req, res) => json(res, { ...config, apiKey: 'sk/%literal',
      baseUrl: 'https://provider.invalid/v1/SK%2fliteral/%zz' });
    const result = await invoke(['config', 'show']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.baseUrl).toBe('https://provider.invalid/v1/SK%2fliteral/%zz');
  });

  it('redacts literal-percent keys without decoding malformed unrelated escapes', async () => {
    handler = (_req, res) => json(res, { ...config, apiKey: 'sk/%literal',
      baseUrl: 'https://provider.invalid/v1/%zz/sk%252f%2525literal' });
    const result = await invoke(['config', 'show']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.baseUrl).toBe('https://provider.invalid/[redacted]');
  });

  it('redacts encoded keys from non-URL preset names and model identifiers', async () => {
    handler = (_req, res) => json(res, { activeId: preset.id, presets: [{ ...preset,
      apiKey: 'sk-key-canary', modelId: 's%6b-key-canary',
      name: `daily-s%${'25'.repeat(10)}6b-key-canary-model`,
    }] });
    const result = await invoke(['presets', 'list']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.presets[0]).toMatchObject({ name: '[redacted]', modelId: '[redacted]' });
    expect(result.stdout + result.stderr).not.toContain('key-canary');
  });

  it.each(['activate', 'delete'])('does not report a successful %s when the response reports no change', async operation => {
    handler = (_req, res) => json(res, operation === 'activate' ? { ...preset, isActive: false } : { deleted: false, presetId: preset.id });
    const result = await invoke(['presets', operation, preset.id]);
    expect(result.code).toBe(1); expectSafe(result); expect(requests).toHaveLength(1);
    expect(JSON.parse(result.stdout).data).toMatchObject(operation === 'activate' ? { activated: false } : { deleted: false });
  });

  it.each([
    ['config', 'set'], ['test'], ['presets', 'create', 'name'], ['providers', 'extra'],
    ['presets', 'activate', '../bad'], ['presets', 'delete'], ['config', 'show', '--file', 'ignored.json'],
    ['providers', '--file', 'ignored.json'], ['providers', '--request-id', 'forbidden'],
    ['config', 'set', '--api-key', 'sk-file-canary'],
  ])('rejects malformed command %j before HTTP', async (...args) => {
    const result = await invoke(args); expect(result.code).toBe(2); expectSafe(result); expect(requests).toHaveLength(0);
  });

  it.each([null, [], {}, { ...config, modelId: '  ' }, { ...config, temperature: 3 }])('rejects invalid shared configuration before HTTP: %j', async value => {
    const result = await invoke(['config', 'set', '--file', await inputFile(value)]);
    expect(result.code).toBe(2); expectSafe(result); expect(requests).toHaveLength(0);
  });

  it('bounds file reads and keeps file syntax/path errors private', async () => {
    const file = join(dir, 'model.json');
    for (const contents of ['{"apiKey":"sk-file-canary",', 'x'.repeat(65_537)]) {
      await writeFile(file, contents);
      const result = await invoke(['config', 'set', '--file', file]); expect(result.code).toBe(2); expectSafe(result);
    }
    const absent = await invoke(['config', 'set', '--file', join(dir, 'sk-file-canary')]);
    expect(absent.code).toBe(2); expectSafe(absent); expect(requests).toHaveLength(0);
  });

  it.each([400, 401, 403, 500])('keeps status %s errors generic without echoing server data', async status => {
    handler = (_req, res) => json(res, { message: `server-message-canary ${secretUrl} ${RESPONSE_KEY}` }, status);
    const result = await invoke(['config', 'show']); expect(result.code).toBe([401, 403].includes(status) ? 3 : 1); expectSafe(result);
    expect(JSON.parse(result.stdout).code).toBe([401, 403].includes(status) ? 'authentication' : 'request_failed');
  });

  it('preserves timeout classification without retries or config writes', async () => {
    handler = () => {};
    const result = await invoke(['config', 'show', '--timeout', '1000']); expect(result.code).toBe(5); expectSafe(result);
    expect(JSON.parse(result.stdout).code).toBe('timeout_unknown'); expect(requests).toHaveLength(1);
  });
});
