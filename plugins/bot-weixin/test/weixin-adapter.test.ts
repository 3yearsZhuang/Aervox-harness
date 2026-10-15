import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotAdapterContext, BotMessage } from "@aervox/host-plugin-api";
import registration from "../src/server/index.js";
import { normalizeWeixinMessage, WeixinAdapter } from "../src/server/weixin-adapter.js";

const direct = { kind: "direct" as const, conversationId: "owner", senderId: "owner" };
const incoming = {
  from_user_id: "owner", to_user_id: "account", message_id: "m1", message_type: 1,
  create_time_ms: 1_700_000_000_000, context_token: "CONTEXT_SECRET",
  item_list: [{ type: 1, text_item: { text: "hello" } }],
};
function harness(secrets: Record<string, string> = { token: "TOKEN_SECRET" }, checkpoint: Record<string, unknown> = { accountId: "account", cursor: "old" }) {
  let secretState = { ...secrets };
  let checkpointState = { ...checkpoint };
  const controller = new AbortController();
  const context: BotAdapterContext = {
    connectionId: "c1", config: {}, signal: controller.signal,
    secrets: {
      read: vi.fn(async () => ({ ...secretState })),
      write: vi.fn(async (value) => { secretState = { ...value }; }),
    },
    checkpoint: {
      read: vi.fn(async () => ({ ...checkpointState })),
      write: vi.fn(async (value) => { checkpointState = { ...value }; }),
    },
    setState: vi.fn(),
  };
  return { context, controller, secrets: () => secretState, checkpoint: () => checkpointState };
}
function response(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200 }); }
function pending(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(new Error("aborted")); return; }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}
const instances: WeixinAdapter[] = [];
function adapter(context: BotAdapterContext, fetcher: typeof fetch) {
  const instance = new WeixinAdapter(context, { fetch: fetcher, retryDelayMs: 1 });
  instances.push(instance);
  return instance;
}
afterEach(async () => { await Promise.all(instances.splice(0).map((instance) => instance.stop())); });

describe("Weixin protocol normalization", () => {
  it("registers only transport contributions and does not start connections during import", () => {
    expect(registration.pluginId).toBe("bot-weixin");
    expect(registration.botAdapters?.[0]?.capabilities).toEqual({ directMessages: true, groupMessages: false, login: true, maxTextLength: 2000 });
    expect(registration.turnPlugins).toBeUndefined();
  });

  it("retains stable ID, direct address and platform timestamp while ignoring media", () => {
    expect(normalizeWeixinMessage({ ...incoming, item_list: [...incoming.item_list, { type: 2, image_item: { url: "private" } }] }, "account"))
      .toEqual({ id: "m1", accountId: "account", senderId: "owner", address: direct, text: "hello", mentions: [], receivedAt: "2023-11-14T22:13:20.000Z" });
  });

  it.each([
    { message_type: 2 }, { from_user_id: "account" }, { from_user_id: "group@chatroom" },
    { message_id: undefined }, { to_user_id: "other-account" }, { item_list: [{ type: 2 }] },
  ])("rejects non-direct, self, malformed or media-only event %j", (patch) => {
    expect(normalizeWeixinMessage({ ...incoming, ...patch }, "account")).toBeUndefined();
  });
});

