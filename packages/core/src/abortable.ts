/** Bound local waiting even when an adapter ignores AbortSignal; its late result is discarded. */
export function awaitWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("execution_aborted")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function* abortableStream<T>(stream: AsyncIterable<T>, signal?: AbortSignal): AsyncIterable<T> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await awaitWithSignal(iterator.next(), signal);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // An uncooperative iterator's return may itself hang behind next().
    void iterator.return?.().catch(() => undefined);
  }
}

/** Yield idle ticks without concurrent next() calls; flushers remain serialized with chunks. */
export async function* streamWithTicks<T>(stream: AsyncIterable<T>, signal?: AbortSignal, intervalMs = 50): AsyncIterable<T | null> {
  const iterator = stream[Symbol.asyncIterator]();
  let pending = iterator.next();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const item = await awaitWithSignal(Promise.race([
          pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), intervalMs); }),
        ]), signal);
        if (item === null) { yield null; continue; }
        if (item.done) return;
        yield item.value;
        pending = iterator.next();
      } finally { clearTimeout(timer); }
    }
  } finally { void pending.catch(() => {}); void iterator.return?.().catch(() => {}); }
}
