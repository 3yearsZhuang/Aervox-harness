import { createHash } from 'node:crypto';

const STRATEGIES = ['generic', 'random', 'trace-only', 'guided'];

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function events(trace) {
  if (!Array.isArray(trace)) throw new TypeError('trace must be an array');
  return trace.map(event => {
    if (!event || typeof event !== 'object' || typeof event.site !== 'string' || !event.site.trim() ||
        typeof event.actor !== 'string' || !event.actor.trim() || typeof event.operation !== 'string' || !event.operation.trim() ||
        !['read', 'write', 'yield'].includes(event.kind) || !['before', 'after'].includes(event.phase) ||
        !['target', 'keep', 'unknown'].includes(event.entity) ||
        !Number.isSafeInteger(event.occurrence) || event.occurrence < 1) {
      throw new TypeError('trace contains an invalid checkpoint event');
    }
    return event;
  });
}

/**
 * Generate single-deletion plans without using any oracle outcomes. guided is a
 * conservative name join with source write candidates, not dataflow analysis:
 * aliases and unobserved paths may be excluded, and candidate matches can be
 * false positives. Ownership still comes from the manually supplied adapter.
 */
export function generatePlans(trace, { strategy = 'guided', budget = 8, seed = 1, candidates = [] } = {}) {
  if (!STRATEGIES.includes(strategy)) throw new TypeError(`unknown strategy: ${strategy}`);
  if (!Number.isSafeInteger(budget) || budget < 0) throw new TypeError('budget must be a nonnegative integer');
  if (!Number.isSafeInteger(seed)) throw new TypeError('seed must be an integer');
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  const observed = events(trace);
  const supported = new Set(candidates.filter(candidate => candidate?.kind === 'write')
    .flatMap(candidate => [candidate.method, candidate.enclosingMethod])
    .filter(method => typeof method === 'string' && method.trim() && method !== '<anonymous>'));
  const candidateWrite = event => event.actor === 'producer' && event.entity === 'target' &&
    event.kind === 'write' && supported.has(event.operation);
  let selected = observed.filter((event, index) => {
    if (event.actor !== 'producer') return false;
    if (strategy === 'generic' || strategy === 'random') return true;
    if (event.entity !== 'target') return false;
    if (event.kind === 'write' && event.phase === 'before') return strategy === 'trace-only' || candidateWrite(event);
    if (event.kind !== 'read' || event.phase !== 'after') return false;
    return strategy === 'trace-only' || observed.slice(index + 1).some(future =>
      future.actor === event.actor && candidateWrite(future));
  });
  const seen = new Set();
  selected = selected.filter(event => {
    const key = JSON.stringify([event.actor, event.site, event.phase, event.occurrence]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (strategy === 'random') {
    const next = random(seed);
    for (let i = selected.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [selected[i], selected[j]] = [selected[j], selected[i]];
    }
  }
  return selected.slice(0, budget).map(event => {
    const trigger = { site: event.site, actor: event.actor, phase: event.phase, occurrence: event.occurrence };
    const content = { strategy, action: 'delete', trigger };
    return { id: `delete:${createHash('sha256').update(JSON.stringify(content)).digest('hex')}`, ...content };
  });
}
