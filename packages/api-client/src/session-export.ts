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
  /** UTF-8 budget for the complete artifact, including its header and truncation notice. */
  maxBytes?: number;
}

export interface SessionTranscript {
  text: string;
  truncated: boolean;
  turns: number;
}

const DEFAULT_MAX_PAGES = 40;
const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const PAGE_LIMIT = 50;
const TRUNCATION_NOTICE = '（内容过多，导出已截断。）';
const encoder = new TextEncoder();

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

/** Chronological Markdown for one session; bounded in pages, characters and UTF-8 bytes. */
export async function buildSessionTranscript(input: SessionTranscriptInput): Promise<SessionTranscript> {
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = input.now ?? (() => new Date());
  input.signal?.throwIfAborted();
  const header = [`# ${input.title || '会话'}`, `会话：${input.sessionId}`, `导出时间：${now().toISOString()}`].join('\n');
  // The final newline is part of the artifact even when there are no turns.
  let usedChars = header.length + 1;
  let usedBytes = encoder.encode(header).byteLength + 1;
  const withinBudget = (chars: number, bytes: number) => chars <= maxChars && bytes <= maxBytes;
  if (!withinBudget(usedChars, usedBytes)) throw new Error('SESSION_TRANSCRIPT_HEADER_TOO_LARGE');
  const turns: SessionHistoryPage['items'] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    input.signal?.throwIfAborted();
    const result = await input.getPage({ limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}), signal: input.signal });
    turns.push(...result.items);
    const next = result.nextCursor ?? undefined;
    if (next && (page + 1 === maxPages || next === cursor)) truncated = true;
    // A cursor that never advances would loop forever; stop instead of refetching.
    if (!next || next === cursor) break;
    cursor = next;
  }
  turns.reverse();
  const body: { text: string; chars: number; bytes: number }[] = [];
  const noticeChars = TRUNCATION_NOTICE.length + 2;
  const noticeBytes = encoder.encode(TRUNCATION_NOTICE).byteLength + 2;
  for (const [index, turn] of turns.entries()) {
    const block = [
      `## 第 ${index + 1} 轮 · ${statusLabel(turn)} · ${turn.createdAt}`,
      ...turn.messages.map(renderMessage),
    ].join('\n');
    // Keep complete turns and account for the blank line preceding each block.
    const chars = block.length + 2;
    const bytes = encoder.encode(block).byteLength + 2;
    if (!withinBudget(usedChars + chars + (truncated ? noticeChars : 0),
      usedBytes + bytes + (truncated ? noticeBytes : 0))) { truncated = true; break; }
    usedChars += chars;
    usedBytes += bytes;
    body.push({ text: block, chars, bytes });
  }
  // A later turn can exhaust the budget after earlier turns fit exactly.
  // Make room for the required notice by removing complete trailing turns.
  while (truncated && !withinBudget(usedChars + noticeChars, usedBytes + noticeBytes)) {
    const removed = body.pop();
    if (!removed) throw new Error('SESSION_TRANSCRIPT_BUDGET_TOO_SMALL');
    usedChars -= removed.chars;
    usedBytes -= removed.bytes;
  }
  const text = [header, ...body.map(block => block.text), ...(truncated ? [TRUNCATION_NOTICE] : [])].join('\n\n') + '\n';
  return { text, truncated, turns: body.length };
}
