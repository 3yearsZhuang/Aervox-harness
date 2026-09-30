import type { Readable, Writable } from 'node:stream';
import type { createFetchTransport } from '@aervox/api-client/transport';
import type { Settings } from '../config.js';
import type { Output } from '../output.js';
import type { ChatTerminal } from '../terminal.js';

export interface CliIO {
  input: Readable & { isTTY?: boolean };
  output: Writable & { isTTY?: boolean; columns?: number };
  error: Writable & { isTTY?: boolean; columns?: number };
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ParsedCliOptions {
  help?: boolean;
  version?: boolean;
  'api-base'?: string;
  session?: string;
  file?: string;
  json?: boolean;
  jsonl?: boolean;
  timeout?: string;
  'request-id'?: string;
}

export interface TrackState {
  turnId?: string;
  requestId?: string;
  sessionId?: string;
  ownsTurn: boolean;
  terminal: boolean;
  transport?: ReturnType<typeof createFetchTransport>;
  currentSignal?: AbortSignal;
}

export interface CommandContext {
  argv: string[];
  options: ParsedCliOptions;
  positionals: string[];
  io: CliIO;
  output: Output;
  path: string;
  settings: Settings;
  apiBase: string;
  token?: string;
  timeoutMs: number;
  sessionId?: string;
  transport: ReturnType<typeof createFetchTransport>;
  timedSignal: () => AbortSignal;
  interactiveSignal: AbortSignal;
  cleanupController: AbortController;
  track: TrackState;
  view?: ChatTerminal;
}
