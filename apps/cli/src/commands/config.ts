import { CliError, identifier, localApiBase, saveJson } from '../config.js';
import type { CommandContext } from './types.js';

export async function executeConfig(ctx: CommandContext): Promise<number> {
  const { positionals, output, apiBase, token, path, settings, options, io } = ctx;
  const rest = positionals.slice(1);
  const activeSessionId = options.session ?? io.env.SIYU_SESSION_ID ?? settings.sessionId;

  if (rest[0] === 'show' && rest.length === 1) {
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
    await output.value({ saved: true, path });
    return 0;
  }

  throw new CliError('usage', '使用 config show 或 config set <apiBase|sessionId> <值>。', 2);
}
