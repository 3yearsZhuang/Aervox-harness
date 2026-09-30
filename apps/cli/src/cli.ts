import { parseArgs } from 'node:util';
import { AervoxHttpError, createFetchTransport } from '@aervox/api-client/transport';
import { CliError, configPath, identifier, localApiBase, readSettings } from './config.js';
import { Output, write } from './output.js';
import { HELP } from './commands/constants.js';
import { executeConfig } from './commands/config.js';
import { executeSessions, executeDoctor } from './commands/sessions.js';
import { executeWatch } from './commands/watch.js';
import { executeAsk } from './commands/ask.js';
import { executeChat } from './commands/chat.js';
import type { CliIO, CommandContext, ParsedCliOptions, TrackState } from './commands/types.js';

export { HELP };
export type { CliIO };

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let output = new Output(argv.includes('--jsonl') ? 'jsonl' : argv.includes('--json') ? 'json' : 'text', io.output, io.error);
  const track: TrackState = { ownsTurn: false, terminal: false };
  const cleanupController = new AbortController();
  const interactiveSignal = AbortSignal.any([cleanupController.signal, ...(io.signal ? [io.signal] : [])]);
  let ctx: CommandContext | undefined;

  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          help: { type: 'boolean', short: 'h' },
          version: { type: 'boolean' },
          'api-base': { type: 'string' },
          session: { type: 'string' },
          file: { type: 'string' },
          json: { type: 'boolean' },
          jsonl: { type: 'boolean' },
          timeout: { type: 'string' },
          'request-id': { type: 'string' },
        },
      });
    } catch {
      throw new CliError('usage', '参数无效；运行 siyu --help 查看用法。', 2);
    }

    const { values, positionals } = parsed;
    const options = values as ParsedCliOptions;
    const [command] = positionals;

    if (options.help || (!command && !options.version)) {
      await write(io.output, HELP);
      return 0;
    }
    if (options.version) {
      await write(io.output, '0.1.0\n');
      return 0;
    }
    if (options.json && options.jsonl) {
      throw new CliError('usage', '--json 与 --jsonl 不能同时使用。', 2);
    }

    output = new Output(options.json ? 'json' : options.jsonl ? 'jsonl' : 'text', io.output, io.error);
    const timeoutMs = Number(options.timeout ?? 120_000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
      throw new CliError('usage', 'timeout 必须为 1000～600000 毫秒。', 2);
    }

    const path = configPath(io.env);
    const settings = await readSettings(path);
    const apiBase = localApiBase(options['api-base'] ?? io.env.SIYU_API_URL ?? settings.apiBase ?? 'http://127.0.0.1:3000');
    const token = io.env.SIYU_API_TOKEN;
    if (token && /[\r\n]/.test(token)) {
      throw new CliError('invalid_config', 'API Token 格式无效。', 2);
    }

    const rawSessionId = options.session ?? io.env.SIYU_SESSION_ID ?? settings.sessionId;
    const sessionId = rawSessionId ? identifier(rawSessionId) : undefined;
    track.sessionId = sessionId;

    const transport = createFetchTransport(apiBase, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      requestTimeoutMs: Math.min(timeoutMs, 30_000),
      streamIdleTimeoutMs: Math.min(timeoutMs, 60_000),
      redirect: 'error',
    });
    track.transport = transport;

    const timedSignal = () => AbortSignal.any([AbortSignal.timeout(timeoutMs), interactiveSignal]);
    track.currentSignal = timedSignal();

    if (command !== 'ask' && (options.file || options['request-id'])) {
      throw new CliError('usage', '--file/--request-id 仅用于 ask。', 2);
    }
    if (command === 'ask' && options['request-id'] && !sessionId) {
      throw new CliError('usage', '--request-id 必须与固定 --session 一起使用。', 2);
    }

    ctx = {
      argv,
      options,
      positionals,
      io,
      output,
      path,
      settings,
      apiBase,
      token,
      timeoutMs,
      sessionId,
      transport,
      timedSignal,
      interactiveSignal,
      cleanupController,
      track,
    };

    switch (command) {
      case 'config':
        return await executeConfig(ctx);
      case 'sessions':
        return await executeSessions(ctx);
      case 'doctor':
        return await executeDoctor(ctx);
      case 'events':
      case 'status':
        return await executeWatch(command, ctx);
      case 'ask':
        return await executeAsk(ctx);
      case 'chat':
        return await executeChat(ctx);
      default:
        throw new CliError('usage', '未知命令；运行 siyu --help。', 2);
    }
  } catch (error) {
    const interruptSignal = io.signal?.aborted ? io.signal : cleanupController.signal;
    const reason = interruptSignal.reason;
    const interrupted = interruptSignal.aborted;
    const exitCode = interrupted
      ? reason === 'SIGTERM' ? 143 : reason === 'SIGPIPE' ? 1 : 130
      : error instanceof CliError ? error.exitCode
      : error instanceof AervoxHttpError && [401, 403].includes(error.status) ? 3
      : track.currentSignal?.aborted || (error as Error).name === 'TimeoutError' ? 5 : 1;

    const code = interrupted
      ? 'interrupted'
      : error instanceof CliError ? error.code
      : exitCode === 3 ? 'authentication'
      : exitCode === 5 ? 'timeout_unknown'
      : 'request_failed';

    // CR-058：只有中断（Ctrl-C / SIGTERM / 断管）才尝试服务端取消。
    // 超时、网络或认证失败属于「状态未知」，服务端回合可能仍在正常推进，
    // 客户端不替用户取消——用户可用 `siyu watch` 追认，避免误杀仍在进行的工作。
    let cancellation: unknown;
    if (interrupted && track.turnId && track.transport && track.ownsTurn && !track.terminal) {
      try {
        await track.transport.cancelTurn(track.turnId, AbortSignal.timeout(3000));
        cancellation = 'requested';
      } catch {
        cancellation = 'unconfirmed';
      }
    }

    const message = error instanceof CliError
      ? error.message
      : exitCode === 3 ? '认证失败，请检查 SIYU_API_TOKEN。'
      : interrupted ? '已停止客户端等待；服务端状态以回合查询为准。'
      : '请求未完成；请检查本机服务、超时或兼容性。已受理请求不会自动重发。';

    const activeOutput = ctx?.output ?? output;
    await activeOutput.failure(code, message, {
      sessionId: track.sessionId,
      turnId: track.turnId,
      requestId: track.requestId,
      ...(cancellation ? { cancellation } : {}),
    }).catch(() => undefined);

    return exitCode;
  } finally {
    ctx?.view?.dispose();
    cleanupController.abort();
  }
}
