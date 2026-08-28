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
});
