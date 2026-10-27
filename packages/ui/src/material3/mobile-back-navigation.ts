import { inject, nextTick, type InjectionKey } from 'vue';

/** UI-only ownership. No draft, request, session or business cancellation data enters history. */
export interface MobileBackLayer {
  /** An explicit UI close consumes its history guard once. */
  close(): void;
  /** Component disposal only retires ownership; it never navigates a later page. */
  dispose(): void;
}
export interface MobileBackNavigation {
  registerLayer(options: { onBack(): void; canDismiss?(): boolean }): MobileBackLayer;
  /** Flush queued UI closes and await their guard traversal before replacing the document. */
  whenSettled(): Promise<void>;
  dispose(): void;
}
interface HistoryEntryMetadata {
  readonly key: string;
  readonly index: number;
  readonly url: string | null;
  readonly sameDocument: boolean;
}
export interface MobileBackHost {
  /** Read-only metadata proves an inherited guard can be consumed in this document. */
  readonly navigation?: {
    readonly currentEntry: HistoryEntryMetadata | null;
    entries(): readonly HistoryEntryMetadata[];
    traverseTo(key: string): { committed: Promise<unknown>; finished: Promise<unknown> };
  };
  readonly history: Pick<History, 'state' | 'pushState' | 'replaceState' | 'back'>;
  readonly location: Pick<Location, 'href'>;
  addEventListener(type: 'popstate', listener: (event: PopStateEvent) => void): void;
  removeEventListener(type: 'popstate', listener: (event: PopStateEvent) => void): void;
}
export const mobileBackNavigationKey: InjectionKey<MobileBackNavigation> = Symbol.for('aervox.material3.mobileBack');
export function useMobileBackNavigation(): MobileBackNavigation | undefined {
  return inject(mobileBackNavigationKey, undefined);
}

const stateKey = '__aervoxMobileBack';
type Marker = { owner: string; token: string; kind: 'base' | 'guard'; original: unknown };
function marker(state: unknown): Marker | undefined {
  if (!state || typeof state !== 'object') return;
  const value = (state as Record<string, unknown>)[stateKey];
  if (!value || typeof value !== 'object') return;
  const candidate = value as Partial<Marker>;
  if (typeof candidate.owner === 'string' && typeof candidate.token === 'string'
    && (candidate.kind === 'base' || candidate.kind === 'guard') && 'original' in candidate) return candidate as Marker;
}
function unwrapped(state: unknown): { valid: boolean; value: unknown } {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 64; depth++) {
    const value = marker(state);
    if (!value) return { valid: true, value: state };
    if (seen.has(state)) return { valid: false, value: undefined };
    seen.add(state);
    state = value.original;
  }
  return { valid: false, value: undefined };
}
function previousLocalEntry(host: MobileBackHost): string | undefined {
  try {
    const navigation = host.navigation;
    if (!navigation || typeof navigation.traverseTo !== 'function') return;
    const current = navigation.currentEntry;
    const entries = navigation.entries();
    const index = entries.findIndex(entry => entry.key === current?.key);
    const previous = entries[index - 1];
    if (current && index > 0 && current.url === host.location.href && previous?.sameDocument
      && previous.url === host.location.href && previous.index === current.index - 1) return previous.key;
  } catch { /* A missing metadata proof never authorizes an automatic traversal. */ }
}
function marked(original: unknown, value: Marker): Record<string, unknown> {
  // Preserve existing object-state fields; retain the exact original for restoration,
  // including primitive and null states used by a host outside this UI owner.
  return { ...(original && typeof original === 'object' ? original : {}), [stateKey]: value };
}

/**
 * One same-document guard represents a stack of transient UI layers. Back consumes
 * the top layer, then re-arms the guard for remaining layers. Explicitly closing
 * the last layer traverses the guard asynchronously; layers opened before that
 * popstate arrives wait for it, so an old close cannot dismiss the new UI.
 *
 * Unmount never initiates traversal. A retired guard encountered later is inert;
 * only its exact owner/token and URL can restore state or consume a live layer.
 */
