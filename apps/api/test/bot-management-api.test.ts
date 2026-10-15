import { afterEach, expect, it, vi } from "vitest";
import { createInMemoryDatabase, createProactiveVaultCipher } from "@aervox/repositories";
import type { BotAdapterContribution, BotMessage } from "@aervox/host-plugin-api";
import { buildApp } from "./app-fixture.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; vi.unstubAllEnvs(); });

async function fixture(auth = false) {
  vi.stubEnv("AERVOX_LOOP_PROVIDER", "replay");
  const db = await createInMemoryDatabase(); cleanup.push(db.cleanup);
  let receive: ((message: BotMessage) => Promise<void>) | undefined;
  const send = vi.fn(async () => ({ status: "accepted" as const, messageId: "platform-reply" }));
  const stop = vi.fn(async () => undefined);
  const adapter: BotAdapterContribution = {
    id: "test-onebot", platform: "onebot", displayName: "Test Bot",
    capabilities: { directMessages: false, groupMessages: true, login: false, maxTextLength: 2000 },
    create: ctx => ({
      start: async callback => { receive = callback; await ctx.setState("connected", { accountId: "bot-account" }); },
      stop, send,
    }),
  };
  const result = await buildApp({ db: db.db, client: db.client,
    auth: auth ? { mode: "token", token: "test-admin-token" } : { mode: "open" },
    botOptions: { adapters: [{ pluginId: "bot-fixture", adapter }],
      cipher: createProactiveVaultCipher(new Uint8Array(32).fill(7), "bot-v1"), pluginEnabled: async () => true },
  });
  cleanup.push(() => result.app.close()); await result.app.ready();
  const headers = auth ? { authorization: "Bearer test-admin-token" } : {};
  return { ...result, ...db, headers, send, stop, emit: (senderId = "member-a", id = "event-1") => receive!({
    id, senderId, accountId: "bot-account", address: { kind: "group", conversationId: "group-1", senderId },
    text: "你好", mentions: ["bot-account"], receivedAt: new Date().toISOString(),
  }) };
}

it("management remains behind host authentication; credential writes are encrypted and never returned", async () => {
  const f = await fixture(true);
  expect((await f.app.inject({ method: "GET", url: "/v1/bot-connections" })).statusCode).toBe(401);
  const created = await f.app.inject({ method: "POST", url: "/v1/bot-connections", headers: f.headers,
    payload: { adapterId: "test-onebot", displayName: "私有连接", secretValues: { token: "secret-sentinel" } } });
  expect(created.statusCode).toBe(201);
  expect(created.body).not.toContain("secret-sentinel");
  expect(created.json()).toMatchObject({ revision: 1, enabled: false, hasCredentials: true });
  const stored = await f.client.execute("SELECT secret_cipher FROM bot_connections");
  expect(String(stored.rows[0]!.secret_cipher)).toMatch(/^avxenc:v1:/);
  expect(String(stored.rows[0]!.secret_cipher)).not.toContain("secret-sentinel");
  const id = created.json().id;
  const changed = await f.app.inject({ method: "PATCH", url: `/v1/bot-connections/${id}`, headers: f.headers,
    payload: { revision: 1, displayName: "更新" } });
  expect(changed.statusCode).toBe(200);
  expect((await f.app.inject({ method: "PATCH", url: `/v1/bot-connections/${id}`, headers: f.headers,
    payload: { revision: 1, secretValues: { token: "stale-secret" } } })).statusCode).toBe(409);
  expect((await f.app.inject({ method: "POST", url: "/v1/bot-connections", headers: f.headers,
    payload: { adapterId: "test-onebot", displayName: "x", config: { token: "hidden" } } })).statusCode).toBe(400);
  for (const endpoint of ["ws://bot.test/?access_token=secret", "ws://user:secret@bot.test/"]) {
    expect((await f.app.inject({ method: "POST", url: "/v1/bot-connections", headers: f.headers,
      payload: { adapterId: "test-onebot", displayName: "x", config: { endpoint } } })).statusCode).toBe(400);
  }
  expect((await f.app.inject({ method: "GET", url: "/v1/bot-connections", headers: f.headers })).body).not.toContain("secret-sentinel");
  expect(f.send).not.toHaveBeenCalled();
});

