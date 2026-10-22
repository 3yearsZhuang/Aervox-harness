import { CliError } from '../config.js';
import { write } from '../output.js';
import { createTerminalStyle } from '../terminal.js';
import type { CommandContext } from './types.js';

function pageInteger(value: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CliError('usage', `${name} 必须为 ${min}～${max} 的十进制整数。`, 2);
  }
  return parsed;
}

export async function executeSessions(ctx: CommandContext): Promise<number> {
  const { positionals, options, transport, timedSignal, output, track, io } = ctx;
  const rest = positionals.slice(1);
  if (rest.length !== 1 || rest[0] !== 'list') {
    throw new CliError('usage', '使用 sessions list [--limit 1～100] [--offset 非负整数]。', 2);
  }
  const limit = pageInteger(options.limit, 100, '--limit', 1, 100);
  const offset = pageInteger(options.offset, 0, '--offset', 0, Number.MAX_SAFE_INTEGER);
  const query = new URLSearchParams({ limit: String(limit) });
  if (options.offset !== undefined) query.set('offset', String(offset));
  const signal = timedSignal();
  track.currentSignal = signal;
  const result = await transport.request<{ items: { id: string; title?: string; updatedAt?: string }[] }>('GET', `/v1/sessions?${query}`, undefined, { signal });
  if (!result || !Array.isArray(result.items) || result.items.length > limit) {
    throw new CliError('protocol', '服务返回的会话格式不兼容。');
  }

  if (result.items.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string'
    || (item.title !== undefined && typeof item.title !== 'string')
    || (item.updatedAt !== undefined && typeof item.updatedAt !== 'string'))) {
    throw new CliError('protocol', '服务返回的会话格式不兼容。');
  }

  if (output.mode === 'text' && io.output.isTTY) {
    const style = createTerminalStyle(io.env);
    const cyan = (s: string) => style(s, '36');
    const dim = (s: string) => style(s, '2');
    const bold = (s: string) => style(s, '1');

    if (result.items.length === 0) {
      const message = offset === 0
        ? '暂无会话记录。运行 siyu chat 开始新对话。'
        : `此页无会话（offset=${offset}）。可减小 --offset 查看前页。`;
      await write(io.output, `\n${dim(message)}\n\n`);
      return 0;
    }

    const lines = [
      '',
      bold(`本页会话 (${result.items.length} 个，limit=${limit}，offset=${offset}):`),
      ...result.items.map((item) => {
        const title = item.title ? ` ${dim(`"${item.title}"`)}` : '';
        const time = item.updatedAt ? ` ${dim(`(${new Date(item.updatedAt).toLocaleString()})`)}` : '';
        return `  • ${cyan(item.id)}${title}${time}`;
      }),
    ];
    if (result.items.length === limit && Number.isSafeInteger(offset + limit)) {
      lines.push('', dim(`继续查看可使用 --limit ${limit} --offset ${offset + limit}；下一页可能为空。`));
    }
    lines.push('');
    await write(io.output, lines.join('\n'));
    return 0;
  }

  await output.value(result);
  return 0;
}

export async function executeDoctor(ctx: CommandContext): Promise<number> {
  const { positionals, transport, timedSignal, output, apiBase, token, track, io } = ctx;
  const rest = positionals.slice(1);
  if (rest.length) {
    throw new CliError('usage', '使用 doctor。', 2);
  }
  const signal = timedSignal();
  track.currentSignal = signal;
  const result = await transport.request<{ items: unknown[] }>('GET', '/v1/sessions?limit=100', undefined, { signal });
  if (!result || !Array.isArray(result.items)) {
    throw new CliError('protocol', '服务返回的会话格式不兼容。');
  }
  const payload = {
    connected: true,
    apiBase,
    authentication: token ? 'token' : 'server-policy',
    sessionsEndpoint: true,
    cliVersion: '0.1.0',
  };

  if (output.mode === 'text' && io.output.isTTY) {
    const style = createTerminalStyle(io.env);
    const green = (s: string) => style(s, '1;32');
    const cyan = (s: string) => style(s, '36');
    const report = [
      '',
      `${green('✓')} ${cyan('思隅 本机服务连接正常')}`,
      `  • 服务地址: ${apiBase}`,
      `  • 会话接口: 正常 (HTTP 200)`,
      `  • 认证方式: ${token ? 'Token' : '本机策略 (server-policy)'}`,
      `  • 客户端:   v0.1.0`,
      '',
    ].join('\n');
    await write(io.output, report);
    return 0;
  }

  await output.value(payload);
  return 0;
}
