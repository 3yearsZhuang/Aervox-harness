import { CliError, identifier, localApiBase, saveJson } from '../config.js';
import { terminalText, write } from '../output.js';
import { createTerminalStyle } from '../terminal.js';
import type { CommandContext } from './types.js';

export async function executeConfig(ctx: CommandContext): Promise<number> {
  const { positionals, output, apiBase, token, path, settings, options, io } = ctx;
  const rest = positionals.slice(1);
  const activeSessionId = options.session ?? io.env.SIYU_SESSION_ID ?? settings.sessionId;

  if (rest[0] === 'show' && rest.length === 1) {
    if (output.mode === 'text' && io.output.isTTY) {
      const style = createTerminalStyle(io.env);
      const cyan = (s: string) => style(s, '36');
      const dim = (s: string) => style(s, '2');
      const bold = (s: string) => style(s, '1');
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
      const style = createTerminalStyle(io.env);
      const green = (s: string) => style(s, '1;32');
      const dim = (s: string) => style(s, '2');
      await write(io.output, `\n${green('✓')} 已保存配置 ${rest[1]} = ${terminalText(rest[1] === 'apiBase' ? settings.apiBase! : settings.sessionId!)} ${dim(`(${path})`)}\n\n`);
      return 0;
    }
    await output.value({ saved: true, path });
    return 0;
  }

  throw new CliError('usage', '使用 config show 或 config set <apiBase|sessionId> <值>。', 2);
}
