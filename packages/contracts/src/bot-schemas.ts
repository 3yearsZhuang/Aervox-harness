import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

const identifier = z.string().trim().min(1).max(200);

export const botConnectionStateSchema = z.enum(['stopped', 'connecting', 'connected', 'reconnecting', 'login_required', 'error']);
export const botAdapterDescriptorSchema = z.object({
  id: identifier,
  displayName: z.string().min(1),
  platform: z.string().min(1),
  capabilities: z.object({
    directMessages: z.boolean(),
    groupMessages: z.boolean(),
    login: z.boolean(),
    maxTextLength: z.number().int().positive(),
  }),
});

/** Public configuration contains no access token, login cursor, or protocol session secret. */
export const botConnectionConfigSchema = z.object({
  endpoint: z.string().url().max(2048).refine(value => {
    const url = new URL(value);
    // This field is returned by management reads. Authentication belongs only in secretValues.
    return !url.username && !url.password && !url.search && !url.hash;
  }, 'Endpoint must not contain credentials, a query, or a fragment').optional(),
  accountId: identifier.optional(),
  allowedGroupIds: z.array(identifier).max(100).optional(),
}).strict();

export const botConnectionSchema = z.object({
  id: identifier,
  adapterId: identifier,
  displayName: z.string().min(1).max(100),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  config: botConnectionConfigSchema,
  state: botConnectionStateSchema,
  ownerSenderId: identifier.optional(),
  hasCredentials: z.boolean(),
  lastError: z.string().optional(),
});

const secretValuesSchema = z.object({ token: z.string().max(16384).optional() }).strict();
export const createBotConnectionRequestSchema = z.object({
  adapterId: identifier,
  displayName: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(false),
  config: botConnectionConfigSchema.default({}),
  secretValues: secretValuesSchema.optional(),
}).strict();
export const updateBotConnectionRequestSchema = z.object({
  revision: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  config: botConnectionConfigSchema.optional(),
  secretValues: secretValuesSchema.optional(),
}).strict();

export const botLoginSchema = z.object({
  status: z.enum(['waiting', 'scanned', 'confirmed', 'expired']),
  qrCodeUrl: z.string().url().optional(),
  expiresAt: z.string().datetime().optional(),
  accountId: identifier.optional(),
  message: z.string().optional(),
});
export const botPairingSchema = z.object({
  code: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  candidateSenderId: identifier.optional(),
  confirmed: z.boolean(),
});
export const confirmBotPairingRequestSchema = z.object({ senderId: identifier }).strict();
export const botDeliverySchema = z.object({
  id: identifier,
  connectionId: identifier,
  status: z.enum(['queued', 'sending', 'accepted', 'failed', 'unknown']),
  text: z.string(),
  partIndex: z.number().int().nonnegative(),
  platformMessageId: z.string().optional(),
  lastError: z.string().optional(),
  createdAt: z.string(),
});
export const botAdapterListResponseSchema = z.object({ adapters: z.array(botAdapterDescriptorSchema) });
export const botConnectionListResponseSchema = z.object({ connections: z.array(botConnectionSchema) });
export const botDeliveryListResponseSchema = z.object({ deliveries: z.array(botDeliverySchema) });

export type BotAdapterDescriptor = z.infer<typeof botAdapterDescriptorSchema>;
export type BotConnection = z.infer<typeof botConnectionSchema>;
export type BotConnectionConfig = z.infer<typeof botConnectionConfigSchema>;
export type CreateBotConnectionRequest = z.input<typeof createBotConnectionRequestSchema>;
export type UpdateBotConnectionRequest = z.infer<typeof updateBotConnectionRequestSchema>;
export type BotLogin = z.infer<typeof botLoginSchema>;
export type BotPairing = z.infer<typeof botPairingSchema>;
export type BotDelivery = z.infer<typeof botDeliverySchema>;
