import { expect, it } from 'vitest';
import type { PromptMessage } from '@aervox/core/browser';
import { nativeContextBuilder } from '../src/mobile/native-context';

const system: PromptMessage = { role: 'system', content: '手机只可进行文本对话，没有设备操作工具。' };
const latest: PromptMessage = { role: 'user', content: '继续当前问题' };
const turn = (index: number, content = '历史内容'): PromptMessage[] => [
  { role: 'user', content: `问题${index}:${content}` },
  { role: 'assistant', content: `回答${index}:${content}` },
];
const build = (messages: PromptMessage[]) => nativeContextBuilder.build({ turnId: 'turn', sessionId: 'session', messages });

it('bounds a long native request through Core compaction while retaining paired recent history and the system boundary', async () => {
  const messages = [system, ...Array.from({ length: 80 }, (_, index) => turn(index)).flat(), latest];
  const result = await build(messages);
  expect(result.messages.length).toBeLessThanOrEqual(128);
  expect(result.messages[0]).toEqual(system);
  expect(result.messages.at(-1)).toEqual(latest);
  expect(result.messages).toContainEqual(turn(79)[0]);
  expect(result.messages).toContainEqual(turn(79)[1]);
  const kept = result.messages.filter(message => message.role !== 'system');
  expect(kept[0]?.role).toBe('user');
  expect(kept.slice(0, -1).map(message => message.role)).toEqual(Array.from({ length: (kept.length - 1) / 2 }, () => ['user', 'assistant']).flat());
  expect(result.messages.some(message => message.content.includes('No summary was generated; do not infer missing facts.'))).toBe(true);
  expect(result.pruningReport).toMatchObject({ summaryStatus: 'rule_notice', omittedMessageCount: messages.length - result.messages.length + 1 });
  expect(messages).toHaveLength(162);
});

it('measures escaped UTF-8 JSON bytes, omits old complete pairs, and keeps the current input unchanged', async () => {
  const current = { role: 'user' as const, content: '\0'.repeat(32_768) };
  const result = await build([system, ...Array.from({ length: 6 }, (_, index) => turn(index, '界'.repeat(32_768))).flat(), current]);
  expect(new TextEncoder().encode(JSON.stringify(result.messages.map(({ role, content }) => ({ role, content })))).byteLength).toBeLessThanOrEqual(240 * 1024);
  expect(result.messages).toEqual([system, expect.objectContaining({ role: 'system' }), current]);
  expect(result.pruningReport).toMatchObject({ initialMessageCount: 14, omittedMessageCount: 12, summaryStatus: 'rule_notice' });
});

it('keeps short histories intact and stops immediately when context building is cancelled', async () => {
  const messages = [system, ...turn(0), latest];
  expect((await build(messages)).messages).toEqual(messages);
  const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await expect(nativeContextBuilder.build({ turnId: 'turn', sessionId: 'session', messages, signal: abort.signal })).rejects.toThrow('cancelled');
});
