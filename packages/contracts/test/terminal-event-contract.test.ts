import { expect, it } from 'vitest';
import { buildOpenApiDocument, doneEventDataSchema, projectSafeEventData } from '../src/index.js';

it('preserves terminal reasons in the public schema, safe projection and OpenAPI', () => {
  const data = {status: 'Interrupted', isComplete: false, lastSequence: 3, reason: 'max_steps'};
  expect(doneEventDataSchema.parse(data)).toEqual(data);
  expect(projectSafeEventData('done', {...data, internal: 'not public'})).toEqual(data);
  const schema = buildOpenApiDocument().components?.schemas?.DoneEventData;
  expect(schema).toMatchObject({properties: {reason: {type: 'string'}}});
  expect(schema && !('$ref' in schema) ? schema.required : []).not.toContain('reason');
  expect(doneEventDataSchema.parse({status: 'Completed', isComplete: true, lastSequence: 4})).not.toHaveProperty('reason');
});
