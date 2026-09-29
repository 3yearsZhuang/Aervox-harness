import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable } from 'node:stream';
import { CliError } from './config.js';
import { terminalText } from './output.js';
import { CHAT_COMMANDS } from './commands/constants.js';
import type { CliIO } from './commands/types.js';

export async function readStreamInput(stream: Readable, signal: AbortSignal): Promise<string> {
  let length = 0;
  const parts: Buffer[] = [];
  const abort = () => stream.destroy(new Error('input_aborted'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += part.length;
      if (length > 65_536) throw new CliError('input_limit', '输入超过 64 KiB 限额。', 2);
      parts.push(part);
    }
    return Buffer.concat(parts).toString('utf8').trim();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export class TerminalPrompter {
  private reader?: Interface;
  private readerClosed = false;

  constructor(private io: CliIO, private cleanupController: AbortController) {}

  async prompt(question: string, signal: AbortSignal): Promise<string> {
    if (!this.io.input.isTTY) throw new CliError('needs_input', '此回合需要终端交互。', 4);
    if (!this.reader) {
      this.reader = createInterface({
        input: this.io.input,
        output: this.io.error,
        completer(line: string): [string[], string] {
          const matches = CHAT_COMMANDS.filter(command => command.startsWith(line));
          return [line.startsWith('/') ? matches : [], line];
        },
      });
      this.reader.once('close', () => { this.readerClosed = true; });
      this.reader.on('SIGINT', () => this.cleanupController.abort('SIGINT'));
    }
    if (this.readerClosed) throw new CliError('input_closed', '终端输入已关闭。', 4);
    const active = this.reader;
    return new Promise<string>((resolve, reject) => {
      const closed = () => reject(new CliError('input_closed', '终端输入已关闭。', 4));
      active.once('close', closed);
      active.question(terminalText(question), { signal }).then(
        answer => { active.removeListener('close', closed); resolve(answer); },
        error => { active.removeListener('close', closed); reject(error); },
      );
    });
  }

  close(): void {
    this.reader?.close();
  }
}