describe("Weixin transport lifecycle", () => {
  it("waits for restored account state to commit before requesting or admitting the first update", async () => {
    const env = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let committedAccount: string | undefined;
    env.context.setState = vi.fn(async (_state, detail) => {
      if (detail?.accountId) {
        await gate;
        committedAccount = detail.accountId;
      }
    });
    let requests = 0;
    const fetcher = vi.fn(async (_url, init) => ++requests === 1
      ? response({ ret: 0, msgs: [incoming], get_updates_buf: "first" }) : pending(init!.signal!)) as typeof fetch;
    const receiver = vi.fn(async (message: BotMessage) => { expect(committedAccount).toBe(message.accountId); });
    const bot = adapter(env.context, fetcher);
    await bot.start(receiver);
    expect(env.context.setState).toHaveBeenCalledWith("connecting", { accountId: "account" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(receiver).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledOnce());
  });

  it("stays stopped when the host revokes the instance while committing its restored account", async () => {
    const env = harness();
    env.context.setState = vi.fn(async (_state, detail) => { if (detail?.accountId) env.controller.abort(); });
    const fetcher = vi.fn() as typeof fetch;
    const receiver = vi.fn();
    const bot = adapter(env.context, fetcher);
    await bot.start(receiver);
    await bot.stop();
    expect(fetcher).not.toHaveBeenCalled();
    expect(receiver).not.toHaveBeenCalled();
    expect(env.context.checkpoint.write).not.toHaveBeenCalled();
  });

  it("saves reply credentials before admission and advances the cursor only after admission", async () => {
    const env = harness();
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { release = resolve; });
    let polls = 0;
    const fetcher = vi.fn(async (_url, init) => ++polls === 1
      ? response({ ret: 0, msgs: [incoming], get_updates_buf: "next" }) : pending(init!.signal!)) as typeof fetch;
    const receiver = vi.fn(async (_message: BotMessage) => {
      expect(env.secrets()["context:owner"]).toBe("CONTEXT_SECRET");
      await admitted;
    });
    const bot = adapter(env.context, fetcher);
    await bot.start(receiver);
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledOnce());
    expect(env.checkpoint().cursor).toBe("old");
    release();
    await vi.waitFor(() => expect(env.checkpoint().cursor).toBe("next"));
    const [, options] = vi.mocked(fetcher).mock.calls[0]!;
    expect(options?.headers).toMatchObject({ Authorization: "Bearer TOKEN_SECRET", AuthorizationType: "ilink_bot_token" });
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(String(options?.body)).get_updates_buf).toBe("old");
  });

  it("replays from the old cursor when durable admission fails", async () => {
    const env = harness();
    let polls = 0;
    const cursors: unknown[] = [];
    const bot = adapter(env.context, vi.fn(async (_url, init) => {
      cursors.push(JSON.parse(String(init?.body)).get_updates_buf);
      return ++polls <= 2 ? response({ ret: 0, msgs: [incoming], get_updates_buf: "next" }) : pending(init!.signal!);
    }) as typeof fetch);
    const receiver = vi.fn().mockRejectedValueOnce(new Error("DB busy")).mockResolvedValue(undefined);
    await bot.start(receiver);
    await vi.waitFor(() => expect(env.checkpoint().cursor).toBe("next"));
    expect(receiver).toHaveBeenCalledTimes(2);
    expect(cursors.slice(0, 2)).toEqual(["old", "old"]);
  });

  it("keeps the first authenticated batch drainable when the host queue is full", async () => {
    const env = harness();
    let state = "stopped";
    let queued = 0;
    const admitted = new Set<string>();
    env.context.setState = vi.fn(async (next, detail) => {
      state = next;
      // The host dispatches persisted messages only while its connection is connected.
      if (next === "connected" && detail?.error === "weixin_message_admission_retrying") queued = 0;
    });
    let polls = 0;
    const fetcher = vi.fn(async (_url, init) => ++polls <= 2 ? response({
      ret: 0, msgs: [1, 2, 3].map((n) => ({ ...incoming, message_id: `m${n}` })), get_updates_buf: "next",
    }) : pending(init!.signal!)) as typeof fetch;
    const bot = adapter(env.context, fetcher);
    await bot.start(async (message) => {
      expect(state).toBe("connected");
      if (admitted.has(message.id)) return;
      if (queued === 2) throw new Error("bot_inbox_full");
      admitted.add(message.id); queued++;
    });
    await vi.waitFor(() => expect(env.checkpoint().cursor).toBe("next"));
    expect([...admitted]).toEqual(["m1", "m2", "m3"]);
    expect(env.context.setState).toHaveBeenCalledWith("connected", {
      accountId: "account", error: "weixin_message_admission_retrying",
    });
    expect(polls).toBe(2);
  });

  it("restores a persisted cursor on restart and aborts an in-flight long poll on stop", async () => {
    const env = harness();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      signals.push(init!.signal!);
      return pending(init!.signal!);
    }) as typeof fetch;
    const first = adapter(env.context, fetcher);
    await first.start(vi.fn());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await first.stop();
    expect(signals[0]?.aborted).toBe(true);
    const second = adapter(env.context, fetcher);
    await second.start(vi.fn());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[1]?.[1]?.body)).get_updates_buf).toBe("old");
  });

  it("does not call a receiver when a canceled request completes late", async () => {
    const env = harness();
    let release!: (value: Response) => void;
    const fetcher = vi.fn(async () => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch;
    const receiver = vi.fn();
    const bot = adapter(env.context, fetcher);
    await bot.start(receiver);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const stopping = bot.stop();
    release(response({ ret: 0, msgs: [incoming], get_updates_buf: "next" }));
    await stopping;
    expect(receiver).not.toHaveBeenCalled();
    expect(env.checkpoint().cursor).toBe("old");
  });

  it("clears only the expired token and stops polling for -14", async () => {
    const env = harness({ token: "TOKEN_SECRET", "context:owner": "CONTEXT_SECRET" });
    const fetcher = vi.fn(async () => response({ ret: -1, errcode: -14, errmsg: "TOKEN_SECRET" })) as typeof fetch;
    const bot = adapter(env.context, fetcher);
    await bot.start(vi.fn());
    await vi.waitFor(() => expect(env.context.setState).toHaveBeenCalledWith("login_required", { error: "weixin_session_expired" }));
    expect(env.secrets().token).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(env.context.setState).mock.calls)).not.toContain("TOKEN_SECRET");
  });

  it("handles an idle poll with no msgs array", async () => {
    const env = harness();
    let calls = 0;
    const bot = adapter(env.context, vi.fn(async (_url, init) => ++calls === 1
      ? response({ ret: 0, get_updates_buf: "idle" }) : pending(init!.signal!)) as typeof fetch);
    await bot.start(vi.fn());
    await vi.waitFor(() => expect(env.checkpoint().cursor).toBe("idle"));
  });
});

