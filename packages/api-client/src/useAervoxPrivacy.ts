import { getClientTransport } from './client-context.js';
import { privacyApi, type ConsentQuery, type CreateDeletionRequest, type GrantConsentRequest } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import { type AervoxTransport } from './transport';

export function useAervoxPrivacy(transport: AervoxTransport = getClientTransport()) {
  return {
    grantConsent: (input: GrantConsentRequest) => requestEndpoint(transport, privacyApi.grantConsent, input),
    revokeConsent: (grantId: string) => requestEndpoint(transport, privacyApi.revokeConsent, undefined, { grantId }),
    getActiveConsent: (query: ConsentQuery = {}) => requestEndpoint(transport, privacyApi.activeConsent, undefined, undefined, query),
    createDeletion: (input: CreateDeletionRequest) => requestEndpoint(transport, privacyApi.createDeletion, input),
  };
}
