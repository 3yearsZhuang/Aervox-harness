import { CliError } from '../config.js';
import { write } from '../output.js';
import { createTerminalStyle } from '../terminal.js';
import type { CommandContext } from './types.js';

export async function executeSessions(ctx: CommandContext): Promise<number> {
  const { positionals, transport, timedSignal, output, track, io } = ctx;
  const rest = positionals.slice(1);
  if (rest.length !== 1 || rest[0] !== 'list') {
    throw new CliError('usage', '使用 sessions list。', 2);
  }
  const signal = timedSignal();
  track.currentSignal = signal;
  const result = await transport.request<{ items: { id: string; title?: string; updatedAt?: string }[] }>('GET', '/v1/sessions?limit=100', undefined, { signal });
  if (!result || !Array.isArray(result.items)) {
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
      await write(io.output, `\n${dim('暂无会话记录。运行 siyu chat 开始新对话。')}\n\n`);
      return 0;
    }

    const lines = [
      '',
      bold(`最近会话 (共 ${result.items.length} 个):`),
      ...result.items.slice(0, 30).map((item) => {
        const title = item.title ? ` ${dim(`"${item.title}"`)}` : '';
        const time = item.updatedAt ? ` ${dim(`(${new Date(item.updatedAt).toLocaleString()})`)}` : '';
        return `  • ${cyan(item.id)}${title}${time}`;
      }),
    ];
    if (result.items.length > 30) {
      lines.push(dim(`  … 还有 ${result.items.length - 30} 个会话（可用 siyu sessions list --json 查看完整列表）`));
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
