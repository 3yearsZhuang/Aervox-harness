import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeSseEvent, writeSseFrame } from "../src/modules/companion/conversation/sse-writer.js";

class ControlledWritable extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 128;
  writableHighWaterMark = 64;
  frames: string[] = [];
  accepts = false;
  write(frame: string) { this.frames.push(frame); return this.accepts; }
}
const options = () => ({ signal: new AbortController().signal });
const noListeners = (raw: ControlledWritable) => {
  for (const event of ["drain", "close", "error"]) expect(raw.listenerCount(event)).toBe(0);
};
afterEach(() => vi.useRealTimers());

describe("SSE single writer backpressure", () => {
  it("encodes each UTF-8 event as one complete SSE frame", async () => {
    const raw = new ControlledWritable(); raw.accepts = true;
    const frame = encodeSseEvent({ id: "event", turnId: "turn", sequence: 1,
      eventType: "delta", payloadVersion: 1, occurredAt: "now", data: { text: "中文\n正文" } });
    await writeSseFrame(raw, frame, options());
    expect(raw.frames).toEqual([frame]);
    expect(frame).toMatch(/^id: event\ndata: .+\n\n$/);
    expect(JSON.parse(frame.split("\n")[1]!.slice(6)).data.text).toBe("中文\n正文");
    noListeners(raw);
  });

  it("stops the producer until drain and removes every temporary listener", async () => {
    const raw = new ControlledWritable(); const nextPage = vi.fn(); const blocked = vi.fn();
    const pending = (async () => {
      await writeSseFrame(raw, "first", { ...options(), onBackpressure: blocked });
      nextPage();
    })();
    await Promise.resolve();
    expect(nextPage).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith(128, 64);
    raw.emit("drain"); await pending;
    expect(nextPage).toHaveBeenCalledOnce(); noListeners(raw);
  });

  it.each(["close", "error"])("%s stops the writer without generating a business event", async event => {
    const raw = new ControlledWritable();
    const pending = writeSseFrame(raw, "persisted", options());
    const assertion = expect(pending).rejects.toMatchObject({ code: "sse_closed" });
    raw.emit(event); await assertion;
    expect(raw.frames).toEqual(["persisted"]); noListeners(raw);
  });

  it("connection abort cleans up a blocked writer", async () => {
    const raw = new ControlledWritable(); const controller = new AbortController();
    const pending = writeSseFrame(raw, "persisted", { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: "sse_closed" });
    controller.abort(); await assertion; noListeners(raw);
  });

  it("uses a fixed 30s drain deadline without adding a terminal event", async () => {
    vi.useFakeTimers();
    const raw = new ControlledWritable();
    const pending = writeSseFrame(raw, "persisted", options());
    const assertion = expect(pending).rejects.toMatchObject({ code: "sse_drain_timeout" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(raw.listenerCount("drain")).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await assertion;
    expect(raw.frames).toEqual(["persisted"]); noListeners(raw);
  });

  it("does not write after detachment", async () => {
    const raw = new ControlledWritable(); const controller = new AbortController(); controller.abort();
    await expect(writeSseFrame(raw, "never", { signal: controller.signal })).rejects.toMatchObject({ code: "sse_closed" });
    expect(raw.frames).toEqual([]); noListeners(raw);
  });
});