it("registered platform ingress reaches the existing loop once and persists member-scoped sessions and receipts", async () => {
  const f = await fixture();
  const created = await f.app.inject({ method: "POST", url: "/v1/bot-connections", payload: {
    adapterId: "test-onebot", displayName: "群聊", enabled: true, config: { allowedGroupIds: ["group-1"] },
  } });
  expect(created.statusCode).toBe(201);
  await f.botManager.settle();
  await f.emit(); await f.emit();
  await f.botManager.settle();
  await f.emit("member-b", "event-2"); await f.botManager.settle();
  const turns = await f.client.execute("SELECT session_id,execution_policy,dispatch_target FROM turns WHERE id LIKE 'bt_%'");
  expect(turns.rows).toHaveLength(2);
  expect(new Set(turns.rows.map(row => row.session_id)).size).toBe(2);
  expect(turns.rows.every(row => row.execution_policy === "bot-group-member-v1" && row.dispatch_target === "api")).toBe(true);
  expect(f.send).toHaveBeenCalledTimes(2);
  const receipts = await f.app.inject({ method: "GET", url: `/v1/bot-connections/${created.json().id}/deliveries` });
  expect(receipts.statusCode).toBe(200);
  expect(receipts.json().deliveries).toHaveLength(2);
  expect(receipts.json().deliveries.every((part: { status: string }) => part.status === "accepted")).toBe(true);
});

it("plugin disabling closes its active connections before returning and rejects late inbound messages", async () => {
  const f = await fixture();
  expect((await f.app.inject({ method: "POST", url: "/v1/plugins", payload: { id: "bot-fixture", publisher: "test", version: "1.0.0" } })).statusCode).toBe(201);
  const created = await f.app.inject({ method: "POST", url: "/v1/bot-connections", payload: {
    adapterId: "test-onebot", displayName: "群聊", enabled: true, config: { allowedGroupIds: ["group-1"] },
  } });
  await f.botManager.settle();
  const disabled = await f.app.inject({ method: "PATCH", url: "/v1/plugins/bot-fixture", payload: { enabled: false } });
  expect(disabled.statusCode).toBe(200);
  expect(f.stop).toHaveBeenCalled();
  await f.emit(); await f.botManager.settle();
  expect(f.send).not.toHaveBeenCalled();
  const connections = (await f.app.inject({ method: "GET", url: "/v1/bot-connections" })).json().connections;
  expect(connections.find((item: { id: string }) => item.id === created.json().id).enabled).toBe(false);
});

it("completes simultaneously queued members through the full API loop without SQLite write contention", async () => {
  const f = await fixture();
  await f.app.inject({ method: "POST", url: "/v1/bot-connections", payload: {
    adapterId: "test-onebot", displayName: "并行群聊", enabled: true, config: { allowedGroupIds: ["group-1"] },
  } });
  await f.botManager.settle();
  await Promise.all([f.emit("member-a", "parallel-1"), f.emit("member-b", "parallel-2")]);
  await f.botManager.settle();
  const turns = await f.client.execute("SELECT status FROM turns WHERE id LIKE 'bt_%'");
  expect(turns.rows).toHaveLength(2);
  expect(turns.rows.every(row => row.status === "Completed")).toBe(true);
  expect(f.send).toHaveBeenCalledTimes(2);
});

it("revoking a plugin grant stops its connections before returning", async () => {
  const f = await fixture();
  await f.app.inject({ method: "POST", url: "/v1/plugins", payload: { id: "bot-fixture", publisher: "test", version: "1.0.0" } });
  const grant = await f.app.inject({ method: "POST", url: "/v1/plugins/bot-fixture/grants", payload: { permission: "network", scope: "bot" } });
  expect(grant.statusCode).toBe(201);
  await f.app.inject({ method: "POST", url: "/v1/bot-connections", payload: {
    adapterId: "test-onebot", displayName: "群聊", enabled: true, config: { allowedGroupIds: ["group-1"] },
  } });
  await f.botManager.settle();
  const revoked = await f.app.inject({ method: "DELETE", url: `/v1/plugins/bot-fixture/grants/${grant.json().id}` });
  expect(revoked.statusCode).toBe(200);
  expect(f.stop).toHaveBeenCalled();
  await f.emit(); await f.botManager.settle();
  expect(f.send).not.toHaveBeenCalled();
  expect((await f.botManager.list())[0]!.enabled).toBe(false);
});
