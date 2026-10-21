import type { Writable } from 'node:stream';
import { terminalText, write } from './output.js';

type TerminalStream = Writable & { columns?: number };

/** Accurate visual terminal width taking CJK and wide characters into account */
export function terminalWidth(text: string): number {
  const safe = terminalText(text).replace(/[\r\n\t]/g, ' ');
  let width = 0;
  for (const char of safe) {
    if (/\p{Mark}/u.test(char)) continue;
    const cp = char.codePointAt(0) ?? 0;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Fit single line within maximum cell width, truncating with ellipsis if necessary */
export function fitToWidth(text: string, maxWidth: number): string {
  const safe = terminalText(text).replace(/[\r\n\t]/g, ' ');
  let width = 0;
  let result = '';
  for (const char of safe) {
    const cells = /\p{Mark}/u.test(char) ? 0 : char.codePointAt(0)! >= 0x2e80 ? 2 : 1;
    if (width + cells > maxWidth - 1) return result + '…';
    result += char;
    width += cells;
  }
  return result;
}

/** Scrollback-friendly presentation; only locally generated text may contain ANSI. */
export class ChatTerminal {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private waiting = false;
  private started = 0;
  private answered = false;
  private lastWasNewline = true;
  private frame = 0;
  private label = '';
  private readonly motion: boolean;
  private readonly color: boolean;
  private readonly frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  constructor(private out: TerminalStream, private err: TerminalStream, env: NodeJS.ProcessEnv) {
    this.motion = env.TERM !== 'dumb';
    this.color = this.motion && !('NO_COLOR' in env);
  }

  private style(text: string, code: number | string): string {
    const safe = terminalText(text);
    return this.color ? `\x1b[${code}m${safe}\x1b[0m` : safe;
  }

  private fit(text: string): string {
    const limit = Math.max(1, (this.err.columns ?? 80) - 2);
    return fitToWidth(text, limit);
  }

  async welcome(sessionId: string, apiBase: string): Promise<void> {
    if (!this.motion) {
      await write(
        this.err,
        '\n'
          + '  ✳  思隅  ·  SIYU CLI 0.1.0\n'
          + '     属于你的贾维斯，或者属于你的爱弥斯\n\n'
          + `  会话  ${sessionId}\n`
          + `  服务  ${apiBase} · 本机连接版\n\n`
          + '  从一个问题开始，也可以接着上次的思路聊。\n'
          + '  /help 帮助  /session 会话  /new 新对话  /exit 退出\n'
          + '  Enter 发送 · 行末 \\ 换行 · Tab 补全 · ↑ 历史\n\n',
      );
      return;
    }

    const cols = this.err.columns ?? 80;
    const innerWidth = Math.max(56, Math.min(66, cols - 4));
    const border = (c: string) => this.style(c, 36);

    const row = (styledContent: string, rawText: string) => {
      const clipped = fitToWidth(rawText, innerWidth - 2);
      const pad = Math.max(0, innerWidth - terminalWidth(clipped));
      return `${border('│')}  ${styledContent}${' '.repeat(pad)}${border('│')}\n`;
    };

    const emptyRow = `${border('│')}${' '.repeat(innerWidth + 2)}${border('│')}\n`;

    const topBorder = border('╭' + '─'.repeat(innerWidth + 2) + '╮') + '\n';
    const bottomBorder = border('╰' + '─'.repeat(innerWidth + 2) + '╯') + '\n';

    const safeSession = fitToWidth(sessionId, innerWidth - 8);
    const safeBase = fitToWidth(apiBase, innerWidth - 20);

    const banner = '\n'
      + topBorder
      + row(`${this.style('✳  思隅  ·  SIYU CLI 0.1.0', '1;36')}`, '✳  思隅  ·  SIYU CLI 0.1.0')
      + row(`   ${this.style('属于你的贾维斯，或者属于你的爱弥斯', 2)}`, '   属于你的贾维斯，或者属于你的爱弥斯')
      + emptyRow
      + row(`${this.style('会话', 36)}  ${safeSession}`, `会话  ${safeSession}`)
      + row(`${this.style('服务', 36)}  ${safeBase} ${this.style('· 本机连接版', 2)}`, `服务  ${safeBase} · 本机连接版`)
      + emptyRow
      + row(`${this.style('从一个问题开始，也可以接着上次的思路聊。', 2)}`, '从一个问题开始，也可以接着上次的思路聊。')
      + row(`${this.style('/help 帮助  /session 会话  /new 新对话  /exit 退出', 2)}`, '/help 帮助  /session 会话  /new 新对话  /exit 退出')
      + row(`${this.style('Enter 发送 · 行末 \\ 换行 · Tab 补全 · ↑ 历史', 2)}`, 'Enter 发送 · 行末 \\ 换行 · Tab 补全 · ↑ 历史')
      + bottomBorder
      + '\n';

    await write(this.err, banner);
  }

  async inputRule(): Promise<void> {
    const width = Math.max(1, Math.min(68, (this.err.columns ?? 80) - 2));
    await write(this.err, '\n' + this.style('─'.repeat(width), 2) + '\n');
  }

  async begin(): Promise<void> {
    this.started = Date.now();
    this.answered = false;
    this.lastWasNewline = true;
    await write(this.err, '\n');
    await this.wait('正在发送');
  }

  async wait(label = '正在回复'): Promise<void> {
    await this.pause();
    this.label = label;
    this.waiting = true;
    if (!this.motion) {
      await write(this.err, `${label}…\n`);
      return;
    }
    await this.tick();
    if (!this.waiting) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 80);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (!this.waiting || this.pending) return;
    const frameChar = this.frames[this.frame++ % this.frames.length]!;
    const elapsed = ((Date.now() - this.started) / 1000).toFixed(1);
    const safeLabel = terminalText(this.label);
    const line = this.color
      ? `  \x1b[1;36m${frameChar}\x1b[0m ${safeLabel} \x1b[2m· ${elapsed}s · Ctrl-C 停止\x1b[0m`
      : `  ${frameChar} ${safeLabel} · ${elapsed}s · Ctrl-C 停止`;
    const pending = write(this.err, '\r\x1b[2K' + line);
    this.pending = pending;
    try {
      await pending;
    } catch {
      this.dispose();
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  async pause(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const wasWaiting = this.waiting;
    this.waiting = false;
    await this.pending?.catch(() => undefined);
    if (wasWaiting && this.motion) await write(this.err, '\r\x1b[2K');
  }

  async delta(text: string, signal?: AbortSignal): Promise<void> {
    if (!text) return;
    await this.pause();
    if (!this.answered) {
      await write(this.out, this.style('● 思隅', '1;36') + '\n\n', signal);
      this.answered = true;
    }
    await write(this.out, text, signal);
    this.lastWasNewline = text.endsWith('\n');
  }

  async interaction(): Promise<void> {
    await this.pause();
    if (this.answered && !this.lastWasNewline) {
      await write(this.out, '\n');
      this.lastWasNewline = true;
    }
  }

  async finish(data: Record<string, unknown>): Promise<void> {
    await this.interaction();
    const elapsed = ((Date.now() - this.started) / 1000).toFixed(1);
    let badge = '○ 尚未确认完成';
    let badgeStyle: number | string = 33;
    if (data.ok) {
      badge = '✓ 已完成';
      badgeStyle = '1;32';
    } else if (data.status === 'Failed') {
      badge = '× 执行失败';
      badgeStyle = '1;31';
    } else if (data.status === 'Cancelled') {
      badge = '○ 已取消';
      badgeStyle = '1;33';
    } else if (data.code === 'needs_approval') {
      badge = '○ 等待审批';
      badgeStyle = '1;33';
    } else if (data.code === 'approval_recorded') {
      badge = '○ 审批已记录，执行尚未确认';
      badgeStyle = '1;36';
    }
    const badgeText = this.style(badge, badgeStyle);
    const metaText = this.style(`· ${elapsed}s`, 2);
    await write(this.err, '\n' + `  ${badgeText} ${metaText}` + '\n');
    if (!data.ok && data.turnId) {
      await write(this.err, this.style(`  回合 ${terminalText(String(data.turnId))} · 用 /session 查看恢复标识\n`, 2));
    }
  }

  async failure(code: string, message: string, context: Record<string, unknown>): Promise<void> {
    await this.interaction();
    await write(this.err, '\n' + this.style(`  × ${message}`, '1;31') + '\n');
    for (const [label, value] of Object.entries({
      原因: code,
      会话: context.sessionId,
      回合: context.turnId,
      请求: context.requestId,
    })) {
      if (value) await write(this.err, `  ${this.style(label, 2)}  ${terminalText(String(value))}\n`);
    }
    if (context.cancellation) {
      const cancelMsg = context.cancellation === 'requested'
        ? '  已请求服务端取消；最终状态仍需查询。\n'
        : '  未能确认取消，请查询回合状态。\n';
      await write(this.err, this.style(cancelMsg, 33));
    }
  }

  async help(): Promise<void> {
    const title = this.style('思隅 对话命令', '1;36');
    const lines = [
      `  ${this.style('/help', 36)}       显示这份帮助`,
      `  ${this.style('/session', 36)}    查看当前会话、服务及上一回合的恢复标识`,
      `  ${this.style('/new', 36)}        切换到新会话，原会话保留`,
      `  ${this.style('/exit', 36)}       退出（也可用 /quit）`,
      '',
      `  ${this.style('Enter 发送 · 行末 \\ + Enter 换行 · Tab 补全命令 · ↑/↓ 历史', 2)}`,
      `  ${this.style('Ctrl-C 退出并尝试取消当前回合。以 // 开头可发送字面量 /。', 2)}`,
      `  ${this.style('模型由本机服务配置；会话内容由服务端保存。', 2)}`,
    ];
    await write(this.err, '\n' + title + '\n' + lines.join('\n') + '\n\n');
  }

  async sessionCard(info: { sessionId: string; apiBase: string; turnId?: string; requestId?: string }): Promise<void> {
    const title = this.style('会话状态', '1;36');
    const lines = [
      `  ${this.style('会话', 36)}  ${info.sessionId}`,
      `  ${this.style('服务', 36)}  ${info.apiBase} · 本机连接版`,
      `  ${this.style('模型', 36)}  由本机服务配置`,
    ];
    if (info.turnId || info.requestId) {
      lines.push(
        `  ${this.style('回合', 36)}  ${info.turnId ?? '受理状态未知'}`,
        `  ${this.style('请求', 36)}  ${info.requestId ?? '无'}`,
      );
    } else {
      lines.push(`  ${this.style('状态', 2)}  尚未在本次客户端提交问题`);
    }
    await write(this.err, '\n' + title + '\n' + lines.join('\n') + '\n\n');
  }

  async newSession(sessionId: string): Promise<void> {
    await write(this.err, '\n' + this.style('✓ 已切换到新会话', '1;32') + ` ${sessionId}；${this.style('原会话已保留。', 2)}\n\n`);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.waiting = false;
  }
}
