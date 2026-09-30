import type { TurnCallbacks } from '@aervox/api-client/transport';
import { CliError } from './config.js';
import type { CommandContext } from './commands/types.js';
import type { TerminalPrompter } from './input.js';

export interface TurnExecutionState {
  lastStatus: string;
  interaction?: 'needs_approval' | 'approval_recorded';
}

export interface TurnCallbackOptions {
  ctx: CommandContext;
  prompter?: TerminalPrompter;
  isWatchCommand?: boolean;
  suppressDelta?: boolean;
  state: TurnExecutionState;
  getTurnId: () => string | undefined;
  getCurrentSignal: () => AbortSignal;
}

export function createTurnCallbacks(options: TurnCallbackOptions): TurnCallbacks {
  const { ctx, prompter, isWatchCommand, suppressDelta, state, getTurnId, getCurrentSignal } = options;
  const { output, io, transport, view, track } = ctx;

  return {
    onDelta() {},
    onDone() {},
    onError() {},
    async onEvent(event) {
      const turnId = getTurnId();
      if (event.turnId !== turnId || !Number.isInteger(event.sequence) || event.sequence < 1) {
        throw new CliError('protocol', '事件归属或序号无效。');
      }
      if (!event.data || typeof event.data !== 'object') {
        throw new CliError('protocol', '事件数据格式无效。');
      }
      const data = event.data as Record<string, unknown>;
      const currentSignal = getCurrentSignal();

      if (event.eventType === 'delta' && typeof data.text === 'string' && !suppressDelta) {
        await output.delta(data.text, currentSignal, { turnId, eventId: event.eventId, sequence: event.sequence });
      }
      if (event.eventType === 'error') {
        track.terminal = true;
        throw new CliError('turn_failed', '服务端回合失败；请使用回合标识查询诊断。');
      }
      if (event.eventType === 'done') {
        track.terminal = true;
        state.lastStatus = data.isComplete === true && typeof data.status === 'string' ? data.status : 'Unknown';
      }

      // 只补读旧事件时不能再次提交审批或答案。
      if (isWatchCommand) return;

      if (event.eventType === 'tool_approval_required') {
        await view?.interaction();
        const approvalId = typeof data.approvalId === 'string' ? data.approvalId : '';
        if (!approvalId || !turnId) throw new CliError('protocol', '审批事件缺少标识。');
        state.interaction = 'needs_approval';
        await output.event('needs_approval', { turnId, approvalId, toolName: data.toolName });
        if (!io.input.isTTY || !prompter) {
          throw new CliError('needs_approval', '写操作需要交互审批；未自动授权。', 4);
        }
        const answer = await prompter.prompt(
          `工具：${String(data.toolName)}\n参数：${String(data.argumentsHash)}\n允许此调用？[y/N] `,
          AbortSignal.any([currentSignal, AbortSignal.timeout(30_000)]),
        );
        const granted = /^(y|yes)$/i.test(answer.trim());
        await transport.decideToolApproval(turnId, approvalId, granted ? 'granted' : 'denied', currentSignal);
        state.interaction = granted ? 'approval_recorded' : 'needs_approval';
        await output.diagnostic('审批决定已提交；本客户端不会自动重发或重放工具调用。');
        await view?.wait();
      }

      if (event.eventType === 'user_question_required') {
        await view?.interaction();
        if (!io.input.isTTY || !prompter) {
          throw new CliError('needs_input', '模型请求补充信息，请在交互终端继续。', 4);
        }
        if (!Array.isArray(data.questions) || data.questions.length > 10 || !turnId) {
          throw new CliError('protocol', '提问事件格式无效。');
        }
        const answers: { id: string; selected: string[]; custom: string }[] = [];
        for (const item of data.questions) {
          const question = item as { id: string; question: string; options?: { label: string }[] };
          if (typeof question.id !== 'string' || typeof question.question !== 'string') {
            throw new CliError('protocol', '问题格式无效。');
          }
          const optionsList = (question.options ?? []).map(o => o.label).join(' / ');
          const answer = await prompter.prompt(`${question.question}${optionsList ? `（${optionsList}）` : ''}\n回答 > `, currentSignal);
          answers.push({ id: question.id, selected: [], custom: answer });
        }
        await transport.submitQuestionAnswers(turnId, answers, currentSignal);
        await view?.wait();
      }
    },
  };
}
