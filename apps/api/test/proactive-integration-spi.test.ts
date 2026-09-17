import { describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  type AervoxDatabase,
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveProfileRepository,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import {
  ProactiveIntegrationManager,
  type ProactiveIntegrationProvider,
  type ProactiveIntegrationContext,
} from "../src/modules/proactive/proactive/integration-manager.js";

describe("Proactive Integration SPI extensibility", () => {
  it("allows registering custom integration providers and routes sync via registry", async () => {
    const database = await createInMemoryDatabase();
    const db: AervoxDatabase = database.db;
    const client: Client = database.client;
    const cleanup = database.cleanup;

    try {
      const intelligenceRepo = new SqliteProactiveIntelligenceRepository(db);
      const profileRepo = new SqliteProactiveProfileRepository(db);
      const manager = new ProactiveIntegrationManager(intelligenceRepo, profileRepo);

      // Verify default providers registered
      expect(manager.getProvider("home_assistant")).toBeDefined();
      expect(manager.getProvider("xiaomi_health")).toBeDefined();
      expect(manager.listProviders()).toHaveLength(2);

      // Create a custom IoT provider (e.g., Mock Apple Health / Custom Sensor)
      let customSyncCalled = false;
      const customProvider: ProactiveIntegrationProvider = {
        providerId: "apple_health",
        displayName: "Apple Health Integration",
        requiredSourceKey: "restricted.profile",
        async sync(_tenant, connectionId, _ctx) {
          customSyncCalled = true;
          return { synced: 42, connectionId };
        },
      };

      manager.registerProvider(customProvider);
      expect(manager.getProvider("apple_health")).toBe(customProvider);
      expect(manager.listProviders()).toHaveLength(3);

      // Verify custom provider execution through manager
      const provider = manager.getProvider("apple_health");
      expect(provider).toBeDefined();
      const ctx = manager.createContext();
      const result = await provider!.sync({ workspaceId: "local", subjectUserId: "local" }, "conn_apple_1", ctx);
      expect(customSyncCalled).toBe(true);
      expect(result.synced).toBe(42);
    } finally {
      await cleanup();
    }
  });
});
