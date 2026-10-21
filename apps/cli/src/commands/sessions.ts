import { CliError } from '../config.js';
import { write } from '../output.js';
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
  if (!Array.isArray(result.items)) {
    throw new CliError('protocol', '服务返回的会话格式不兼容。');
  }

  if (output.mode === 'text' && io.output.isTTY) {
    const isDark = io.env.TERM !== 'dumb' && !('NO_COLOR' in io.env);
    const cyan = (s: string) => (isDark ? `\x1b[36m${s}\x1b[0m` : s);
    const dim = (s: string) => (isDark ? `\x1b[2m${s}\x1b[0m` : s);
    const bold = (s: string) => (isDark ? `\x1b[1m${s}\x1b[0m` : s);

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
  if (!Array.isArray(result.items)) {
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
    const isDark = io.env.TERM !== 'dumb' && !('NO_COLOR' in io.env);
    const green = (s: string) => (isDark ? `\x1b[1;32m${s}\x1b[0m` : s);
    const cyan = (s: string) => (isDark ? `\x1b[36m${s}\x1b[0m` : s);
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
