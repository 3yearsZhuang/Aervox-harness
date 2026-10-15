#!/usr/bin/env node
/** Conservative structural compatibility gate; wire semantics still require client fixtures. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = path.join(ROOT, 'packages/contracts/compatibility/openapi-v1.json');
export const CORRECTIONS = path.join(ROOT, 'packages/contracts/compatibility/openapi-v1-corrections.json');
const CURRENT = path.join(ROOT, 'packages/contracts/openapi.json');
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
const ANNOTATIONS = new Set(['description', 'summary', 'title', 'example', 'examples', 'externalDocs', 'deprecated', 'tags']);

const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const COMPONENT_MAPS = new Set(['schemas', 'responses', 'parameters', 'examples', 'requestBodies', 'headers', 'securitySchemes', 'links', 'callbacks', 'pathItems']);
const LITERAL_VALUES = new Set(['default', 'const', 'enum', 'example', 'examples', 'security']);

export function canonical(value, context = 'node') {
  if (Array.isArray(value)) return value.map(item => canonical(item, context === 'literal' ? 'literal' : 'node'));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter(key => context !== 'node' || !ANNOTATIONS.has(key))
    .map(key => {
      const child = context === 'literal' || (context === 'node' && LITERAL_VALUES.has(key)) ? 'literal'
        : context === 'node' && (SCHEMA_MAPS.has(key) || COMPONENT_MAPS.has(key) || ['paths', 'content', 'responses', 'callbacks'].includes(key)) ? 'map'
          : 'node';
      return [key, canonical(value[key], child)];
    }));
}
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');

/** Reviewed, exact corrections preserve the historical baseline without suppressing future checks. */
export function applyBaselineCorrections(baseline, corrections) {
  if (corrections.baselineSource !== baseline.source) throw new Error('OpenAPI correction source does not match the baseline');
  const document = structuredClone(baseline.document);
  for (const change of corrections.changes ?? []) {
    if (!change.id || !change.reason || !change.pointer.startsWith('/')) throw new Error('Every baseline correction needs an id, reason and JSON pointer');
    const parts = change.pointer.slice(1).split('/').map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    const field = parts.pop();
    const parent = parts.reduce((node, key) => node?.[key], document);
    if (!parent || typeof parent !== 'object' || fingerprint(parent[field]) !== change.beforeHash) throw new Error(`Stale OpenAPI correction: ${change.id} ${change.pointer}`);
    parent[field] = structuredClone(change.value);
  }
  return document;
}

