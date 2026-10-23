import { getClientTransport } from './client-context.js';
import { turnDiagnosticsApi } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import { type AervoxTransport } from './transport';

export function useAervoxTurnDiagnostics(transport: AervoxTransport = getClientTransport()) {
  return {
    async get(turnId: string, attemptId?: string) {
      const report = await requestEndpoint(transport, turnDiagnosticsApi.get, undefined, { turnId }, { attemptId });
      if (report.turnId !== turnId || (attemptId !== undefined && report.selectedAttemptId !== attemptId)) {
        throw new Error('diagnostics_identity_mismatch');
      }
      return report;
    },
  };
}
