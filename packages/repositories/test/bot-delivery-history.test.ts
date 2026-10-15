import { expect, it } from "vitest";
import { createInMemoryDatabase, SqliteBotRepository, botDeliveries } from "../src/index.js";

it("lists the latest 200 deliveries and resolves older IDs only within their connection", async () => {
  const { db, cleanup } = await createInMemoryDatabase();
  const store = new SqliteBotRepository(db);
  try {
    await store.createConnection({ id: "connection", adapterId: "test", pluginId: "test", displayName: "Test", createdAt: "2026-01-01" });
    await store.enqueue({ id: "inbox", connectionId: "connection", sessionId: "session", messageJson: "{}", connectionRevision: 1, state: "done", createdAt: "2026-01-01" });
    await db.insert(botDeliveries).values(Array.from({ length: 205 }, (_, index) => ({
      id: `delivery-${index}`, connectionId: "connection", inboxId: "inbox", partIndex: index,
      text: `Text ${index}`, status: "accepted", createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    })));
    const recent = await store.listDeliveries("connection");
    expect(recent).toHaveLength(200);
    expect(recent[0]?.id).toBe("delivery-204");
    expect(recent.at(-1)?.id).toBe("delivery-5");
    expect(await store.getDelivery("connection", "delivery-0")).toMatchObject({ id: "delivery-0", text: "Text 0" });
    expect(await store.getDelivery("another-connection", "delivery-0")).toBeNull();
    expect(await store.getDelivery("connection", "missing")).toBeNull();
  } finally { await cleanup(); }
});
