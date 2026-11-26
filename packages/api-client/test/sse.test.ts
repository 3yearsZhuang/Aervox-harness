import { describe, expect, it } from 'vitest';
import { parseSseData, parseSseJson } from '../src/sse';

describe('sse frame parsing (single implementation)', () => {
  it('extracts a single data field and strips exactly one leading space', () => {
    expect(parseSseData('data: {"a":1}')).toBe('{"a":1}');
    expect(parseSseData('data:  {"a":1}')).toBe(' {"a":1}');
  });

  it('joins multiple data lines with a newline, never by concatenation', () => {
    expect(parseSseData('data: {"a":\ndata: 1}')).toBe('{"a":\n1}');
    expect(JSON.parse(parseSseData('data: {"a":\ndata: 1}'))).toEqual({ a: 1 });
  });

  it('ignores comments and non-data fields', () => {
    expect(parseSseData(': keep-alive')).toBe('');
    expect(parseSseData('event: turn\ndata: {"a":1}\nid: 7')).toBe('{"a":1}');
  });

  it('returns an empty string for heartbeat frames', () => {
    expect(parseSseData('')).toBe('');
    expect(parseSseData('\n')).toBe('');
  });

  it('parses JSON payloads and reports malformed ones as undefined', () => {
    expect(parseSseJson('data: {"a":1}')).toEqual({ a: 1 });
    expect(parseSseJson('data: not-json')).toBeUndefined();
    expect(parseSseJson(': heartbeat')).toBeUndefined();
  });

  it('does not silently weld tokens that the spec keeps on separate lines', () => {
    // 旧 desktop 实现用 join('')：两条 data 行会被拼成合法但错误的值 `12`。
    // 规范要求以 \n 连接，拼接后不再是合法 JSON，调用方得到 undefined 而不是错误值。
    const block = 'data: 1\ndata: 2';
    expect(parseSseData(block)).toBe('1\n2');
    expect(parseSseJson(block)).toBeUndefined();
  });
});
