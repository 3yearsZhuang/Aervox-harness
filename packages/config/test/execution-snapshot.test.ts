import { expect, it } from "vitest";
import { loadExecutionConfig, snapshotExecutionConfig } from "../src/index.js";

it("keeps host and derived execution consumers on the same captured configuration", () => {
  const config = loadExecutionConfig({ AERVOX_LOOP_PROVIDER: "replay", AERVOX_ADMIN_IDS: "trusted", AERVOX_MODEL_ROUTING: "true" });
  const host = snapshotExecutionConfig(config);
  const application = snapshotExecutionConfig(host);
  config.loopProvider = "llm"; config.adminIds.push("later");
  (config.modelRoutingFeatureFlags as Set<string>).clear();
  expect(host.loopProvider).toBe("replay"); expect(application.loopProvider).toBe("replay");
  expect(host.adminIds).toEqual(["trusted"]); expect(application.adminIds).toEqual(["trusted"]);
  expect(host.modelRoutingFeatureFlags.has("model_routing")).toBe(true);
  expect(application.modelRoutingFeatureFlags.has("model_routing")).toBe(true);
  expect(application.modelRoutingFeatureFlags).toEqual(host.modelRoutingFeatureFlags);
  expect(Object.isFrozen(host)).toBe(true);
});
