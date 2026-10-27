import type { ApiProblem } from '@aervox/contracts';

export class AervoxHttpError extends Error {
  readonly code?: string;
  readonly requestId?: string;
  readonly details?: unknown;
  constructor(public readonly status: number, path: string, public readonly problem?: Partial<ApiProblem>) {
    super(problem?.message ?? problem?.detail ?? `API ${path} → HTTP ${status}`);
    this.name = 'AervoxHttpError';
    this.code = problem?.code;
    this.requestId = problem?.requestId;
    this.details = problem?.details;
  }
}

/** Only structured JSON errors are exposed; arbitrary proxy/HTML bodies stay private. */
