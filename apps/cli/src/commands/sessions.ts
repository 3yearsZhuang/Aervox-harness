import { CliError } from '../config.js';
import type { CommandContext } from './types.js';

export async function executeSessions(ctx: CommandContext): Promise<number> {
  const { positionals, transport, timedSignal, output, track } = ctx;
  const rest = positionals.slice(1);
  if (rest.length !== 1 || rest[0] !== 'list') {
    throw new CliError('usage', '使用 sessions list。', 2);
  }
  const signal = timedSignal();
  track.currentSignal = signal;
  const result = await transport.request<{ items: unknown[] }>('GET', '/v1/sessions?limit=100', undefined, { signal });
  if (!Array.isArray(result.items)) {
    throw new CliError('protocol', '服务返回的会话格式不兼容。');
  }
  await output.value(result);
  return 0;
}

export async function executeDoctor(ctx: CommandContext): Promise<number> {
  const { positionals, transport, timedSignal, output, apiBase, token, track } = ctx;
  const rest = positionals.slice(1);
  if (rest.length) {
    throw new CliError('usage', '使用 doctor。', 2);
  }
  const signal = timedSignal();
  track.currentSignal = signal;
  const result = await transport.request<{ items: unknown[] }>('GET', '/v1/sessions?limit=100', undefined, { signal });
  if (!Array.isArray(result.items)) {
    throw new CliError('protocol', '服务返回的会话格式不兼容。');
  }
  await output.value({
    connected: true,
    apiBase,
    authentication: token ? 'token' : 'server-policy',
    sessionsEndpoint: true,
    cliVersion: '0.1.0',
  });
  return 0;
}
