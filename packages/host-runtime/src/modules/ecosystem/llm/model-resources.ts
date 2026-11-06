import { awaitWithSignal, type ModelChunk, type ModelProviderPort, type ModelRequest } from "@aervox/core";

export class ModelStreamAdmissionError extends Error {
  constructor(readonly code: "MODEL_STREAM_LIMIT" | "MODEL_STREAM_CLOSED" | "MODEL_STREAM_BUSY") {
    super(code.toLowerCase());
    this.name = "ModelStreamAdmissionError";
  }
}

export class ModelStreamDrainError extends Error {
  readonly code = "MODEL_STREAM_DRAIN_UNCONFIRMED";
  constructor() { super("model_stream_drain_unconfirmed"); this.name = "ModelStreamDrainError"; }
}

export interface ModelStreamResourcePort {
  readonly snapshot: { readonly active: number; readonly limit: number; readonly closed: boolean };
  wrap(provider: ModelProviderPort): ModelProviderPort;
  beginClose(): void;
  close(): Promise<void>;
}

interface Lease {
  controller: AbortController;
  requestClose(): Promise<void>;
  cleanupFailed: boolean;
}

/** One Host owner; no waiting queue. An interrupted caller does not release an
 * upstream whose in-flight next/return has not actually settled. */
export function createModelStreamResources(
  limit: number,
  options: { drainTimeoutMs?: number } = {},
): ModelStreamResourcePort {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new RangeError("invalid_model_stream_concurrency");
  const drainTimeoutMs = options.drainTimeoutMs ?? 20_000;
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs <= 0 || drainTimeoutMs > 2_147_483_647) throw new RangeError("invalid_model_stream_drain_timeout");
  const active = new Set<Lease>();
  const waiters = new Set<(error?: Error) => void>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const notify = (error?: Error) => {
    if (error || active.size === 0) for (const waiter of waiters) waiter(error);
  };

  const stream = (provider: ModelProviderPort, request: ModelRequest): AsyncIterable<ModelChunk> => ({
    [Symbol.asyncIterator]() {
      let source: AsyncIterator<ModelChunk> | undefined;
      let lease: Lease | undefined;
      let signal: AbortSignal | undefined;
      let pending: Promise<IteratorResult<ModelChunk>> | undefined;
      let cleanup: Promise<void> | undefined;
      let cleanupConfirmed = false;
      let sourceEnded = false;
      let consumerEnded = false;
      let released = false;
      let removeAbort: (() => void) | undefined;
      const releaseIfDrained = () => {
        if (released || !lease || !cleanupConfirmed || pending) return;
        released = true;
        removeAbort?.();
        active.delete(lease);
        notify();
      };
      const requestClose = (): Promise<void> => {
        consumerEnded = true;
        if (cleanup) return cleanup;
        if (!source) { cleanupConfirmed = true; releaseIfDrained(); return Promise.resolve(); }
        let returned: Promise<IteratorResult<ModelChunk>>;
        try {
          returned = source.return ? Promise.resolve(source.return())
            : sourceEnded ? Promise.resolve({ done: true, value: undefined })
            : Promise.reject(new ModelStreamDrainError());
        } catch (error) { returned = Promise.reject(error); }
        cleanup = returned.then(result => {
          if (!result.done) throw new ModelStreamDrainError();
          cleanupConfirmed = true;
          releaseIfDrained();
        }).catch(error => {
          if (lease) lease.cleanupFailed = true;
          if (closed) notify(new ModelStreamDrainError());
          throw error;
        });
        // Core's abortable consumer deliberately need not await return(). The
        // owner still observes its actual completion, including late rejection.
        void cleanup.catch(() => undefined);
        return cleanup;
      };
      const initialize = () => {
        if (lease) return;
        request.signal?.throwIfAborted();
        if (closed) throw new ModelStreamAdmissionError("MODEL_STREAM_CLOSED");
        if (active.size >= limit) throw new ModelStreamAdmissionError("MODEL_STREAM_LIMIT");
        const controller = new AbortController();
        signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
        lease = { controller, requestClose, cleanupFailed: false };
        active.add(lease);
        try { source = provider.stream({ ...request, signal })[Symbol.asyncIterator](); }
        catch (error) { consumerEnded = true; cleanupConfirmed = true; releaseIfDrained(); throw error; }
        const abort = () => { void requestClose().catch(() => undefined); };
        signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => signal?.removeEventListener("abort", abort);
        if (signal.aborted) abort();
      };
      return {
        async next(): Promise<IteratorResult<ModelChunk>> {
          if (consumerEnded) return { done: true, value: undefined };
          initialize();
          signal!.throwIfAborted();
          if (consumerEnded) return { done: true, value: undefined };
          // Each consumer may have one physical next in flight; extra calls do
          // not build a second unbounded queue inside the upstream iterator.
          if (pending) throw new ModelStreamAdmissionError("MODEL_STREAM_BUSY");
          try { pending = Promise.resolve(source!.next()); }
          catch (error) { void requestClose().catch(() => undefined); throw error; }
          const physical = pending;
          void physical.then(result => {
            pending = undefined;
            if (result.done) {
              sourceEnded = true;
              // EOF itself confirms generator cleanup. Interrupted sources still
              // require their already-started return to finish as well.
              if (!cleanup) { consumerEnded = true; cleanupConfirmed = true; }
            }
            releaseIfDrained();
          }, () => { pending = undefined; releaseIfDrained(); });
          try {
            const result = await awaitWithSignal(physical, signal);
            signal!.throwIfAborted();
            return result;
          } catch (error) {
            void requestClose().catch(() => undefined);
            throw error;
          }
        },
        async return(): Promise<IteratorResult<ModelChunk>> {
          if (!lease) { consumerEnded = true; return { done: true, value: undefined }; }
          lease.controller.abort(new Error("model_stream_consumer_closed"));
          await requestClose();
          return { done: true, value: undefined };
        },
        async throw(error: unknown): Promise<IteratorResult<ModelChunk>> {
          if (lease) {
            lease.controller.abort(error);
            await requestClose();
          } else consumerEnded = true;
          throw error;
        },
      };
    },
  });

  const beginClose = () => {
    closed = true;
    for (const lease of active) {
      lease.controller.abort(new Error("host_shutdown"));
      void lease.requestClose().catch(() => undefined);
    }
  };
  return {
    get snapshot() { return Object.freeze({ active: active.size, limit, closed }); },
    wrap(provider) {
      return Object.create(provider, { stream: {
        value: (request: ModelRequest) => stream(provider, request), enumerable: true, configurable: true, writable: true,
      } }) as ModelProviderPort;
    },
    beginClose,
    close() {
      beginClose();
      if (closing) return closing;
      if (active.size === 0) return Promise.resolve();
      if ([...active].some(lease => lease.cleanupFailed)) return Promise.reject(new ModelStreamDrainError());
      let timer: ReturnType<typeof setTimeout>;
      let waiter: (error?: Error) => void;
      closing = new Promise<void>((resolve, reject) => {
        waiter = error => error ? reject(error) : resolve();
        waiters.add(waiter);
        timer = setTimeout(() => reject(new ModelStreamDrainError()), drainTimeoutMs);
      }).finally(() => { clearTimeout(timer); waiters.delete(waiter); closing = undefined; });
      return closing;
    },
  };
}
