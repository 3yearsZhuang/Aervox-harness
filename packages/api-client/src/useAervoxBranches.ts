import { branchesApi, type ConversationBranchResponse, type CreateBranchRequest } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import { getTransport, type AervoxTransport } from './transport.js';

export type ConversationBranchDto = ConversationBranchResponse;

/** Shared branch operations keep their wire semantics and validate both boundaries. */
export function useAervoxBranches(transport: AervoxTransport = getTransport()) {
  return {
    createBranch: (sessionId: string, input: CreateBranchRequest): Promise<ConversationBranchDto> =>
      requestEndpoint(transport, branchesApi.create, input, { sessionId }),
    listBranches: async (sessionId: string): Promise<ConversationBranchDto[]> =>
      (await requestEndpoint(transport, branchesApi.list, undefined, { sessionId })).items,
    getBranchTree: async (sessionId: string): Promise<ConversationBranchDto[]> =>
      (await requestEndpoint(transport, branchesApi.tree, undefined, { sessionId })).items,
    getBranch: (branchId: string): Promise<ConversationBranchDto> =>
      requestEndpoint(transport, branchesApi.get, undefined, { branchId }),
    mergeBranch: (branchId: string): Promise<ConversationBranchDto> =>
      requestEndpoint(transport, branchesApi.merge, undefined, { branchId }),
    archiveBranch: (branchId: string): Promise<ConversationBranchDto> =>
      requestEndpoint(transport, branchesApi.archive, undefined, { branchId }),
    updateBranchLayout: (branchId: string, layoutData: unknown): Promise<ConversationBranchDto> =>
      requestEndpoint(transport, branchesApi.updateLayout, { layoutData }, { branchId }),
    deleteBranch: (branchId: string): Promise<ConversationBranchDto> =>
      requestEndpoint(transport, branchesApi.delete, undefined, { branchId }),
  };
}
