import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, sessionHistoryApi, sessionHistoryMessageSchema, sessionHistoryQuerySchema } from '../src/index.js';
describe('owner history contract', () => {
  it('declares one authenticated read with cursor, query and explicit resource-budget failures', () => {
    const endpoint = sessionHistoryApi.get, operation = buildOpenApiDocument().paths?.[endpoint.path]?.get;
    expect(operation?.operationId).toBe(endpoint.operationId);
    for (const status of ['200', '400', '401', '404', '410', '422']) expect(operation?.responses?.[status]).toBeDefined();
    expect(sessionHistoryQuerySchema.parse({})).toEqual({});
    for (const input of [{limit:'0'}, {limit:'51'}, {limit:'01'}, {limit:['1', '2']}, {includeRaw:'true'}]) expect(sessionHistoryQuerySchema.safeParse(input).success).toBe(false);
  });
  it('never accepts a withheld record that carries a body', () => {
    const message = { messageId: null, versionId: 'version', version: 1, role: 'assistant', contentKind: 'message',
      content: null, visibility: 'withheld', legacy: true, readOnly: true, createdAt: 'time' };
    expect(sessionHistoryMessageSchema.safeParse(message).success).toBe(true);
    expect(sessionHistoryMessageSchema.safeParse({...message, content:'hidden canary'}).success).toBe(false);
  });
});
