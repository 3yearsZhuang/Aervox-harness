import { performance } from 'node:perf_hooks';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function json(value, path = 'value', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || (!Array.isArray(value) && !plain(value))) throw new TypeError(`${path} must be JSON`);
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) json(value[i], `${path}[${i}]`, ancestors);
  } else {
    for (const [key, child] of Object.entries(value)) json(child, `${path}.${key}`, ancestors);
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${path} must not contain symbols`);
  }
  ancestors.delete(value);
}

function stores(checkedStores) {
  if (!Array.isArray(checkedStores) || !checkedStores.length ||
      checkedStores.some(store => typeof store !== 'string' || !store.trim()) ||
      new Set(checkedStores).size !== checkedStores.length) {
    throw new TypeError('checkedStores must contain distinct nonempty store names');
  }
}

/** Validate the adapter's declared observation scope; this is not a discovery oracle. */
export function validateObservation(checkedStores, observation) {
  stores(checkedStores);
  if (!plain(observation) || !plain(observation.residue) || !own(observation, 'keepSnapshot')) {
    throw new TypeError('observation requires residue and keepSnapshot');
  }
  for (const store of checkedStores) {
    if (!own(observation.residue, store) || !Number.isSafeInteger(observation.residue[store]) || observation.residue[store] < 0) {
      throw new TypeError(`observation requires a nonnegative integer residue for ${store}`);
    }
  }
  json(observation);
  return observation;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function checkpointEvent(event) {
  const required = ['site', 'actor', 'operation', 'kind', 'phase', 'entity'];
  if (!plain(event) || required.some(key => !own(event, key)) ||
      Object.keys(event).some(key => ![...required, 'result'].includes(key)) ||
      typeof event.site !== 'string' || !event.site.trim() ||
      event.actor !== 'producer' || typeof event.operation !== 'string' || !event.operation.trim() ||
      !['read', 'write', 'yield'].includes(event.kind) || !['before', 'after'].includes(event.phase) ||
      !['target', 'keep', 'unknown'].includes(event.entity) ||
      (own(event, 'result') && !['accepted', 'rejected'].includes(event.result))) {
    throw new TypeError('invalid checkpoint event');
  }
  return { ...event };
}

function validatePlan(plan) {
  if (plan === null) return;
  if (!plain(plan) || typeof plan.id !== 'string' || !plan.id || typeof plan.strategy !== 'string' ||
      plan.action !== 'delete' || !plain(plan.trigger) ||
      typeof plan.trigger.site !== 'string' || !plan.trigger.site.trim() ||
      plan.trigger.actor !== 'producer' || !['before', 'after'].includes(plan.trigger.phase) ||
      !Number.isSafeInteger(plan.trigger.occurrence) || plan.trigger.occurrence < 1) {
    throw new TypeError('invalid deletion plan');
  }
  json(plan, 'plan');
}

const message = error => `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;

/**
 * Run a fresh fixture with a single deletion interleaving. A returned remove()
 * means completion according to the adapter contract, not a universal erasure
 * guarantee. The adapter supplies ownership and the checked observation stores.
 *
 * Cancellation is cooperative: open(seed, { signal }) may consume the optional
 * signal, and checkpoints reject after abort. Arbitrary in-process IO cannot be
 * force-killed here. Both the workload and close() waits are nevertheless bounded;
 * adapters must honor cancellation or use externally supervised child processes.
 * Cleanup has an independent deadline, defaulting to the workload deadline.
 */
export async function runSchedule(adapter, { plan = null, seed = 1, timeoutMs = 10_000, cleanupTimeoutMs = timeoutMs } = {}) {
  const started = performance.now();
  const controller = new AbortController();
  const { signal } = controller;
  const evidence = {
    adapterId: typeof adapter?.id === 'string' ? adapter.id : null,
    plan: null, seed, timeoutMs, cleanupTimeoutMs, status: 'infrastructure-error', violations: [], trace: [],
    atCompletion: null, final: null, keepBefore: null, triggerReached: false,
    durationMs: 0, error: null,
  };
  let state, opened = false, closed = false, deletion, timer;
  // close() has its own explicit budget even when the workload used its entire
  // deadline. No implicit one-second cap is applied. Its rejection is observed;
  // a stalled close cannot stall this runner indefinitely.
  const closeState = async () => {
    if (!opened || closed) return;
    closed = true;
    let closeTimer;
    try {
      await Promise.race([
        Promise.resolve().then(() => adapter.close(state)),
        new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('adapter close timeout')), cleanupTimeoutMs); }),
      ]);
    } finally { clearTimeout(closeTimer); }
  };
  const observe = async () => {
    signal.throwIfAborted();
    const observation = await adapter.observe(state);
    signal.throwIfAborted();
    validateObservation(adapter.checkedStores, observation);
    return structuredClone(observation);
  };
  const remove = () => {
    if (!deletion) {
      evidence.triggerReached = true;
      deletion = (async () => {
        signal.throwIfAborted();
        await adapter.remove(state);
        evidence.atCompletion = await observe();
      })();
    }
    return deletion;
  };
  const counts = new Map();
  const checkpoint = async input => {
    signal.throwIfAborted();
    const event = checkpointEvent(input);
    const key = JSON.stringify([event.actor, event.site, event.phase]);
    const occurrence = (counts.get(key) ?? 0) + 1;
    counts.set(key, occurrence);
    evidence.trace.push({ ...event, occurrence });
    const trigger = plan?.trigger;
    if (trigger && ['site', 'actor', 'phase', 'occurrence'].every(key => trigger[key] === evidence.trace.at(-1)[key])) await remove();
    // Concurrent checkpoint calls cannot pass the selected deletion barrier.
    else if (deletion) await deletion;
    signal.throwIfAborted();
  };
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1) throw new TypeError('cleanupTimeoutMs must be a positive integer');
    if (!Number.isSafeInteger(seed)) throw new TypeError('seed must be an integer');
    if (!adapter || typeof adapter.id !== 'string' || !adapter.id.trim() ||
        ['open', 'produce', 'remove', 'observe', 'close'].some(key => typeof adapter[key] !== 'function')) {
      throw new TypeError('invalid adapter');
    }
    stores(adapter.checkedStores);
    validatePlan(plan);
    evidence.plan = structuredClone(plan);
    const work = (async () => {
      state = await adapter.open(seed, { signal });
      opened = true;
      // An open() completing after timeout still receives bounded cleanup.
      if (signal.aborted) { await closeState(); signal.throwIfAborted(); }
      evidence.keepBefore = (await observe()).keepSnapshot;
      await adapter.produce(state, checkpoint);
      signal.throwIfAborted();
      if (plan === null) await remove();
      if (deletion) await deletion;
      evidence.final = await observe();
      if (!evidence.triggerReached) { evidence.status = 'ineligible'; return; }
      const atCompletion = evidence.atCompletion;
      if (adapter.checkedStores.some(store => atCompletion.residue[store] > 0)) evidence.violations.push('false-completion');
      // Store-level resurrection permits a remaining old residue in one store
      // and a distinct newly resurrected store to be reported independently.
      if (adapter.checkedStores.some(store => atCompletion.residue[store] === 0 && evidence.final.residue[store] > 0)) evidence.violations.push('resurrection');
      if ([atCompletion, evidence.final].some(observation => canonical(observation.keepSnapshot) !== canonical(evidence.keepBefore))) {
        evidence.violations.push('retained-data-changed');
      }
      evidence.status = 'completed';
    })();
    await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('schedule timeout');
          error.name = 'TimeoutError';
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    evidence.status = 'infrastructure-error';
    evidence.violations = [];
    evidence.error = message(error);
    if (!signal.aborted) controller.abort(error);
  } finally {
    clearTimeout(timer);
    try { await closeState(); }
    catch (error) {
      evidence.status = 'infrastructure-error';
      evidence.violations = [];
      evidence.error = evidence.error ? `${evidence.error}; ${message(error)}` : message(error);
      if (!signal.aborted) controller.abort(error);
    }
    evidence.durationMs = performance.now() - started;
  }
  // A late, non-cooperative adapter must not mutate evidence already returned to
  // the caller. Detached work promises have rejection handlers via Promise.race.
  return structuredClone(evidence);
}
