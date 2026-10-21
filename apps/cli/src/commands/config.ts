import { CliError, identifier, localApiBase, saveJson } from '../config.js';
import { write } from '../output.js';
import type { CommandContext } from './types.js';

export async function executeConfig(ctx: CommandContext): Promise<number> {
  const { positionals, output, apiBase, token, path, settings, options, io } = ctx;
  const rest = positionals.slice(1);
  const activeSessionId = options.session ?? io.env.SIYU_SESSION_ID ?? settings.sessionId;

  if (rest[0] === 'show' && rest.length === 1) {
    if (output.mode === 'text' && io.output.isTTY) {
      const isDark = io.env.TERM !== 'dumb' && !('NO_COLOR' in io.env);
      const cyan = (s: string) => (isDark ? `\x1b[36m${s}\x1b[0m` : s);
      const dim = (s: string) => (isDark ? `\x1b[2m${s}\x1b[0m` : s);
      const bold = (s: string) => (isDark ? `\x1b[1m${s}\x1b[0m` : s);
      const text = [
        '',
        bold('思隅 CLI 配置:'),
        `  • API 地址:   ${cyan(apiBase)}`,
        `  • 默认会话:   ${activeSessionId ? cyan(activeSessionId) : dim('(未设置)')}`,
        `  • Token 注入: ${token ? '已配置 (SIYU_API_TOKEN)' : dim('未配置 (本机模式无需 Token)')}`,
        `  • 配置文件:   ${dim(path)}`,
        '',
      ].join('\n');
      await write(io.output, text);
      return 0;
    }
    await output.value({ apiBase, sessionId: activeSessionId, tokenConfigured: Boolean(token), path });
    return 0;
  }

  if (rest[0] === 'set' && rest.length === 3) {
    if (rest[1] === 'apiBase') {
      settings.apiBase = localApiBase(rest[2]!);
    } else if (rest[1] === 'sessionId') {
      settings.sessionId = identifier(rest[2]!);
    } else {
      throw new CliError('usage', '仅支持 config set apiBase/sessionId；Token 使用环境变量。', 2);
    }
    await saveJson(path, settings);
    if (output.mode === 'text' && io.output.isTTY) {
      const isDark = io.env.TERM !== 'dumb' && !('NO_COLOR' in io.env);
      const green = (s: string) => (isDark ? `\x1b[1;32m${s}\x1b[0m` : s);
      const dim = (s: string) => (isDark ? `\x1b[2m${s}\x1b[0m` : s);
      await write(io.output, `\n${green('✓')} 已保存配置 ${rest[1]} = ${rest[2]} ${dim(`(${path})`)}\n\n`);
      return 0;
    }
    await output.value({ saved: true, path });
    return 0;
  }

  throw new CliError('usage', '使用 config show 或 config set <apiBase|sessionId> <值>。', 2);
}
