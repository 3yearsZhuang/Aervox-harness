export interface SurfaceLocation {
  readonly href: string;
  replace(url: string): void;
  reload?(): void;
}

/** Only the explicit mobile composition root opts into asynchronous UI cleanup. */
export function createMobileSurfaceLocation(
  target: SurfaceLocation,
  beforeNavigate: () => Promise<void>,
  onFailure: () => void,
): { location: SurfaceLocation; reload(): void; dispose(): void } {
  let version = 0;
  let disposed = false;
  const run = (navigate: () => void) => {
    if (disposed) return;
    const intent = ++version;
    void (async () => {
      try {
        await beforeNavigate();
        if (!disposed && intent === version) navigate();
      } catch {
        // A failed barrier cannot authorize navigation. Only the latest live
        // intent reports failure; retiring a page invalidates old continuations.
        if (!disposed && intent === version) {
          try { onFailure(); } catch { /* A detached notification cannot restart navigation. */ }
        }
      }
    })();
  };
  return {
    location: {
      get href() { return target.href; },
      replace(url) { run(() => target.replace(url)); },
    },
    reload() { run(() => { if (!target.reload) throw new Error('surface_reload_unavailable'); target.reload(); }); },
    dispose() { disposed = true; version++; },
  };
}
