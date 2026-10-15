import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotAdapterContext } from "@aervox/host-plugin-api";
import registration from "../src/server/index.js";
import { normalizeOneBotMessage, OneBotAdapter, type OneBotSocket } from "../src/server/onebot-adapter.js";

const event = {
  post_type: "message", message_type: "group", self_id: 123, group_id: 456, user_id: 789,
  message_id: 101, time: 1_700_000_000,
  message: [
    { type: "at", data: { qq: "123" } }, { type: "text", data: { text: " hello [CQ:at,qq=all] " } },
    { type: "reply", data: { id: "100" } }, { type: "image", data: { url: "ignored" } },
  ],
};
const address = { kind: "group" as const, conversationId: "456", senderId: "789" };
class Socket extends EventEmitter implements OneBotSocket {
  readyState = 0;
  sent: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
  respond?: (request: Socket["sent"][number]) => void;
  terminated = false;
  open() { this.readyState = 1; this.emit("open"); }
  message(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value))); }
  send(data: string, callback?: (error?: Error) => void) {
    const request = JSON.parse(data) as Socket["sent"][number];
    this.sent.push(request);
    queueMicrotask(() => this.respond?.(request));
    callback?.();
  }
  receipt(echo: string, data: unknown, status = "ok", retcode = 0) { this.message({ echo, status, retcode, data }); }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.terminated = true; this.close(); }
}
function harness() {
  const controller = new AbortController();
  const context: BotAdapterContext = {
    connectionId: "qq", config: { endpoint: "ws://127.0.0.1:3001", accountId: "123" }, signal: controller.signal,
    secrets: { read: vi.fn(async () => ({ token: "TOKEN_SECRET" })), write: vi.fn() },
    checkpoint: { read: vi.fn(async () => ({})), write: vi.fn() },
    setState: vi.fn(),
  };
  return { context, controller };
}
const instances: OneBotAdapter[] = [];
function setup(overrides: { loginId?: string; reply?: (socket: Socket, request: Socket["sent"][number]) => void; heartbeatIntervalMs?: number; requestTimeoutMs?: number } = {}) {
  const env = harness();
  const sockets: Socket[] = [];
  const createSocket = vi.fn((_url, _options) => {
    const socket = new Socket();
    socket.respond = (request) => {
      if (request.action === "get_login_info") socket.receipt(request.echo, { user_id: overrides.loginId ?? "123" });
      else overrides.reply?.(socket, request);
    };
    sockets.push(socket);
    queueMicrotask(() => socket.open());
    return socket;
  });
  const bot = new OneBotAdapter(env.context, { createSocket, requestTimeoutMs: overrides.requestTimeoutMs ?? 100, retryDelayMs: 1, heartbeatIntervalMs: overrides.heartbeatIntervalMs });
  instances.push(bot);
  return { ...env, sockets, createSocket, bot };
}
async function connected(env: ReturnType<typeof setup>, receiver = vi.fn(async () => undefined)) {
  await env.bot.start(receiver);
  await vi.waitFor(() => expect(env.context.setState).toHaveBeenCalledWith("connected", { accountId: "123" }));
  return receiver;
}
afterEach(async () => { await Promise.all(instances.splice(0).map((bot) => bot.stop())); });

describe("OneBot normalization", () => {
  it("declares only the QQ group transport", () => {
    expect(registration.pluginId).toBe("bot-onebot");
    expect(registration.botAdapters?.[0]?.capabilities).toEqual({ directMessages: false, groupMessages: true, login: false, maxTextLength: 2000 });
  });

  it("requires an explicit bot mention and treats CQ-looking text as ordinary text", () => {
    expect(normalizeOneBotMessage(event, "123")).toEqual({
      id: "101", accountId: "123", senderId: "789", address, text: "hello [CQ:at,qq=all]",
      mentions: ["123"], receivedAt: "2023-11-14T22:13:20.000Z", replyToId: "100",
    });
  });

  it.each([
    { post_type: "message_sent" }, { message_type: "private" }, { user_id: 123 }, { self_id: 999 },
    { message_id: undefined }, { group_id: Number.MAX_SAFE_INTEGER + 1 }, { message: "[CQ:at,qq=123] hello" },
    { message: [{ type: "at", data: { qq: "all" } }, ...event.message] },
    { message: [{ type: "text", data: { text: "plain" } }] },
    { message: [{ type: "at", data: { qq: "123" } }] },
  ])("filters unsupported or unsafe events %j", (patch) => {
    expect(normalizeOneBotMessage({ ...event, ...patch }, "123")).toBeUndefined();
  });
});

