import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export class CliError extends Error {
  constructor(public readonly code: string, message: string, public readonly exitCode = 1) {
    super(message);
  }
}

export interface Settings { apiBase?: string; sessionId?: string }
export function configPath(env: NodeJS.ProcessEnv): string {
  return env.SIYU_CONFIG_FILE
    ? resolve(env.SIYU_CONFIG_FILE)
    : join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'aervox', 'cli.json');
}

export function localApiBase(value: string): string {
  if (typeof value !== 'string') throw new CliError('invalid_config', 'API 地址必须为文本。', 2);
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError('invalid_config', 'API 地址无效。', 2); }
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new CliError('invalid_config', '连接版仅支持本机 HTTP(S) 根地址，地址中不能包含凭据。', 2);
  }
  return url.origin;
}

export function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new CliError('invalid_id', '标识只能包含字母、数字、下划线和连字符（最多 160 字符）。', 2);
  return value;
}

export async function readSettings(path: string): Promise<Settings> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > 16_384) throw new Error();
    const value = JSON.parse(text) as Settings;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !['apiBase', 'sessionId'].includes(key))) throw new Error();
    return {
      ...(value.apiBase === undefined ? {} : { apiBase: localApiBase(value.apiBase) }),
      ...(value.sessionId === undefined ? {} : { sessionId: identifier(value.sessionId) }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new CliError('invalid_config', '无法读取 CLI 配置；仅支持 apiBase 和 sessionId，不在此保存 Token。', 2);
  }
}

export async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
