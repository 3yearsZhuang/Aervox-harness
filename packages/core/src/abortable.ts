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

/** Yield periodic ticks even while chunks keep arriving; only one next() stays in flight. */
export async function* streamWithTicks<T>(stream: AsyncIterable<T>, signal?: AbortSignal, intervalMs = 50): AsyncIterable<T | null> {
  const iterator = stream[Symbol.asyncIterator]();
  let pending = iterator.next();
  let nextTickAt = Date.now() + intervalMs;
  try {
    for (;;) {
      signal?.throwIfAborted();
      // A ready chunk can win every race, including against a zero-delay timer.
      // Check wall time too so synchronous or frequent chunks cannot starve flushes.
      if (Date.now() >= nextTickAt) {
        yield null;
        nextTickAt = Date.now() + intervalMs;
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const item = await awaitWithSignal(Promise.race([
          pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, nextTickAt - Date.now())); }),
        ]), signal);
        if (item === null) {
          yield null;
          nextTickAt = Date.now() + intervalMs;
          continue;
        }
        if (item.done) return;
        yield item.value;
        pending = iterator.next();
      } finally { clearTimeout(timer); }
    }
  } finally { void pending.catch(() => {}); void iterator.return?.().catch(() => {}); }
}
