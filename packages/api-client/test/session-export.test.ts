import { describe, expect, it, vi } from 'vitest';
import type { SessionHistoryPage } from '@aervox/contracts';
import { buildSessionTranscript } from '../src/session-export.js';

const page = (items: SessionHistoryPage['items'], nextCursor: string | null = null): SessionHistoryPage =>
  ({ sessionId: 'ses_1', nextCursor, items });
const turn = (turnId: string, createdAt: string, messages: SessionHistoryPage['items'][number]['messages'], status = 'Completed') =>
  ({ turnId, status, isComplete: status === 'Completed', createdAt, messages });
const message = (role: string, content: string, extra: Record<string, unknown> = {}) => ({
  messageId: `m_${content}`, versionId: 'v1', version: 1, role, contentKind: 'message', content,
  visibility: 'available', readOnly: false, legacy: false, createdAt: 'now', ...extra,
}) as SessionHistoryPage['items'][number]['messages'][number];

describe('buildSessionTranscript', () => {
  it('walks older pages and renders chronological, readable turns', async () => {
    const getPage = vi.fn()
      .mockResolvedValueOnce(page([turn('t3', '2026-11-02T10:03:00Z', [message('user', '第三个问题'), message('assistant', '第三个回答')])], 'c2'))
      .mockResolvedValueOnce(page([turn('t2', '2026-11-02T10:02:00Z', [message('user', '第二个问题'), message('assistant', '第二个回答')])], 'c1'))
      .mockResolvedValueOnce(page([turn('t1', '2026-11-02T10:01:00Z', [message('user', '第一个问题'), message('assistant', '第一个回答')])]));
    const result = await buildSessionTranscript({ sessionId: 'ses_1', title: '死锁复习',
      getPage, now: () => new Date('2026-11-02T12:00:00Z') });
    expect(getPage.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, 'c2', 'c1']);
    expect(getPage.mock.calls.every(([input]) => input.limit === 50)).toBe(true);
    expect(result.turns).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain('# 死锁复习');
    expect(result.text).toContain('会话：ses_1');
    expect(result.text).toContain('导出时间：2026-11-02T12:00:00.000Z');
    const order = ['第一个问题', '第二个问题', '第三个问题'].map(text => result.text.indexOf(text));
    expect(order.every((index, position) => index > 0 && (position === 0 || index > order[position - 1]!))).toBe(true);
    expect(result.text).toContain('## 第 1 轮 · 完整 · 2026-11-02T10:01:00Z');
    expect(result.text).toContain('**我**：第一个问题');
    expect(result.text).toContain('**思隅**：第一个回答');
  });

  it('marks interrupted turns and withholds content that is no longer disclosed', async () => {
    const getPage = vi.fn().mockResolvedValue(page([
      turn('t2', '2026-11-02T10:02:00Z', [message('user', '已删除的输入', { visibility: 'withheld' }), message('assistant', '')], 'Interrupted'),
      turn('t1', '2026-11-02T10:01:00Z', [message('user', '正常输入'), message('assistant', '正常回答')]),
    ]));
    const result = await buildSessionTranscript({ sessionId: 'ses_1', title: '中断会话', getPage });
    expect(result.text).toContain('已中断');
    expect(result.text).toContain('（这条记录当前不可显示）');
    expect(result.text).not.toContain('已删除的输入');
    expect(result.text).toContain('（空记录）');
  });

  it('stops on a repeating cursor instead of refetching forever', async () => {
    const getPage = vi.fn().mockResolvedValue(page([turn('t1', '2026-11-02T10:01:00Z', [message('user', '问')])], 'same'));
    const result = await buildSessionTranscript({ sessionId: 'ses_1', title: '循环', getPage, maxPages: 5 });
    // The repeated page is fetched once more, then the exporter stops instead of looping.
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(result.turns).toBe(2);
  });

  it('bounds the exported size and says so', async () => {
    const getPage = vi.fn().mockResolvedValue(page([
      turn('t1', '2026-11-02T10:01:00Z', [message('user', 'x'.repeat(400)), message('assistant', 'y'.repeat(400))]),
    ]));
    const result = await buildSessionTranscript({ sessionId: 'ses_1', title: '长会话', getPage, maxChars: 300 });
    expect(result.truncated).toBe(true);
    expect(result.turns).toBe(0);
    expect(result.text).toContain('（内容过多，导出已截断。）');
  });

  it('honours cancellation instead of exporting a partial transcript as complete', async () => {
    const controller = new AbortController();
    controller.abort();
    const getPage = vi.fn();
    await expect(buildSessionTranscript({ sessionId: 'ses_1', title: '取消', getPage, signal: controller.signal }))
      .rejects.toThrow();
    expect(getPage).not.toHaveBeenCalled();
  });
});