describe("Weixin login and sending", () => {
  it("commits a confirmed account before returning login success or receiving the first pairing message", async () => {
    const env = harness({}, {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let committedAccount: string | undefined;
    env.context.setState = vi.fn(async (_state, detail) => {
      if (detail?.accountId) { await gate; committedAccount = detail.accountId; }
    });
    let polls = 0;
    const fetcher = vi.fn(async (url, init) => {
      if (String(url).includes("get_bot_qrcode")) return response({ qrcode: "private", qrcode_img_content: "scan" });
      if (String(url).includes("get_qrcode_status")) return response({ status: "confirmed", bot_token: "NEW", ilink_bot_id: "account" });
      return ++polls === 1 ? response({ ret: 0, msgs: [incoming], get_updates_buf: "first" }) : pending(init!.signal!);
    }) as typeof fetch;
    const receiver = vi.fn(async (message: BotMessage) => { expect(committedAccount).toBe(message.accountId); });
    const bot = adapter(env.context, fetcher);
    await bot.start(receiver);
    await bot.beginLogin();
    let resolved = false;
    const confirming = bot.pollLogin().then((result) => { resolved = true; return result; });
    await vi.waitFor(() => expect(env.context.setState).toHaveBeenCalledWith("connecting", { accountId: "account" }));
    expect(resolved).toBe(false);
    expect(polls).toBe(0);
    expect(receiver).not.toHaveBeenCalled();
    release();
    expect(await confirming).toEqual({ status: "confirmed", accountId: "account" });
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledOnce());
  });

  it("preserves new credentials but emits no callbacks when account replacement revokes the old instance", async () => {
    const env = harness({ token: "OLD", accountId: "account", "context:owner": "OLD_CONTEXT" });
    env.context.setState = vi.fn(async (_state, detail) => {
      if (detail?.accountId === "new-account") env.controller.abort();
    });
    const fetcher = vi.fn().mockResolvedValueOnce(response({ qrcode: "private", qrcode_img_content: "scan" }))
      .mockResolvedValueOnce(response({ status: "confirmed", bot_token: "NEW", ilink_bot_id: "new-account" })) as typeof fetch;
    const bot = adapter(env.context, fetcher);
    await bot.beginLogin();
    await expect(bot.pollLogin()).rejects.toThrow("weixin_stopped");
    await bot.stop();
    expect(env.secrets()).toMatchObject({ token: "NEW", accountId: "new-account" });
    expect(env.secrets()["context:owner"]).toBeUndefined();
    expect(env.context.checkpoint.write).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the polling token private and clears old account state after QR confirmation", async () => {
    const env = harness({ token: "OLD", "context:owner": "OLD_CONTEXT" });
    const fetcher = vi.fn(async (url, init) => {
      if (String(url).includes("get_bot_qrcode")) return response({ qrcode: "PRIVATE_POLL_TOKEN", qrcode_img_content: "https://weixin.qq.com/scan" });
      if (String(url).includes("get_qrcode_status")) return response({ status: "confirmed", bot_token: "NEW_TOKEN", ilink_bot_id: "new-account", baseurl: "https://ilinkai.weixin.qq.com" });
      return pending(init!.signal!);
    }) as typeof fetch;
    const bot = adapter(env.context, fetcher);
    const login = await bot.beginLogin();
    expect(login).toMatchObject({ status: "waiting", qrCodeUrl: "https://weixin.qq.com/scan" });
    expect(JSON.stringify(login)).not.toContain("PRIVATE_POLL_TOKEN");
    expect(await bot.pollLogin()).toEqual({ status: "confirmed", accountId: "new-account" });
    expect(env.secrets()).toMatchObject({ token: "NEW_TOKEN", accountId: "new-account" });
    expect(env.secrets()["context:owner"]).toBeUndefined();
    expect(env.checkpoint().cursor).toBeUndefined();
    expect(await bot.pollLogin()).toEqual({ status: "confirmed", accountId: "new-account" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an upstream login redirect that would leak a bearer token", async () => {
    const env = harness({});
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ qrcode: "q", qrcode_img_content: "scan" }))
      .mockResolvedValueOnce(response({ status: "confirmed", bot_token: "SECRET", ilink_bot_id: "account", baseurl: "https://attacker.invalid" })) as typeof fetch;
    const bot = adapter(env.context, fetcher);
    await bot.beginLogin();
    await expect(bot.pollLogin()).rejects.toThrow("weixin_untrusted_login_endpoint");
    expect(env.secrets().token).toBeUndefined();
  });

  it.each(["scanned", "expired"] as const)("exposes QR status %s without secret material", async (status) => {
    const env = harness({});
    const fetcher = vi.fn().mockResolvedValueOnce(response({ qrcode: "q", qrcode_img_content: "scan" }))
      .mockResolvedValueOnce(response({ status })) as typeof fetch;
    const bot = adapter(env.context, fetcher);
    await bot.beginLogin();
    expect((await bot.pollLogin()).status).toBe(status);
    expect(env.secrets()).toEqual({});
  });

  it("uses saved context for text sending and preserves accepted platform receipt", async () => {
    const env = harness({ token: "TOKEN_SECRET", "context:owner": "CONTEXT_SECRET" });
    const fetcher = vi.fn(async () => response({ ret: 0, message_id: "sent-1" })) as typeof fetch;
    const bot = adapter(env.context, fetcher);
    expect(await bot.send(direct, "reply")).toEqual({ status: "accepted", messageId: "sent-1" });
    const body = JSON.parse(String(vi.mocked(fetcher).mock.calls[0]?.[1]?.body));
    expect(body.msg).toMatchObject({ to_user_id: "owner", message_type: 2, context_token: "CONTEXT_SECRET", item_list: [{ type: 1, text_item: { text: "reply" } }] });
  });

  it("never retries an ambiguous send or leaks adversarial upstream error bodies", async () => {
    const env = harness({ token: "TOKEN_SECRET", "context:owner": "CONTEXT_SECRET" });
    const fetcher = vi.fn(async () => { throw new Error("TOKEN_SECRET CONTEXT_SECRET attacker instruction"); }) as typeof fetch;
    const bot = adapter(env.context, fetcher);
    expect(await bot.send(direct, "reply")).toEqual({ status: "unknown", error: "weixin_send_receipt_unknown", retryable: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("requires a saved reply context and rejects group, overlong and stopped sends before network", async () => {
    const env = harness();
    const fetcher = vi.fn() as typeof fetch;
    const bot = adapter(env.context, fetcher);
    expect((await bot.send(direct, "reply")).status).toBe("failed");
    expect((await bot.send({ ...direct, kind: "group" }, "reply")).status).toBe("failed");
    expect((await bot.send(direct, "😀".repeat(2001))).status).toBe("failed");
    await bot.stop();
    expect((await bot.send(direct, "reply")).status).toBe("failed");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats a nonzero ret as failure even when errcode is zero", async () => {
    const env = harness({ token: "TOKEN_SECRET", "context:owner": "CONTEXT_SECRET" });
    const bot = adapter(env.context, vi.fn(async () => response({ ret: -1, errcode: 0, errmsg: "SECRET" })) as typeof fetch);
    expect(await bot.send(direct, "reply")).toEqual({ status: "failed", error: "weixin_send_rejected", retryable: false });
  });

  it("recovers safely if credentials committed before the login checkpoint during a crash", async () => {
    const env = harness({ token: "NEW", accountId: "new-account", baseUrl: "https://ilinkai.weixin.qq.com" }, { accountId: "old-account", cursor: "old-cursor" });
    const fetcher = vi.fn(async (_url, init) => pending(init!.signal!)) as typeof fetch;
    const bot = adapter(env.context, fetcher);
    await bot.start(vi.fn());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0]?.[1]?.body)).get_updates_buf).toBe("");
  });

  it("does not let a delayed expiry response revoke a newly confirmed login", async () => {
    const env = harness({ token: "OLD", "context:owner": "CONTEXT_SECRET" });
    let finishSend!: (value: Response) => void;
    const fetcher = vi.fn(async (url) => {
      if (String(url).includes("sendmessage")) return new Promise<Response>((resolve) => { finishSend = resolve; });
      if (String(url).includes("get_bot_qrcode")) return response({ qrcode: "private", qrcode_img_content: "scan" });
      return response({ status: "confirmed", bot_token: "NEW", ilink_bot_id: "account" });
    }) as typeof fetch;
    const bot = adapter(env.context, fetcher);
    const sending = bot.send(direct, "reply");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await bot.beginLogin();
    await bot.pollLogin();
    finishSend(response({ ret: -1, errcode: -14 }));
    expect((await sending).status).toBe("failed");
    expect(env.secrets().token).toBe("NEW");
    expect(env.context.setState).not.toHaveBeenCalledWith("login_required", { error: "weixin_session_expired" });
  });

  it("serializes concurrent login polling and persists confirmation once", async () => {
    const env = harness({});
    const fetcher = vi.fn().mockResolvedValueOnce(response({ qrcode: "private", qrcode_img_content: "scan" }))
      .mockResolvedValueOnce(response({ status: "confirmed", bot_token: "NEW", ilink_bot_id: "account" })) as typeof fetch;
    const bot = adapter(env.context, fetcher);
    await bot.beginLogin();
    expect(await Promise.all([bot.pollLogin(), bot.pollLogin()])).toEqual([
      { status: "confirmed", accountId: "account" }, { status: "confirmed", accountId: "account" },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(env.context.secrets.write).toHaveBeenCalledOnce();
  });
});