describe("OneBot connection and receipts", () => {
  it("commits the expected account before opening a socket so first verified frames cannot outrun identity", async () => {
    const env = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let committedAccount: string | undefined;
    env.context.setState = vi.fn(async (state, detail) => {
      if (state === "connecting") { await gate; committedAccount = detail?.accountId; }
    });
    const receiver = vi.fn(async (message) => { expect(committedAccount).toBe(message.accountId); });
    await env.bot.start(receiver);
    expect(env.context.setState).toHaveBeenCalledWith("connecting", { accountId: "123" });
    expect(env.createSocket).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(env.context.setState).toHaveBeenCalledWith("connected", { accountId: "123" }));
    env.sockets[0]?.message(event);
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledOnce());
  });

  it("uses bearer auth and verifies the configured account before delivering frames", async () => {
    const env = setup();
    const receiver = await connected(env);
    expect(env.createSocket.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: "Bearer TOKEN_SECRET" }, maxPayload: 1_048_576 });
    expect(env.sockets[0]?.sent[0]?.action).toBe("get_login_info");
    env.sockets[0]?.message(event);
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledOnce());
    expect(receiver.mock.calls[0]?.[0]).toMatchObject({ accountId: "123", senderId: "789" });
  });

  it("stops and exposes only a sanitized error when the logged-in account differs", async () => {
    const env = setup({ loginId: "999" });
    const receiver = vi.fn();
    await env.bot.start(receiver);
    await vi.waitFor(() => expect(env.context.setState).toHaveBeenCalledWith("error", { error: "onebot_account_mismatch" }));
    env.sockets[0]?.message(event);
    expect(receiver).not.toHaveBeenCalled();
    expect(env.sockets[0]?.terminated).toBe(true);
    expect(env.createSocket).toHaveBeenCalledOnce();
    expect((await env.bot.send(address, "hi")).status).toBe("failed");
  });

  it("waits for account verification before accepting even correctly addressed frames", async () => {
    const env = harness();
    const socket = new Socket();
    const bot = new OneBotAdapter(env.context, { createSocket: () => socket });
    instances.push(bot);
    const receiver = vi.fn();
    await bot.start(receiver);
    await vi.waitFor(() => expect(env.context.secrets.read).toHaveBeenCalledOnce());
    socket.open();
    socket.message(event);
    await Promise.resolve();
    expect(receiver).not.toHaveBeenCalled();
    socket.receipt(socket.sent[0]!.echo, { user_id: "123" });
    await vi.waitFor(() => expect(env.context.setState).toHaveBeenCalledWith("connected", { accountId: "123" }));
    socket.message(event);
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledOnce());
  });

  it("sends array text/reply segments and preserves the send_group_msg receipt", async () => {
    const env = setup({ reply: (socket, request) => socket.receipt(request.echo, { message_id: 222 }) });
    await connected(env);
    expect(await env.bot.send(address, "[CQ:at,qq=all]", { replyToId: "101" })).toEqual({ status: "accepted", messageId: "222" });
    expect(env.sockets[0]?.sent[1]).toMatchObject({ action: "send_group_msg", params: {
      group_id: "456", auto_escape: true,
      message: [{ type: "reply", data: { id: "101" } }, { type: "text", data: { text: "[CQ:at,qq=all]" } }],
    } });
  });

  it("reports an unknown send when the platform receives the request but never replies", async () => {
    const env = setup({ requestTimeoutMs: 10 });
    await connected(env);
    expect(await env.bot.send(address, "hello")).toEqual({ status: "unknown", error: "onebot_send_receipt_unknown", retryable: false });
    expect(env.sockets[0]?.sent.filter((request) => request.action === "send_group_msg")).toHaveLength(1);
  });

  it("reports an unknown send on a lost socket and ignores a late receipt after reconnect", async () => {
    const env = setup();
    await connected(env);
    const old = env.sockets[0]!;
    const result = env.bot.send(address, "hello");
    const sent = old.sent[1]!;
    old.close();
    expect(await result).toMatchObject({ status: "unknown", retryable: false });
    await vi.waitFor(() => expect(env.sockets).toHaveLength(2));
    old.receipt(sent.echo, { message_id: "late" });
    expect(env.sockets[1]?.sent.filter((request) => request.action === "send_group_msg")).toHaveLength(0);
  });

  it("does not expose arbitrary error bodies from a rejected send", async () => {
    const env = setup({ reply: (socket, request) => socket.message({ echo: request.echo, status: "failed", retcode: 100, message: "TOKEN_SECRET malicious text" }) });
    await connected(env);
    expect(await env.bot.send(address, "hello")).toEqual({ status: "failed", error: "onebot_send_rejected", retryable: false });
    expect(JSON.stringify(vi.mocked(env.context.setState).mock.calls)).not.toContain("TOKEN_SECRET");
  });

  it("does not treat a success response without message_id as a known delivery", async () => {
    const env = setup({ reply: (socket, request) => socket.receipt(request.echo, {}) });
    await connected(env);
    expect(await env.bot.send(address, "hello")).toEqual({ status: "unknown", error: "onebot_send_receipt_missing", retryable: false });
  });

  it("keeps admission ordered and drains frames received before a network disconnect", async () => {
    const env = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const receiver = vi.fn(async () => { await gate; });
    await connected(env, receiver);
    env.sockets[0]?.message(event);
    env.sockets[0]?.message({ ...event, message_id: 102 });
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledOnce());
    env.sockets[0]?.close();
    release();
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledTimes(2));
    expect(receiver.mock.calls.map((call) => (call[0] as unknown as { id: string })?.id)).toEqual(["101", "102"]);
  });

  it("retries a full host queue in order while keeping persisted work drainable", async () => {
    const env = setup();
    const receiver = vi.fn().mockRejectedValueOnce(new Error("bot_inbox_full private detail")).mockResolvedValue(undefined);
    await connected(env, receiver);
    env.sockets[0]?.message(event);
    env.sockets[0]?.message({ ...event, message_id: 102 });
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledTimes(3));
    expect(receiver.mock.calls.map(([message]) => message.id)).toEqual(["101", "101", "102"]);
    expect(env.context.setState).toHaveBeenCalledWith("connected", { accountId: "123", error: "onebot_message_admission_retrying" });
    expect(env.sockets[0]?.terminated).toBe(false);
    expect(env.createSocket).toHaveBeenCalledOnce();
  });

  it("bounds unadmitted frames during overload and closes only the saturated socket", async () => {
    const env = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const receiver = vi.fn(async () => { await gate; });
    await connected(env, receiver);
    for (let i = 0; i < 101; i++) env.sockets[0]!.message({ ...event, message_id: i + 1 });
    expect(env.sockets[0]?.terminated).toBe(true);
    await vi.waitFor(() => expect(env.context.setState).toHaveBeenCalledWith("reconnecting", {
      accountId: "123", error: "onebot_inbound_capacity_reached",
    }));
    release();
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledTimes(100));
  });

  it("detects an unresponsive but unclosed socket through a bounded heartbeat", async () => {
    const env = setup({ requestTimeoutMs: 10, heartbeatIntervalMs: 10 });
    await env.bot.start(vi.fn());
    await vi.waitFor(() => expect(env.sockets.length).toBeGreaterThanOrEqual(2));
    expect(env.sockets[0]?.terminated).toBe(true);
    expect(env.sockets[0]?.sent.some((request) => request.action === "get_status")).toBe(true);
  });

  it("host cancellation stops resources, settles in-flight sends and ignores late frames", async () => {
    const env = setup();
    const receiver = await connected(env);
    const socket = env.sockets[0]!;
    const sending = env.bot.send(address, "hello");
    env.controller.abort();
    await env.bot.stop();
    expect(await sending).toMatchObject({ status: "unknown", retryable: false });
    socket.message(event);
    expect(receiver).not.toHaveBeenCalled();
    expect(socket.terminated).toBe(true);
    expect(env.createSocket).toHaveBeenCalledOnce();
    expect((await env.bot.send(address, "hello")).status).toBe("failed");
  });

  it("rejects unsupported addresses and excessive messages before send", async () => {
    const env = setup();
    await connected(env);
    expect((await env.bot.send({ ...address, kind: "direct" }, "hello")).status).toBe("failed");
    expect((await env.bot.send(address, "😀".repeat(2001))).status).toBe("failed");
    expect(env.sockets[0]?.sent).toHaveLength(1);
  });
});
