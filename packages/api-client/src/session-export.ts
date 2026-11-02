/**
 * Aervox｜思隅 @aervox/api-client — 会话导出（可读文本）
 *
 * 把一次会话的分页历史整理成人类可读的 Markdown，供手机分享或复制。
 * 只读取调用方显式分页得到的记录：不补齐缺失正文、不推断被撤权内容、
 * 不把「当前不可显示」替换成占位正文以外的任何东西。
 */
import type { SessionHistoryMessage, SessionHistoryPage } from '@aervox/contracts';

export interface SessionTranscriptInput {
  sessionId: string;
  title: string;
  /** One explicit page (newest first); the exporter walks older cursor pages. */
  getPage: (input: { limit?: number; cursor?: string; signal?: AbortSignal }) => Promise<SessionHistoryPage>;
  signal?: AbortSignal;
  /** Injected for reproducible output and tests. */
  now?: () => Date;
  maxPages?: number;
  maxChars?: number;
}

export interface SessionTranscript {
  text: string;
  truncated: boolean;
  turns: number;
}

const DEFAULT_MAX_PAGES = 40;
const DEFAULT_MAX_CHARS = 200_000;
const PAGE_LIMIT = 50;

const statusLabel = (turn: { status: string; isComplete: boolean }): string =>
  turn.isComplete && turn.status === 'Completed' ? '完整' : turn.status === 'Interrupted' ? '已中断' : turn.status === 'Failed' ? '失败' : '未完成';

function speaker(message: SessionHistoryMessage): string {
  if (message.role === 'assistant') return '思隅';
  if (message.role === 'system') return '系统';
  return '我';
}

function renderMessage(message: SessionHistoryMessage): string {
  if (message.visibility === 'withheld') return `**${speaker(message)}**：（这条记录当前不可显示）`;
  const content = message.content?.trim() ?? '';
  return `**${speaker(message)}**：${content || '（空记录）'}`;
}

/** Chronological Markdown for one session; bounded in pages and characters. */
export async function buildSessionTranscript(input: SessionTranscriptInput): Promise<SessionTranscript> {
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const now = input.now ?? (() => new Date());
  const turns: SessionHistoryPage['items'] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    input.signal?.throwIfAborted();
    const result = await input.getPage({ limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}), signal: input.signal });
    turns.push(...result.items);
    const next = result.nextCursor ?? undefined;
    // A cursor that never advances would loop forever; stop instead of refetching.
    if (!next || next === cursor) break;
    cursor = next;
  }
  turns.reverse();
  const header = [`# ${input.title || '会话'}`, `会话：${input.sessionId}`, `导出时间：${now().toISOString()}`, ''].join('\n');
  const body: string[] = [];
  let truncated = false;
  let used = header.length;
  for (const [index, turn] of turns.entries()) {
    const block = [
      `## 第 ${index + 1} 轮 · ${statusLabel(turn)} · ${turn.createdAt}`,
      ...turn.messages.map(renderMessage),
      '',
    ].join('\n');
    if (used + block.length > maxChars) { truncated = true; break; }
    used += block.length;
    body.push(block);
  }
  const tail = truncated ? '\n（内容过多，导出已截断。）\n' : '';
  return { text: `${header}\n${body.join('\n')}${tail}`.trimEnd() + '\n', truncated, turns: body.length };
}
