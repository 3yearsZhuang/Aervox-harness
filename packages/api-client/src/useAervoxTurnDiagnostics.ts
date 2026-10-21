import { turnDiagnosticsApi } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import { getTransport, type AervoxTransport } from './transport.js';

export function useAervoxTurnDiagnostics(transport: AervoxTransport = getTransport()) {
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
