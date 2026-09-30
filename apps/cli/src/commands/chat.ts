import { randomUUID } from 'node:crypto';
import { CliError, identifier, saveJson } from '../config.js';
import { TerminalPrompter } from '../input.js';
import { Output } from '../output.js';
import { ChatTerminal } from '../terminal.js';
import { createTurnCallbacks, type TurnExecutionState } from '../turn-callbacks.js';
import { CHAT_HELP } from './constants.js';
import type { CommandContext } from './types.js';

export async function executeChat(ctx: CommandContext): Promise<number> {
  const { options, positionals, io, apiBase, path, transport, timedSignal, interactiveSignal, cleanupController, track } = ctx;
  const rest = positionals.slice(1);
  if (rest.length || !io.input.isTTY || options.json) {
    throw new CliError('usage', 'chat 需要交互终端，且不支持 --json；管道请使用 ask。', 2);
  }

  let activeSessionId = ctx.sessionId ?? `cli_${randomUUID()}`;
  track.sessionId = activeSessionId;

  let output = ctx.output;
  let view: ChatTerminal | undefined;
  if (output.mode === 'text' && io.output.isTTY && io.error.isTTY) {
    view = new ChatTerminal(io.output, io.error, io.env);
    ctx.view = view;
    output = new Output('text', io.output, io.error, view);
    ctx.output = output;
    await view.welcome(activeSessionId, apiBase);
  }

  const prompter = new TerminalPrompter(io, cleanupController);
  let lastReceipt: { turnId?: string; requestId: string } | undefined;

  try {
    for (;;) {
      track.terminal = false;
      track.ownsTurn = false;
      track.turnId = undefined;
      output.reset();

      let content: string;
      try {
        await view?.inputRule();
        const signal = interactiveSignal;
        let line = await prompter.prompt('❯ ', signal);
        content = '';
        for (;;) {
          const continued = line.endsWith('\\');
          content += continued ? line.slice(0, -1) + '\n' : line;
          if (Buffer.byteLength(content) > 65_536) {
            throw new CliError('input_limit', '输入超过 64 KiB 限额。', 2);
          }
          if (!continued) break;
          line = await prompter.prompt('  · ', signal);
        }
        content = content.trim();
      } catch (error) {
        if (error instanceof CliError && error.code === 'input_closed') return 0;
        throw error;
      }

      if (content === '/exit' || content === '/quit') return 0;
      if (!content) continue;
      if (content === '/help') {
        await output.diagnostic(CHAT_HELP);
        continue;
      }
      if (content === '/session') {
        await output.diagnostic(
          `会话  ${activeSessionId}\n服务  ${apiBase}\n模型  由本机服务配置${
            lastReceipt
              ? `\n回合  ${lastReceipt.turnId ?? '受理状态未知'}\n请求  ${lastReceipt.requestId}`
              : '\n尚未在本次客户端提交问题'
          }`,
        );
        continue;
      }
      if (content === '/new') {
        activeSessionId = `cli_${randomUUID()}`;
        track.sessionId = activeSessionId;
        lastReceipt = undefined;
        await output.diagnostic(`已切换到新会话 ${activeSessionId}；原会话已保留。`);
        continue;
      }
      if (content.startsWith('//')) {
        content = content.slice(1);
      } else if (content.startsWith('/')) {
        await output.diagnostic('未知对话命令。输入 /help 查看帮助；以 // 开头可发送字面量 /。');
        continue;
      }

      const currentSignal = timedSignal();
      track.currentSignal = currentSignal;

      const requestId = `cli_${randomUUID()}`;
      track.requestId = requestId;

      const receipt = { version: 1, apiBase, sessionId: activeSessionId, requestId };
      await saveJson(`${path}.last-run`, receipt);
      lastReceipt = { requestId };

      if (view) await view.begin();
      else await output.diagnostic(`session=${activeSessionId} request=${requestId}`);
      await output.event('submitted', receipt, currentSignal);

      const state: TurnExecutionState = { lastStatus: '' };
      let currentTurnId: string | undefined;

      const callbacks = createTurnCallbacks({
        ctx: { ...ctx, output, view },
        prompter,
        state,
        getTurnId: () => currentTurnId,
        getCurrentSignal: () => currentSignal,
      });

      await transport.streamTurn(activeSessionId, content, callbacks, {
        signal: currentSignal,
        idempotencyKey: requestId,
        toolApprovalMode: 'ask',
        async onAccepted(id) {
          currentTurnId = identifier(id);
          track.turnId = currentTurnId;
          track.ownsTurn = true;
          await saveJson(`${path}.last-run`, { ...receipt, turnId: currentTurnId });
          lastReceipt = { requestId, turnId: currentTurnId };
          if (view) await view.wait();
          else await output.diagnostic(`turn=${currentTurnId}`);
          await output.event('accepted', { sessionId: activeSessionId, turnId: currentTurnId, requestId }, currentSignal);
        },
      });

      const success = state.lastStatus === 'Completed' && !state.interaction;
      await output.result({
        ok: success,
        sessionId: activeSessionId,
        turnId: currentTurnId,
        requestId,
        status: state.lastStatus,
        ...(state.interaction ? { code: state.interaction } : {}),
      });
    }
  } finally {
    prompter.close();
  }
}