export function createMobileBackNavigation(
  host: MobileBackHost = window,
  createId: () => string = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
): MobileBackNavigation {
  const owner = createId();
  type Layer = { active: boolean; onBack(): void; canDismiss?(): boolean };
  const layers: Layer[] = [];
  let guard: { token: string; original: unknown; url: string } | undefined;
  let cleaning = false;
  let handlingPop = false;
  let disposed = false;
  let historyDisabled = false;
  let recovery: (Marker & { url: string; targetKey: string; committed: boolean; finished: boolean }) | undefined;
  let recoveryFailure: Error | undefined;
  const waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  const settle = () => {
    if (cleaning || handlingPop) return;
    for (const waiter of waiters) { if (recoveryFailure) waiter.reject(recoveryFailure); else waiter.resolve(); }
    waiters.clear();
  };
  const currentIs = (kind: Marker['kind']) => {
    const state = marker(host.history.state);
    return guard && host.location.href === guard.url && state?.owner === owner && state.token === guard.token && state.kind === kind;
  };
  const restore = (original: unknown, url: string): boolean => {
    try { host.history.replaceState(original, '', url); return true; }
    catch { return false; /* History may be disabled; UI remains closable. */ }
  };
  const arm = () => {
    if (disposed || historyDisabled || handlingPop || cleaning || guard || !layers.length) return;
    const next = { token: createId(), original: host.history.state, url: host.location.href };
    try {
      host.history.replaceState(marked(next.original, { owner, token: next.token, original: next.original, kind: 'base' }), '', next.url);
      host.history.pushState(marked(next.original, { owner, token: next.token, original: next.original, kind: 'guard' }), '', next.url);
      guard = next;
    } catch {
      const state = marker(host.history.state);
      if (host.location.href === next.url && state?.owner === owner && state.token === next.token) restore(next.original, next.url);
    }
  };
  const remove = (layer: Layer) => {
    if (!layer.active) return false;
    layer.active = false;
    const index = layers.indexOf(layer);
    if (index !== -1) layers.splice(index, 1);
    return true;
  };
  const consumeGuard = () => {
    if (disposed || handlingPop || cleaning || layers.length || !currentIs('guard')) return;
    cleaning = true;
    try { host.history.back(); }
    catch { cleaning = false; /* Do not retry or guess that a traversal occurred. */ }
  };
  const failRecovery = (work: NonNullable<typeof recovery>) => {
    if (disposed || recovery !== work) return;
    recovery = undefined;
    cleaning = false;
    historyDisabled = true;
    recoveryFailure = new Error('mobile_back_inherited_cleanup_failed');
    for (const waiter of waiters) waiter.reject(recoveryFailure);
    waiters.clear();
  };
  const completeRecovery = (work: NonNullable<typeof recovery>) => {
    if (disposed || recovery !== work || !work.committed || !work.finished) return;
    const state = marker(host.history.state);
    // Navigation can resolve without popstate when an old cleanup reached this
    // same absolute key first. Its settled key and classic state are sufficient.
    if (host.location.href !== work.url || host.navigation?.currentEntry?.key !== work.targetKey
      || state?.owner !== work.owner || state.token !== work.token || state.kind !== 'base') {
      failRecovery(work); return;
    }
    if (!restore(work.original, work.url)) { failRecovery(work); return; }
    recovery = undefined;
    cleaning = false;
    recoverInherited();
  };
  const recoverInherited = () => {
    if (disposed) return;
    const inherited = marker(host.history.state);
    if (!inherited) { arm(); settle(); return; }
    const original = unwrapped(host.history.state);
    if (!original.valid) { historyDisabled = true; arm(); settle(); return; }
    if (inherited.kind === 'base') {
      // A reload can occur after traversal commits but before the old listener
      // restores its base. Unwrap locally; that entry needs no further traversal.
      if (!restore(inherited.original, host.location.href)) { historyDisabled = true; recoveryFailure = new Error('mobile_back_inherited_cleanup_failed'); settle(); return; }
      recoverInherited();
      return;
    }
    const key = previousLocalEntry(host);
    if (!key) {
      // Classic History cannot inspect adjacent entries. Strip only our wrapper;
      // never guess a previous URL/document. Older WebViews may retain one empty step.
      if (!restore(original.value, host.location.href)) { historyDisabled = true; recoveryFailure = new Error('mobile_back_inherited_cleanup_failed'); }
      arm(); settle(); return;
    }
    const work = { ...inherited, url: host.location.href, targetKey: key, committed: false, finished: false };
    recovery = work;
    cleaning = true;
    try {
      // An absolute, already verified key is idempotent if an old document also
      // submitted a cleanup. A second relative back could skip past its base.
      const traversal = host.navigation!.traverseTo(key);
      const arrived = (stage: 'committed' | 'finished') => {
        try { work[stage] = true; completeRecovery(work); }
        catch { failRecovery(work); }
      };
      void traversal.committed.then(() => arrived('committed'), () => failRecovery(work));
      void traversal.finished.then(() => arrived('finished'), () => failRecovery(work));
    } catch { failRecovery(work); }
  };
  const onPop = (event: PopStateEvent) => {
    if (disposed) return;
    if (recovery) {
      const work = recovery;
      const state = marker(event.state);
      if (host.location.href !== work.url || state?.owner !== work.owner || state.token !== work.token || state.kind !== 'base') {
        failRecovery(work); return;
      }
      // Do not admit new layers until our absolute-key traversal also finishes;
      // this pop could belong to the old document's already queued cleanup.
      completeRecovery(work);
      return;
    }
    if (!guard) return;
    const state = marker(event.state);
    // Never interpret another owner, route, document or forward entry as our Back.
    if (host.location.href !== guard.url || state?.owner !== owner || state.token !== guard.token || state.kind !== 'base') return;
    const old = guard;
    const wasCleaning = cleaning;
    guard = undefined;
    cleaning = false;
    handlingPop = true;
    restore(old.original, old.url);
    try {
      if (!wasCleaning) {
        const top = layers.at(-1);
        if (top) {
          let allowed = false;
          try { allowed = top.canDismiss?.() ?? true; } catch { /* An unknown policy cannot authorize dismissal. */ }
          if (allowed) {
            remove(top);
            try { top.onBack(); }
            catch {
              // Keep failed UI ownership instead of letting another Back leave it behind.
              if (!disposed && !top.active) { top.active = true; layers.push(top); }
            }
          }
        }
      }
    } finally {
      handlingPop = false;
      arm();
      settle();
    }
  };
  host.addEventListener('popstate', onPop);
  recoverInherited();
  return {
    registerLayer(options) {
      const layer: Layer = { active: !disposed, ...options };
      if (!disposed) { layers.push(layer); arm(); }
      return {
        close() { if (remove(layer)) consumeGuard(); },
        dispose() { remove(layer); },
      };
    },
    async whenSettled() {
      // A modelValue close may still be waiting for the component's watcher.
      // Inspect only after that flush, not before it submits history.back().
      await nextTick();
      if (disposed) throw new Error('mobile_back_navigation_disposed');
      if (recoveryFailure) throw recoveryFailure;
      if (!cleaning && !handlingPop) return;
      await new Promise<void>((resolve, reject) => { waiters.add({ resolve, reject }); });
      if (disposed) throw new Error('mobile_back_navigation_disposed');
      if (recoveryFailure) throw recoveryFailure;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      host.removeEventListener('popstate', onPop);
      for (const layer of layers) layer.active = false;
      layers.length = 0;
      // No history.back(), including while a previously requested cleanup is pending.
      if (guard && (currentIs('guard') || currentIs('base'))) restore(guard.original, guard.url);
      guard = undefined;
      for (const waiter of waiters) waiter.reject(new Error('mobile_back_navigation_disposed'));
      waiters.clear();
    },
  };
}
