import { getClientTransport } from './client-context.js';
import { feedbackApi, type CreateFeedbackRequest, type FeedbackListQuery } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import { type AervoxTransport } from './transport';

export function useAervoxFeedback(transport: AervoxTransport = getClientTransport()) {
  return {
    createFeedback: async (input: CreateFeedbackRequest) => requestEndpoint(transport, feedbackApi.create, feedbackApi.create.body.parse(input)),
    listFeedback: async (query: FeedbackListQuery = {}) => {
      const response = await requestEndpoint(transport, feedbackApi.list, undefined, undefined, feedbackApi.list.query.parse(query));
      return response.items;
    },
  };
}
