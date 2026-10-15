import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  botAdapterListResponseSchema, botConnectionListResponseSchema, botConnectionSchema,
  botDeliveryListResponseSchema, botDeliverySchema, botLoginSchema, botPairingSchema,
  confirmBotPairingRequestSchema, createBotConnectionRequestSchema, updateBotConnectionRequestSchema,
} from './bot-schemas.js';

/** Host-managed adapter connections; installed declarative plugins cannot add executable code here. */
export function registerBotOpenApi(registry: OpenAPIRegistry): void {
  const params = z.object({ id: z.string().min(1) });
  const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
  const response = (schema: z.ZodType) => ({ description: 'Success', content: json(schema) });
  registry.registerPath({ method: 'get', path: '/v1/bot-adapters', tags: ['Bots'], summary: 'List trusted adapter implementations', responses: { 200: response(botAdapterListResponseSchema) } });
  registry.registerPath({ method: 'get', path: '/v1/bot-connections', tags: ['Bots'], summary: 'List connections without credentials', responses: { 200: response(botConnectionListResponseSchema) } });
  registry.registerPath({ method: 'post', path: '/v1/bot-connections', tags: ['Bots'], summary: 'Create an adapter connection', request: { body: { required: true, content: json(createBotConnectionRequestSchema) } }, responses: { 201: response(botConnectionSchema) } });
  registry.registerPath({ method: 'patch', path: '/v1/bot-connections/{id}', tags: ['Bots'], summary: 'Configure or enable a connection with revision protection', request: { params, body: { required: true, content: json(updateBotConnectionRequestSchema) } }, responses: { 200: response(botConnectionSchema), 409: { description: 'Connection revision changed; reload before editing' } } });
  registry.registerPath({ method: 'delete', path: '/v1/bot-connections/{id}', tags: ['Bots'], summary: 'Stop and delete a connection', request: { params }, responses: { 204: { description: 'Connection deleted' } } });
  for (const method of ['get', 'post'] as const) {
    registry.registerPath({ method, path: '/v1/bot-connections/{id}/login', tags: ['Bots'], summary: method === 'post' ? 'Start QR login' : 'Get QR login status', request: { params }, responses: { 200: response(botLoginSchema) } });
    registry.registerPath({ method, path: '/v1/bot-connections/{id}/pairing', tags: ['Bots'], summary: method === 'post' ? 'Start one-time owner pairing' : 'Get owner pairing status', request: { params }, responses: { 200: response(botPairingSchema) } });
  }
  registry.registerPath({ method: 'post', path: '/v1/bot-connections/{id}/pairing/confirm', tags: ['Bots'], summary: 'Explicitly confirm the pending owner identity', request: { params, body: { required: true, content: json(confirmBotPairingRequestSchema) } }, responses: { 200: response(botPairingSchema) } });
  registry.registerPath({ method: 'get', path: '/v1/bot-connections/{id}/deliveries', tags: ['Bots'], summary: 'List visible reply delivery receipts', request: { params }, responses: { 200: response(botDeliveryListResponseSchema) } });
  registry.registerPath({ method: 'post', path: '/v1/bot-connections/{id}/deliveries/{deliveryId}/retry', tags: ['Bots'], summary: 'Explicitly resend a failed or unknown delivery', request: { params: z.object({ id: z.string().min(1), deliveryId: z.string().min(1) }) }, responses: { 200: response(botDeliverySchema), 409: { description: 'Delivery is already pending or accepted' } } });
}
