import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ChatTerminal, fitToWidth, terminalWidth } from '../src/terminal.js';

function capture(columns: number, env: NodeJS.ProcessEnv = {}) {
  let output = '';
  const stream = Object.assign(new Writable({ write(chunk, _encoding, callback) {
    output += chunk;
    callback();
  } }), { columns });
  return { terminal: new ChatTerminal(stream, stream, env), read: () => output };
}

describe('终端列宽与安全呈现', () => {
  it.each([
    ['ASCII', 5], ['思隅', 4], ['e\u0301', 1], ['─✳↑', 3], ['Ａ', 2],
    ['🙂', 2], ['👨‍👩‍👧‍👦', 2], ['🇨🇳', 2], ['1️⃣', 2], ['\x1b[31m思隅\x1b[0m', 4],
  ])('计算混合文本列宽：%s', (text, width) => {
    expect(terminalWidth(text)).toBe(width);
  });

  it('恰好容纳时保留全文，截断不拆组合字符或 emoji', () => {
    expect(fitToWidth('思隅', 4)).toBe('思隅');
    expect(fitToWidth('abcd', 4)).toBe('abcd');
    expect(fitToWidth('e\u0301👨‍👩‍👧‍👦更多', 4)).toBe('e\u0301👨‍👩‍👧‍👦…');
    expect(fitToWidth('思隅', 1)).toBe('…');
    expect(fitToWidth('思隅', 0)).toBe('');
    expect(fitToWidth('思隅', -1)).toBe('');
  });

  it.each([1, 4, 5, 20, 40, 60, 80])('欢迎框实际内容与边框均限制在 %i 列', async columns => {
    const { terminal, read } = capture(columns);
    await terminal.welcome('session_' + 'x'.repeat(150), 'http://127.0.0.1:3000');
    const lines = stripVTControlCharacters(read()).split('\n').filter(Boolean);
    expect(lines.every(line => terminalWidth(line) <= columns)).toBe(true);
    if (columns >= 5) expect(new Set(lines.map(terminalWidth)).size).toBe(1);
  });

  it('进度行可原地清除，窄终端不会折到下一行', async () => {
    const { terminal, read } = capture(20);
    await terminal.begin();
    await terminal.wait('正在处理一个很长的中文任务👨‍👩‍👧‍👦');
    await terminal.pause();
    expect(read()).toContain('\r\x1b[2K');
    expect(stripVTControlCharacters(read()).split(/[\r\n]/).every(line => terminalWidth(line) <= 20)).toBe(true);
  });

  it('TERM=dumb 欢迎区和等待均无控制序列', async () => {
    const { terminal, read } = capture(40, { TERM: 'dumb' });
    await terminal.welcome('safe\x1b]52;c;secret\x07', 'http://127.0.0.1:3000');
    await terminal.begin();
    await terminal.finish({ ok: true });
    expect(read()).not.toMatch(/\x1b|secret|\r/);
  });
});
