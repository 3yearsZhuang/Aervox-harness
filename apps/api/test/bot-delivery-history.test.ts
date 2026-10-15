import { expect, it, vi } from "vitest";
import { createInMemoryDatabase, createProactiveVaultCipher, SqliteConversationRepository, botDeliveries } from "@aervox/repositories";
import type { BotAdapterContribution } from "@aervox/host-plugin-api";
import { SqliteBotRepository } from "@aervox/repositories";
import { BotManager } from "../src/modules/ecosystem/bots/manager.js";

vi.mock("../src/modules/companion/conversation/index.js", () => ({
  acceptConversationTurn: vi.fn(), executeAcceptedConversationTurn: vi.fn(),
}));

it("retries a delivery outside recent history without allowing another connection to access it", async () => {
  const { db, cleanup } = await createInMemoryDatabase();
  const store = new SqliteBotRepository(db);
  const adapter: BotAdapterContribution = {
    id: "test", platform: "test", displayName: "Test",
    capabilities: { directMessages: false, groupMessages: true, login: false, maxTextLength: 2000 },
    create: context => ({
      start: async () => { await context.setState("connected", { accountId: "bot" }); },
      send: async () => ({ status: "accepted" }), stop: async () => {},
    }),
  };
  const manager = new BotManager({
    store, conversations: new SqliteConversationRepository(db), conversationDeps: {},
    adapters: () => [{ pluginId: "test", adapter }], pluginEnabled: async () => true,
    cipher: async () => createProactiveVaultCipher(new Uint8Array(32), "test"),
  });
  try {
    const connection = await manager.create({ adapterId: "test", displayName: "Test", enabled: true, config: { allowedGroupIds: ["group"] } });
    const another = await manager.create({ adapterId: "test", displayName: "Other", enabled: true });
    await manager.settle();
    await store.enqueue({ id: "inbox", connectionId: connection.id, sessionId: "session", connectionRevision: connection.revision,
      state: "delivery_failed", createdAt: "2026-01-01", messageJson: JSON.stringify({
        accountId: "bot", senderId: "member", mentions: ["bot"], address: { kind: "group", conversationId: "group", senderId: "member" },
      }) });
    await db.insert(botDeliveries).values(Array.from({ length: 205 }, (_, index) => ({
      id: `delivery-${index}`, connectionId: connection.id, inboxId: "inbox", partIndex: index,
      text: `Text ${index}`, status: index === 0 ? "unknown" : "accepted", createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    })));
    expect((await manager.deliveries(connection.id)).some(delivery => delivery.id === "delivery-0")).toBe(false);
    await expect(manager.retry(another.id, "delivery-0")).rejects.toThrow("bot_delivery_not_retryable");
    await expect(manager.retry(connection.id, "delivery-0")).resolves.toMatchObject({ id: "delivery-0", status: "queued", text: "Text 0" });
    expect(await store.getDelivery(connection.id, "delivery-0")).toMatchObject({ status: "queued" });
  } finally { await manager.close(); await cleanup(); }
});
