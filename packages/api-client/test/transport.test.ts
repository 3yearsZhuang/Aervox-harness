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

it('认证覆盖 JSON、SSE 和附件；回合幂等键与受理标识公开', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response('{"turnId":"t"}'))
    .mockResolvedValueOnce(new Response('data: {"turnId":"t","sequence":1,"eventType":"done","data":{}}\n\n'))
    .mockResolvedValueOnce(new Response('{"id":"a"}'));
  vi.stubGlobal('fetch', fetchMock);
  const transport = createFetchTransport('http://api.test', { headers: { Authorization: 'Bearer test' } });
  const accepted = vi.fn();
  await transport.streamTurn('s', 'hi', { onDelta() {}, onDone() {} }, { idempotencyKey: 'request', onAccepted: accepted });
  await transport.uploadAttachment!({ file: new Blob(['x']), name: 'x.txt', mediaType: 'text/plain', purpose: 'file' });
  expect(accepted).toHaveBeenCalledWith('t');
  expect(fetchMock.mock.calls.every(call => call[1].headers.Authorization === 'Bearer test')).toBe(true);
  expect(fetchMock.mock.calls[0]?.[1].headers['Idempotency-Key']).toBe('request');
});

it('等待异步事件消费者后才派发下一条，且异常不重放消费者', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('data: {"turnId":"t","sequence":1,"eventType":"delta","data":{"text":"a"}}\n\ndata: {"turnId":"t","sequence":2,"eventType":"done","data":{}}\n\n'));
  vi.stubGlobal('fetch', fetchMock);
  const order: string[] = [];
  await createFetchTransport('http://api.test').watchTurn('t', {
    onDelta() { order.push('delta'); }, onDone() { order.push('done'); },
    async onEvent(event) { if (event.eventType === 'delta') { await Promise.resolve(); order.push('consumed'); } },
  });
  expect(order).toEqual(['delta', 'consumed', 'done']);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('拒绝超额 SSE 帧并释放 reader', async () => {
  const cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(1_048_577))); }, cancel,
  }))));
  await expect(createFetchTransport('http://api.test').watchTurn('t', { onDelta() {}, onDone() {} })).rejects.toThrow('sse_event_too_large');
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('外部取消在提交前生效，错误响应不泄露响应正文', async () => {
  const transport = createFetchTransport('http://api.test');
  const fetchMock = vi.fn((_url, init) => {
    if (init.signal?.aborted) return Promise.reject(init.signal.reason);
    return Promise.resolve(new Response('private-secret', { status: 403 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  await expect(transport.streamTurn('s', 'hi', { onDelta() {}, onDone() {} }, { signal: AbortSignal.abort(new Error('stop')) })).rejects.toThrow('stop');
  await expect(transport.request('GET', '/v1/sessions')).rejects.toMatchObject({ status: 403, message: 'API GET /v1/sessions → HTTP 403' });
});
