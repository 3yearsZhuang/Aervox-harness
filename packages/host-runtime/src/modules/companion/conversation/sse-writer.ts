import { projectSafeEventData, type PluginApiRegistry } from "@aervox/contracts";
import type { TurnStreamEventModel } from "@aervox/repositories";

/** Local connection protection, not a Turn deadline or a payload quota. */
export const SSE_DRAIN_TIMEOUT_MS = 30_000;

export interface SseWritable {
  write(frame: string): boolean;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  readonly writableLength: number;
  readonly writableHighWaterMark: number;
}

export class SseWriteError extends Error {
  constructor(readonly code: "sse_closed" | "sse_drain_timeout") { super(code); }
}

export function encodeSseEvent(ev: TurnStreamEventModel, registry?: PluginApiRegistry): string {
  return `id: ${ev.id}\ndata: ${JSON.stringify({
    eventId: ev.id, turnId: ev.turnId, sequence: ev.sequence,
    eventType: ev.eventType, payloadVersion: ev.payloadVersion,
    occurredAt: ev.occurredAt, data: projectSafeEventData(ev.eventType, ev.data, registry),
  })}\n\n`;
}

/** One owner awaits this before producing another frame or reading another page. */
export async function writeSseFrame(
  raw: SseWritable,
  frame: string,
  options: {
    signal: AbortSignal;
    drainTimeoutMs?: number;
    onBackpressure?: (queuedBytes: number, highWaterMark: number) => void;
  },
): Promise<void> {
  if (options.signal.aborted || raw.destroyed || raw.writableEnded) throw new SseWriteError("sse_closed");
  if (raw.write(frame)) return;
  options.onBackpressure?.(raw.writableLength, raw.writableHighWaterMark);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      raw.off("drain", drained); raw.off("close", closed); raw.off("error", closed);
      options.signal.removeEventListener("abort", closed);
    };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new SseWriteError("sse_closed")); };
    const timer = setTimeout(() => {
      cleanup(); reject(new SseWriteError("sse_drain_timeout"));
    }, options.drainTimeoutMs ?? SSE_DRAIN_TIMEOUT_MS);
    timer.unref();
    raw.once("drain", drained); raw.once("close", closed); raw.once("error", closed);
    options.signal.addEventListener("abort", closed, { once: true });
    if (options.signal.aborted || raw.destroyed || raw.writableEnded) closed();
  });
}