export function compareOpenApi(previous, current) {
  const issues = [];
  const seen = new Set();
  const add = (at, message) => issues.push(`${at}: ${message}`);
  const resolve = (node, doc) => {
    if (!node?.$ref) return node;
    if (!node.$ref.startsWith('#/')) throw new Error(`Unsupported non-local reference ${node.$ref}`);
    const value = node.$ref.slice(2).split('/').reduce((item, key) => item?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
    if (value === undefined) throw new Error(`Unresolved reference ${node.$ref}`);
    return { ...value, ...Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref')) };
  };
  // Checks producer values are accepted by the consumer. Requests: old -> new; responses: new -> old.
  function subset(producer, consumer, producerDoc, consumerDoc, at) {
    const key = `${at}:${producer?.$ref ?? ''}:${consumer?.$ref ?? ''}`;
    // Reference cycles need pair-level de-duplication independent of the current property path.
    const cycleKey = producer?.$ref || consumer?.$ref ? `${producerDoc === previous ? 'old' : 'new'}:${producer?.$ref ?? JSON.stringify(producer)}|${consumer?.$ref ?? JSON.stringify(consumer)}` : key;
    if (seen.has(cycleKey)) return;
    seen.add(cycleKey);
    const p = resolve(producer, producerDoc);
    const c = resolve(consumer, consumerDoc);
    if ((equal(p, c) && !JSON.stringify(p)?.includes('"$ref"')) || c === true || c === undefined || p === false) return;
    if (c === false || p === true || p === undefined) { add(at, 'accepted schema became narrower'); return; }
    for (const union of ['oneOf', 'anyOf', 'allOf']) {
      if (p[union] || c[union]) {
        // Complex boolean schema edits require deliberate review; no unsafe equivalence guesses.
        if (!equal(p[union], c[union])) add(at, `${union} changed; compatibility needs explicit review`);
        else for (let index = 0; index < (p[union]?.length ?? 0); index++) subset(p[union][index], c[union][index], producerDoc, consumerDoc, `${at}.${union}[${index}]`);
      }
    }
    const types = (schema) => new Set(schema.type ? Array.isArray(schema.type) ? schema.type : [schema.type] : []);
    const pt = types(p); const ct = types(c);
    if (ct.size && (!pt.size || [...pt].some((type) => !ct.has(type) && !(type === 'integer' && ct.has('number'))))) add(at, `type is incompatible (${[...pt].join('|') || 'any'} -> ${[...ct].join('|')})`);
    const values = (schema) => schema.const !== undefined ? [schema.const] : schema.enum;
    const pv = values(p); const cv = values(c);
    if (cv && (!pv || pv.some((value) => !cv.some((allowed) => equal(value, allowed))))) add(at, 'enum/const no longer accepts all values');
    const pRequired = new Set(p.required ?? []);
    for (const field of c.required ?? []) if (!pRequired.has(field)) add(`${at}.${field}`, 'required field may be absent');
    for (const [field, schema] of Object.entries(p.properties ?? {})) {
      const next = c.properties?.[field];
      if (next !== undefined) subset(schema, next, producerDoc, consumerDoc, `${at}.${field}`);
      else if (c.additionalProperties === false) add(`${at}.${field}`, 'property is no longer accepted');
    }
    if (c.additionalProperties === false && p.additionalProperties !== false) add(at, 'additional properties are no longer accepted');
    if (c.additionalProperties && typeof c.additionalProperties === 'object') subset(p.additionalProperties ?? true, c.additionalProperties, producerDoc, consumerDoc, `${at}.*`);
    if (p.items || c.items) subset(p.items ?? true, c.items ?? true, producerDoc, consumerDoc, `${at}[]`);
    for (const limit of ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']) if (c[limit] !== undefined && (p[limit] === undefined || c[limit] > p[limit])) add(at, `${limit} became stricter`);
    for (const limit of ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']) if (c[limit] !== undefined && (p[limit] === undefined || c[limit] < p[limit])) add(at, `${limit} became stricter`);
    for (const constraint of ['pattern', 'format', 'multipleOf', 'uniqueItems']) if (c[constraint] !== undefined && c[constraint] !== false && !equal(p[constraint], c[constraint])) add(at, `${constraint} changed`);
    for (const constraint of ['not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'unevaluatedProperties', 'prefixItems', 'contains']) if (!equal(p[constraint], c[constraint])) add(at, `${constraint} changed; compatibility needs explicit review`);
  }
  function content(oldContent, newContent, direction, at) {
    if (direction === 'response') for (const media of Object.keys(oldContent ?? {})) if (!newContent?.[media]) add(`${at}.${media}`, 'response representation removed');
    const producer = direction === 'request' ? oldContent : newContent;
    const consumer = direction === 'request' ? newContent : oldContent;
    for (const [media, entry] of Object.entries(producer ?? {})) {
      if (!consumer?.[media]) add(`${at}.${media}`, 'media type is no longer accepted');
      else subset(entry.schema, consumer[media].schema, direction === 'request' ? previous : current, direction === 'request' ? current : previous, `${at}.${media}`);
    }
  }
  for (const [route, oldPath] of Object.entries(previous.paths ?? {})) {
    const newPath = current.paths?.[route];
    for (const method of METHODS) {
      if (!oldPath[method]) continue;
      const at = `${method.toUpperCase()} ${route}`;
      const oldOp = oldPath[method]; const newOp = newPath?.[method];
      if (!newOp) { add(at, 'operation removed'); continue; }
      seen.clear();
      const parameters = (pathItem, operation, doc) => [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map((item) => resolve(item, doc));
      const oldParameters = parameters(oldPath, oldOp, previous);
      const newParameters = parameters(newPath, newOp, current);
      for (const parameter of newParameters) {
        const old = oldParameters.find((item) => item.in === parameter.in && item.name === parameter.name);
        if (!old && parameter.required) add(`${at}.${parameter.in}.${parameter.name}`, 'new required parameter');
        if (old) {
          if (parameter.required && !old.required) add(`${at}.${parameter.name}`, 'parameter became required');
          subset(old.schema, parameter.schema, previous, current, `${at}.${parameter.in}.${parameter.name}`);
        }
      }
      const oldBody = resolve(oldOp.requestBody, previous); const newBody = resolve(newOp.requestBody, current);
      if (newBody?.required && !oldBody?.required) add(at, 'request body became required');
      if (oldBody && !newBody) add(at, 'request body removed');
      else content(oldBody?.content, newBody?.content, 'request', `${at}.request`);
      for (const [status, oldResponse] of Object.entries(oldOp.responses ?? {})) {
        if (!newOp.responses?.[status]) { add(`${at}.${status}`, 'response removed'); continue; }
        content(resolve(oldResponse, previous)?.content, resolve(newOp.responses[status], current)?.content, 'response', `${at}.response.${status}`);
      }
      if (!equal(oldOp.security ?? previous.security ?? [], newOp.security ?? current.security ?? [])) add(at, 'authentication requirements changed; review compatibility explicitly');
    }
  }
  return [...new Set(issues)].sort();
}

export function main(args = process.argv.slice(2)) {
  const current = JSON.parse(fs.readFileSync(CURRENT, 'utf8'));
  if (args[0] === '--update') {
    const reason = args[args.indexOf('--reason') + 1];
    if (!args.includes('--reason') || !reason?.trim()) throw new Error('Baseline update requires --reason describing the approved compatibility decision');
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    fs.writeFileSync(BASELINE, `${JSON.stringify({ source, reason, document: canonical(current) }, null, 2)}\n`);
    fs.writeFileSync(CORRECTIONS, `${JSON.stringify({ baselineSource: source, changes: [] }, null, 2)}\n`);
    console.log('Updated OpenAPI baseline and retired its corrections; review both diffs with the compatibility decision.');
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const corrections = JSON.parse(fs.readFileSync(CORRECTIONS, 'utf8'));
  const issues = compareOpenApi(applyBaselineCorrections(baseline, corrections), current);
  if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
  else console.log('OpenAPI structural compatibility passed against the reviewed v1 baseline.');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
