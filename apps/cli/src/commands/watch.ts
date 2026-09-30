import { CliError, identifier } from '../config.js';
import { createTurnCallbacks, type TurnExecutionState } from '../turn-callbacks.js';
import type { CommandContext } from './types.js';

export async function executeWatch(command: 'events' | 'status', ctx: CommandContext): Promise<number> {
  const { positionals, transport, timedSignal, output, track } = ctx;
  const rest = positionals.slice(1);
  if (rest.length !== 1) {
    throw new CliError('usage', `${command} 需要一个 turnId。`, 2);
  }
  const turnId = identifier(rest[0]!);
  track.turnId = turnId;
  track.ownsTurn = false;

  const currentSignal = timedSignal();
  track.currentSignal = currentSignal;

  const state: TurnExecutionState = { lastStatus: '' };
  const callbacks = createTurnCallbacks({
    ctx,
    isWatchCommand: true,
    suppressDelta: command === 'status',
    state,
    getTurnId: () => turnId,
    getCurrentSignal: () => currentSignal,
  });

  await transport.watchTurn(turnId, callbacks, currentSignal);
  await output.result({ ok: state.lastStatus === 'Completed', turnId, status: state.lastStatus });
  return state.lastStatus === 'Completed' ? 0 : 1;
}
