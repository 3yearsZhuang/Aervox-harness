import type { Writable } from 'node:stream';
import { terminalText, write } from './output.js';

type TerminalStream = Writable & { columns?: number };

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

  constructor(private out: TerminalStream, private err: TerminalStream, env: NodeJS.ProcessEnv) {
    this.motion = env.TERM !== 'dumb';
    this.color = this.motion && !('NO_COLOR' in env);
  }

  private style(text: string, code: number): string {
    const safe = terminalText(text);
    return this.color ? `\x1b[${code}m${safe}\x1b[0m` : safe;
  }

  private fit(text: string): string {
    const limit = Math.max(1, (this.err.columns ?? 80) - 2);
    let width = 0;
    let result = '';
    for (const char of terminalText(text).replace(/[\r\n\t]/g, ' ')) {
      const cells = /\p{Mark}/u.test(char) ? 0 : char.codePointAt(0)! >= 0x2e80 ? 2 : 1;
      if (width + cells > limit - 1) return result + '…';
      result += char; width += cells;
    }
    return result;
  }

  async welcome(sessionId: string, apiBase: string): Promise<void> {
    await write(this.err, '\n' + this.style(this.fit('  ✳  思隅  ·  SIYU CLI 0.1.0'), 36) + '\n'
      + this.style(this.fit('     你的终端学习伙伴'), 2) + '\n\n'
      + this.fit(`  会话  ${sessionId}`) + '\n'
      + this.style(this.fit(`  服务  ${apiBase} · 本机连接版`), 2) + '\n\n'
      + this.fit('  从一个问题开始，也可以接着上次的思路聊。') + '\n'
      + this.style(this.fit('  /help 帮助  /session 会话  /new 新对话  /exit 退出'), 2) + '\n'
      + this.style(this.fit('  Enter 发送 · 行末 \\ 换行 · Tab 补全 · ↑ 历史'), 2) + '\n');
  }

  async inputRule(): Promise<void> {
    const width = Math.max(1, Math.min(72, (this.err.columns ?? 80) - 2));
    await write(this.err, '\n' + this.style('─'.repeat(width), 2) + '\n');
  }

  async begin(): Promise<void> {
    this.started = Date.now(); this.answered = false; this.lastWasNewline = true;
    await write(this.err, '\n');
    await this.wait('正在发送');
  }

  async wait(label = '正在回复'): Promise<void> {
    await this.pause();
    this.label = label; this.waiting = true;
    if (!this.motion) { await write(this.err, `${label}…\n`); return; }
    await this.tick();
    if (!this.waiting) return;
    this.timer = setInterval(() => { void this.tick(); }, 120);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (!this.waiting || this.pending) return;
    const frames = ['◐', '◓', '◑', '◒'];
    const line = this.fit(`  ${frames[this.frame++ % frames.length]} ${this.label} · ${((Date.now() - this.started) / 1000).toFixed(1)}s · Ctrl-C 停止`);
    const pending = write(this.err, '\r\x1b[2K' + this.style(line, 2));
    this.pending = pending;
    try { await pending; } catch { this.dispose(); }
    finally { if (this.pending === pending) this.pending = undefined; }
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
      await write(this.out, this.style('● 思隅', 36) + '\n\n', signal);
      this.answered = true;
    }
    await write(this.out, text, signal);
    this.lastWasNewline = text.endsWith('\n');
  }

  async interaction(): Promise<void> {
    await this.pause();
    if (this.answered && !this.lastWasNewline) {
      await write(this.out, '\n'); this.lastWasNewline = true;
    }
  }

  async finish(data: Record<string, unknown>): Promise<void> {
    await this.interaction();
    const label = data.ok ? '✓ 已完成' : data.code === 'approval_recorded' ? '○ 审批已记录，执行尚未确认'
      : data.code === 'needs_approval' ? '○ 等待审批' : data.status === 'Cancelled' ? '○ 已取消'
      : data.status === 'Failed' ? '× 执行失败' : '○ 尚未确认完成';
    await write(this.err, '\n' + this.style(this.fit(`  ${label} · ${((Date.now() - this.started) / 1000).toFixed(1)}s`), data.ok ? 2 : 33) + '\n');
    if (!data.ok && data.turnId) await write(this.err, `  回合 ${terminalText(String(data.turnId))} · 用 /session 查看恢复标识\n`);
  }

  async failure(code: string, message: string, context: Record<string, unknown>): Promise<void> {
    await this.interaction();
    await write(this.err, '\n' + this.style(`  × ${message}`, 33) + '\n');
    for (const [label, value] of Object.entries({ 原因: code, 会话: context.sessionId, 回合: context.turnId, 请求: context.requestId })) {
      if (value) await write(this.err, `  ${label}  ${terminalText(String(value))}\n`);
    }
    if (context.cancellation) await write(this.err, context.cancellation === 'requested'
      ? '  已请求服务端取消；最终状态仍需查询。\n' : '  未能确认取消，请查询回合状态。\n');
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.waiting = false;
  }
}
