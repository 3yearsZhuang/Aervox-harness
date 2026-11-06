import { expect, it } from 'vitest';
import { buildOpenApiDocument, personaApi, personaRevisionConfigSchema } from '../src/index.js';

it('keeps an optional presentation binding and rejects empty or malformed identifiers', () => {
  expect(personaRevisionConfigSchema.parse({ systemPromptAppend: 'Hello' })).toEqual({ systemPromptAppend: 'Hello' });
  expect(personaRevisionConfigSchema.parse({ systemPromptAppend: 'Hello', live2dModelId: ' mizuki-default ' }))
    .toEqual({ systemPromptAppend: 'Hello', live2dModelId: 'mizuki-default' });
  for (const live2dModelId of ['', '   ', null, 12, 'x'.repeat(129)]) {
    expect(personaRevisionConfigSchema.safeParse({ systemPromptAppend: 'Hello', live2dModelId }).success).toBe(false);
  }
});

it('documents the optional revision query on the existing persona detail operation', () => {
  expect(personaApi.get.query.parse({})).toEqual({});
  expect(personaApi.get.query.parse({ revisionId: 'old-revision' })).toEqual({ revisionId: 'old-revision' });
  expect(personaApi.get.query.safeParse({ revisionId: '' }).success).toBe(false);
  const operation = buildOpenApiDocument().paths?.[personaApi.get.path]?.get;
  expect(operation?.parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'revisionId', in: 'query', required: false }),
  ]));
  expect(operation?.responses?.[400]).toBeDefined();
});
