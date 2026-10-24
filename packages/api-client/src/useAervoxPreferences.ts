import { getClientTransport } from './client-context.js';
import { preferencesApi, type SavePreferencesRequest, type UpdatePreferencesRequest } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import { type AervoxTransport } from './transport';

export function useAervoxPreferences(transport: AervoxTransport = getClientTransport()) {
  return {
    get: () => requestEndpoint(transport, preferencesApi.get),
    save: (input: SavePreferencesRequest) => requestEndpoint(transport, preferencesApi.save, input),
    update: (input: UpdatePreferencesRequest) => requestEndpoint(transport, preferencesApi.update, input),
    reset: () => requestEndpoint(transport, preferencesApi.reset),
  };
}
