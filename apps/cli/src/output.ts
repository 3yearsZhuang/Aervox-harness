import { stripVTControlCharacters } from 'node:util';
import type { Writable } from 'node:stream';
import { CliError } from './config.js';
import type { ChatTerminal } from './terminal.js';

export type OutputMode = 'text' | 'json' | 'jsonl';
export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export async function write(stream: Writable, text: string, signal?: AbortSignal): Promise<void> {
  const deadline = signal ?? AbortSignal.timeout(3000);
  deadline.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      deadline.removeEventListener('abort', abort);
      stream.removeListener('close', closed);
      stream.removeListener('error', failed);
    };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const abort = () => { cleanup(); reject(deadline.reason); };
    const closed = () => failed(new Error('output_closed'));
    deadline.addEventListener('abort', abort, { once: true });
    stream.once('close', closed);
    stream.once('error', failed);
    // Sequential write callbacks bound buffering even when the consumer is slow.
    stream.write(text, error => { cleanup(); if (error) reject(error); else resolve(); });
  });
}

export class Output {
  private text = '';
  private length = 0;
  constructor(readonly mode: OutputMode, private out: Writable, private err: Writable, private terminal?: ChatTerminal) {}

  reset(): void { this.text = ''; this.length = 0; }
  async delta(text: string, signal?: AbortSignal, context: Record<string, unknown> = {}): Promise<void> {
    this.length += Buffer.byteLength(text);
    if (this.length > 2_097_152) throw new CliError('output_limit', '输出超过 2 MiB 限额。');
    // 每个片段独立清理，避免被截断的控制序列跨片段执行。
    const safe = terminalText(text);
    if (this.mode === 'json') this.text += safe;
    if (this.mode === 'text') {
      if (this.terminal) await this.terminal.delta(safe, signal);
      else await write(this.out, safe, signal);
    }
    if (this.mode === 'jsonl') await this.event('delta', { ...context, text: safe }, signal);
  }
  async event(type: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    if (this.mode === 'jsonl') await write(this.out, JSON.stringify({ version: 1, type, ...data }) + '\n', signal);
  }
  async diagnostic(text: string): Promise<void> { await write(this.err, terminalText(text) + '\n'); }
  async result(data: Record<string, unknown>): Promise<void> {
    if (this.terminal) { await this.terminal.finish(data); return; }
    if (this.mode === 'json') await write(this.out, JSON.stringify({ version: 1, ...data, text: this.text }) + '\n');
    else if (this.mode === 'jsonl') await this.event('result', data);
    else {
      if (this.length) await write(this.out, '\n');
      await this.diagnostic(JSON.stringify(data));
    }
  }
  async value(value: unknown): Promise<void> {
    const text = JSON.stringify({ version: 1, data: value }, null, this.mode === 'text' ? 2 : undefined);
    await write(this.out, (this.mode === 'text' ? terminalText(text) : text) + '\n');
  }
  async failure(code: string, message: string, context: Record<string, unknown>): Promise<void> {
    if (this.terminal) { await this.terminal.failure(code, message, context); return; }
    if (this.mode === 'text') await this.diagnostic(`${code}: ${message}\n${JSON.stringify(context)}`);
    else await this.result({ ok: false, code, message: terminalText(message), ...context });
  }
}
