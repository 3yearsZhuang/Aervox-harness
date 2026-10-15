import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareOpenApi } from './openapi-compat.mjs';

const document = () => {
  const input = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
  const output = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, state: { type: 'string', enum: ['active'] } } };
  return { openapi: '3.1.0', paths: { '/v1/example': { post: {
    requestBody: { content: { 'application/json': { schema: input } } },
    responses: { 200: { content: { 'application/json': { schema: output } } } },
  } } } };
};
const response = (doc) => doc.paths['/v1/example'].post.responses[200].content['application/json'].schema;
const request = (doc) => doc.paths['/v1/example'].post.requestBody.content['application/json'].schema;

test('permits optional additive fields, response enum narrowing and descriptive edits', () => {
  const before = document(); const after = structuredClone(before);
  request(after).properties.note = { type: 'string' };
  response(after).properties.extra = { type: 'string' };
  response(after).description = 'New explanation';
  assert.deepEqual(compareOpenApi(before, after), []);
});
test('rejects removed operations, new required inputs and removed required output fields', () => {
  const before = document(); const after = structuredClone(before);
  request(after).required.push('token'); request(after).properties.token = { type: 'string' };
  response(after).required = [];
  const issues = compareOpenApi(before, after).join('\n');
  assert.match(issues, /token.*required/); assert.match(issues, /id.*required/);
  delete after.paths['/v1/example'].post;
  assert.match(compareOpenApi(before, after).join('\n'), /operation removed/);
});
test('rejects response enum expansion and tighter request bounds', () => {
  const before = document(); const after = structuredClone(before);
  response(after).properties.state.enum.push('pending');
  request(after).properties.name.minLength = 5;
  const issues = compareOpenApi(before, after).join('\n');
  assert.match(issues, /enum/); assert.match(issues, /minLength/);
});
test('follows changed nested references and terminates recursive schemas', () => {
  const before = document(); const after = structuredClone(before);
  for (const doc of [before, after]) {
    doc.components = { schemas: { Entry: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, child: { $ref: '#/components/schemas/Entry' } } } } };
    doc.paths['/v1/example'].post.responses[200].content['application/json'].schema = { $ref: '#/components/schemas/Entry' };
  }
  after.components.schemas.Entry.properties.id = { type: 'number' };
  assert.match(compareOpenApi(before, after).join('\n'), /id.*type/);
});
test('rejects changed referenced children even when parent schemas are identical', () => {
  const before = document(); const after = structuredClone(before);
  for (const doc of [before, after]) {
    doc.components = { schemas: { Id: { type: 'string' } } };
    response(doc).properties.id = { $ref: '#/components/schemas/Id' };
  }
  after.components.schemas.Id.type = 'number';
  assert.match(compareOpenApi(before, after).join('\n'), /id.*type/);
});
test('unknown external and broken references fail the gate', () => {
  const before = document(); const after = structuredClone(before);
  response(after).properties.id = { $ref: 'https://invalid.example/schema' };
  assert.throws(() => compareOpenApi(before, after), /non-local reference/);
});

test('exact corrections reject stale baselines and do not exempt later schema changes', async () => {
  const { applyBaselineCorrections, fingerprint } = await import('./openapi-compat.mjs');
  const baseline = { source: 'reviewed-commit', document: document() };
  const corrected = structuredClone(baseline.document);
  const pointer = '/paths/~1v1~1example/post/responses/200/content/application~1json/schema';
  const value = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
  const corrections = { baselineSource: baseline.source, changes: [{ id: 'approved-fix', reason: 'Correct formerly inaccurate response contract', pointer, beforeHash: fingerprint(response(baseline.document)), value }] };
  const approved = applyBaselineCorrections(baseline, corrections);
  assert.deepEqual(response(approved), value);
  assert.throws(() => applyBaselineCorrections({ ...baseline, source: 'other' }, corrections), /source/);
  assert.throws(() => applyBaselineCorrections(baseline, { ...corrections, changes: [{ ...corrections.changes[0], beforeHash: 'wrong' }] }), /Stale/);
  response(corrected).properties.id = { type: 'number' };
  assert.match(compareOpenApi(approved, corrected).join('\n'), /id.*type/);
});

test('removing a documented response representation fails', () => {
  const before = document(); const after = structuredClone(before);
  delete after.paths['/v1/example'].post.responses[200].content;
  assert.match(compareOpenApi(before, after).join('\n'), /representation removed/);
});
