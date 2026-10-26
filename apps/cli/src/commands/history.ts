import { AervoxHttpError, createSessionHistoryClient, isValidSessionHistoryId } from '@aervox/api-client/transport';
import { CliError } from '../config.js';
import { terminalText, write } from '../output.js';
import type { CommandContext } from './types.js';

/** Read one explicit page without creating, observing or cancelling a Turn. */
export async function executeHistory(ctx: CommandContext): Promise<number> {
  const rest = ctx.positionals.slice(1);
  if (rest.length !== 2 || rest[0] !== 'history' || ctx.options.offset !== undefined) {
    throw new CliError('usage', '使用 sessions history <ID> [--limit 1～50] [--cursor <游标>]。', 2);
  }
  const sessionId = rest[1];
  if (!isValidSessionHistoryId(sessionId)) throw new CliError('usage', '会话 ID 必须为 1～128 个字符。', 2);
  ctx.track.sessionId = sessionId;
  const limitText = ctx.options.limit ?? '20';
  const limit = Number(limitText);
  if (!/^\d+$/.test(limitText) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new CliError('usage', '--limit 必须为 1～50 的十进制整数。', 2);
  }
  const cursor = ctx.options.cursor;
  if (cursor !== undefined && (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 16_384)) {
    throw new CliError('usage', '--cursor 必须使用上次读取返回的游标。', 2);
  }
  const signal = ctx.timedSignal();
  ctx.track.currentSignal = signal;
  let page;
  try {
    page = await createSessionHistoryClient(ctx.transport).getPage(sessionId, { limit, cursor, signal });
  } catch (error) {
    if (error instanceof AervoxHttpError) {
      if (error.status === 410) throw new CliError('history_cursor_expired', '历史分页位置已失效，请移除 --cursor 从最近记录重新读取。');
      if (error.status === 422) throw new CliError('history_limit', '这页历史超过读取上限，请减小 --limit。单轮仍超限时，此入口无法读取该轮。');
      if (error.status === 404) throw new CliError('history_unavailable', '会话不存在或当前不可读取。');
      if (error.status === 400) throw new CliError('usage', '历史参数无效，请使用上次读取返回的游标。', 2);
    }
    throw error;
  }
  if (page.sessionId !== sessionId || page.items.length > limit || (page.nextCursor !== null
    && (!/^[A-Za-z0-9_-]+$/.test(page.nextCursor) || page.nextCursor.length > 16_384))) {
    throw new CliError('protocol', '服务返回的历史格式不兼容。');
  }
  if (ctx.output.mode !== 'text' || !ctx.io.output.isTTY) {
    await ctx.output.value(page);
    return 0;
  }
  const lines = [`会话 ${terminalText(sessionId)} · 本页 ${page.items.length} 轮`];
  for (const turn of page.items) {
    lines.push('', `${terminalText(turn.turnId)} · ${turn.isComplete ? '已完成' : `未完成（${terminalText(turn.status)}）`}`);
    for (const message of turn.messages) {
      const label = message.contentKind === 'accepted_input' ? '本轮输入' : message.role === 'assistant' ? '助手' : '会话记录';
      lines.push(`${label}${message.readOnly ? '（只读）' : ''}：${message.visibility === 'withheld'
        ? '这条记录当前不可显示。' : terminalText(message.content ?? '')}`);
    }
  }
  if (!page.items.length) lines.push('此页没有可显示的已保存记录。');
  if (page.nextCursor) lines.push('', `继续查看更早记录：--limit ${limit} --cursor ${page.nextCursor}`);
  await write(ctx.io.output, lines.join('\n') + '\n', signal);
  return 0;
}
