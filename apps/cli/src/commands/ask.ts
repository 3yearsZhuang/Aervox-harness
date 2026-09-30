import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { CliError, identifier, saveJson } from '../config.js';
import { readStreamInput, TerminalPrompter } from '../input.js';
import { createTurnCallbacks, type TurnExecutionState } from '../turn-callbacks.js';
import type { CommandContext } from './types.js';

export async function executeAsk(ctx: CommandContext): Promise<number> {
  const { options, positionals, io, output, apiBase, path, transport, timedSignal, cleanupController, track } = ctx;
  const rest = positionals.slice(1);
  if (options.file && rest.length) {
    throw new CliError('usage', '--file 与问题参数不能同时使用。', 2);
  }

  let activeSessionId = ctx.sessionId;
  if (!activeSessionId) {
    activeSessionId = `cli_${randomUUID()}`;
  }
  track.sessionId = activeSessionId;

  const currentSignal = timedSignal();
  track.currentSignal = currentSignal;

  let content: string;
  if (options.file) {
    content = await readStreamInput(createReadStream(options.file), currentSignal);
  } else if (rest.length) {
    content = rest.join(' ').trim();
  } else if (!io.input.isTTY) {
    content = await readStreamInput(io.input, currentSignal);
  } else {
    throw new CliError('usage', 'ask 需要问题参数、--file 或 stdin。', 2);
  }

  if (!content || Buffer.byteLength(content) > 65_536) {
    throw new CliError('input_limit', '问题不能为空且不得超过 64 KiB。', 2);
  }

  const requestId = options['request-id'] ? identifier(options['request-id']) : `cli_${randomUUID()}`;
  track.requestId = requestId;

  const receipt = { version: 1, apiBase, sessionId: activeSessionId, requestId };
  await saveJson(`${path}.last-run`, receipt);
  await output.diagnostic(`session=${activeSessionId} request=${requestId}`);
  await output.event('submitted', receipt, currentSignal);

  const prompter = new TerminalPrompter(io, cleanupController);
  const state: TurnExecutionState = { lastStatus: '' };

  let currentTurnId: string | undefined;
  const callbacks = createTurnCallbacks({
    ctx,
    prompter,
    state,
    getTurnId: () => currentTurnId,
    getCurrentSignal: () => currentSignal,
  });

  try {
    await transport.streamTurn(activeSessionId, content, callbacks, {
      signal: currentSignal,
      idempotencyKey: requestId,
      toolApprovalMode: 'ask',
      async onAccepted(id) {
        currentTurnId = identifier(id);
        track.turnId = currentTurnId;
        track.ownsTurn = true;
        await saveJson(`${path}.last-run`, { ...receipt, turnId: currentTurnId });
        await output.diagnostic(`turn=${currentTurnId}`);
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

    return state.interaction ? 4 : success ? 0 : 1;
  } finally {
    prompter.close();
  }
}
