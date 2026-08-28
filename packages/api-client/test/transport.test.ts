import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchTransport } from "../src/transport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createFetchTransport", () => {
  it("透传调用方提供的幂等键，同时保留租户头", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = createFetchTransport("http://api.test", "ws_1", "usr_1");

    await transport.request("POST", "/v1/questions/q_1/attempts", { answer: "2" }, {
      headers: { "Idempotency-Key": "attempt_1" },
    });

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/v1/questions/q_1/attempts", expect.objectContaining({
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "x-workspace-id": "ws_1",
        "x-user-id": "usr_1",
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
    const transport = createFetchTransport("http://api.test", "ws_1", "usr_1");

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
