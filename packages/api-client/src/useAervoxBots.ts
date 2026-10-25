import { getClientTransport } from './client-context.js';
import type {
  BotAdapterDescriptor, BotConnection, BotDelivery, BotLogin, BotPairing,
  CreateBotConnectionRequest, UpdateBotConnectionRequest,
} from '@aervox/contracts';


/** Management only: secrets are write-only and never retained in reactive state. */
export function useAervoxBots() {
  const transport = getClientTransport();
  const path = (id: string) => `/v1/bot-connections/${encodeURIComponent(id)}`;
  return {
    async listAdapters(): Promise<BotAdapterDescriptor[]> {
      return (await transport.request<{ adapters: BotAdapterDescriptor[] }>('GET', '/v1/bot-adapters')).adapters;
    },
    async listConnections(): Promise<BotConnection[]> {
      return (await transport.request<{ connections: BotConnection[] }>('GET', '/v1/bot-connections')).connections;
    },
    createConnection: (input: CreateBotConnectionRequest): Promise<BotConnection> =>
      transport.request('POST', '/v1/bot-connections', input),
    updateConnection: (id: string, input: UpdateBotConnectionRequest): Promise<BotConnection> =>
      transport.request('PATCH', path(id), input),
    deleteConnection: (id: string): Promise<void> => transport.request('DELETE', path(id)),
    startLogin: (id: string): Promise<BotLogin> => transport.request('POST', `${path(id)}/login`),
    getLogin: (id: string): Promise<BotLogin> => transport.request('GET', `${path(id)}/login`),
    startPairing: (id: string): Promise<BotPairing> => transport.request('POST', `${path(id)}/pairing`),
    getPairing: (id: string): Promise<BotPairing> => transport.request('GET', `${path(id)}/pairing`),
    confirmPairing: (id: string, senderId: string): Promise<BotPairing> =>
      transport.request('POST', `${path(id)}/pairing/confirm`, { senderId }),
    async listDeliveries(id: string): Promise<BotDelivery[]> {
      return (await transport.request<{ deliveries: BotDelivery[] }>('GET', `${path(id)}/deliveries`)).deliveries;
    },
    retryDelivery: (id: string, deliveryId: string): Promise<BotDelivery> =>
      transport.request('POST', `${path(id)}/deliveries/${encodeURIComponent(deliveryId)}/retry`),
  };
}
