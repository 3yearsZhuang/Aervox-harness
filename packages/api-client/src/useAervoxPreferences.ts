import { preferencesApi, type SavePreferencesRequest, type UpdatePreferencesRequest } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import { getTransport, type AervoxTransport } from './transport.js';

export function useAervoxPreferences(transport: AervoxTransport = getTransport()) {
  return {
    get: () => requestEndpoint(transport, preferencesApi.get),
    save: (input: SavePreferencesRequest) => requestEndpoint(transport, preferencesApi.save, input),
    update: (input: UpdatePreferencesRequest) => requestEndpoint(transport, preferencesApi.update, input),
    reset: () => requestEndpoint(transport, preferencesApi.reset),
  };
}
