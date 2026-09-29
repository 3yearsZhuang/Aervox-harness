import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchTransport } from "../src/transport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createFetchTransport", () => {
  it("透传调用方提供的幂等键", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = createFetchTransport("http://api.test");

    await transport.request("POST", "/v1/questions/q_1/attempts", { answer: "2" }, {
      headers: { "Idempotency-Key": "attempt_1" },
    });

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/v1/questions/q_1/attempts", expect.objectContaining({
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "Idempotency-Key": "attempt_1",
      }),
    }));
  });

  it("创建 Turn 时传递完全访问模式", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ turnId: "turn_1" }), { status: 201 }))
      .mockResolvedValueOnce(
        new Response(
          `data: ${JSON.stringify({
            eventId: "evt_1",
            turnId: "turn_1",
            sequence: 1,
            eventType: "done",
            payloadVersion: 1,
            occurredAt: "2026-08-29T00:00:00.000Z",
            data: { status: "Completed", isComplete: true, lastSequence: 1 },
          })}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const transport = createFetchTransport("http://api.test");

    await transport.streamTurn(
      "ses_1",
      "hello",
      { onDelta: vi.fn(), onDone: vi.fn() },
      { toolApprovalMode: "full_access" },
    );

    const createOptions = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(createOptions.body))).toMatchObject({
      message: { content: "hello", contentType: "text" },
      toolApprovalMode: "full_access",
    });
  });
});

it("SSE 中断仅重连原 Turn，沿用 cursor/投影水位，拒绝重复和终态后事件", async () => {
  const event = (sequence: number, eventType: string, text = "") => `data: ${JSON.stringify({ eventId: `ev${sequence}`, turnId: "turn_1", sequence, eventType, data: { text } })}\n\n`;
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ turnId: "turn_1" }), { status: 201 }))
    .mockResolvedValueOnce(new Response(event(1, "delta", "A")))
    .mockResolvedValueOnce(new Response(event(1, "delta", "duplicate") + event(2, "delta", "B") + event(3, "done") + event(4, "delta", "late")));
  vi.stubGlobal("fetch", fetchMock);
  const delta = vi.fn(); const done = vi.fn();
  await createFetchTransport("http://api.test").streamTurn("s", "hi", { onDelta: delta, onDone: done });
  expect(delta.mock.calls.flat()).toEqual(["A", "B"]);
  expect(done).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2]?.[1].headers["Last-Event-ID"]).toBe("ev1");
});

it("cursor 失效明确失败，不重新接单或静默丢历史", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"turnId":"t"}', { status: 201 }))
    .mockResolvedValueOnce(new Response('', { status: 410 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(createFetchTransport("http://api.test").streamTurn("s", "hi", { onDelta: vi.fn(), onDone: vi.fn() })).rejects.toThrow("410");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
