import { privacyApi, type ConsentQuery, type CreateDeletionRequest, type GrantConsentRequest } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import { getTransport, type AervoxTransport } from './transport.js';

export function useAervoxPrivacy(transport: AervoxTransport = getTransport()) {
  return {
    grantConsent: (input: GrantConsentRequest) => requestEndpoint(transport, privacyApi.grantConsent, input),
    revokeConsent: (grantId: string) => requestEndpoint(transport, privacyApi.revokeConsent, undefined, { grantId }),
    getActiveConsent: (query: ConsentQuery = {}) => requestEndpoint(transport, privacyApi.activeConsent, undefined, undefined, query),
    createDeletion: (input: CreateDeletionRequest) => requestEndpoint(transport, privacyApi.createDeletion, input),
  };
}
