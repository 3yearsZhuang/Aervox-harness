/**
 * Aervox｜思隅 @aervox/config — CR-034 模型路由 Feature Flags 单元测试
 */
import { describe, expect, it } from "vitest";
import {
  loadApiConfig,
  loadModelRoutingFeatureFlags,
  loadWorkerConfig,
  MODEL_ROUTING_FEATURE_FLAGS,
} from "../src/index.js";

describe("loadModelRoutingFeatureFlags", () => {
  it("默认全关：空环境输入返回空集合（fail-closed）", () => {
    const flags = loadModelRoutingFeatureFlags({});
    expect(flags.size).toBe(0);
    for (const flag of MODEL_ROUTING_FEATURE_FLAGS) {
      expect(flags.has(flag)).toBe(false);
    }
  });

  it("支持 1 与 true 解析为开启（不区分大小写与首尾空格）", () => {
    const flags = loadModelRoutingFeatureFlags({
      AERVOX_MODEL_ROUTING: " 1 ",
      AERVOX_CAPABILITY_TIERING: "True",
      AERVOX_RULE_RESPONSE: "0",
      AERVOX_LOCAL_RUNTIME_HOST: "false",
    });

    expect(flags.has("model_routing")).toBe(true);
    expect(flags.has("capability_tiering")).toBe(true);
    expect(flags.has("rule_response")).toBe(false);
    expect(flags.has("local_runtime_host")).toBe(false);
  });

  it("loadApiConfig 与 loadWorkerConfig 均挂载 modelRoutingFeatureFlags", () => {
    const env = {
      AERVOX_MODEL_ROUTING: "true",
      AERVOX_RULE_RESPONSE: "1",
    };
    const apiCfg = loadApiConfig(env);
    expect(apiCfg.modelRoutingFeatureFlags.has("model_routing")).toBe(true);
    expect(apiCfg.modelRoutingFeatureFlags.has("rule_response")).toBe(true);
    expect(apiCfg.modelRoutingFeatureFlags.has("capability_tiering")).toBe(false);

    const workerCfg = loadWorkerConfig(env);
    expect(workerCfg.modelRoutingFeatureFlags.has("model_routing")).toBe(true);
    expect(workerCfg.modelRoutingFeatureFlags.has("rule_response")).toBe(true);
    expect(workerCfg.modelRoutingFeatureFlags.has("capability_tiering")).toBe(false);
  });
});
