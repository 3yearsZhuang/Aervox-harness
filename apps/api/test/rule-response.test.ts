/**
 * Aervox｜思隅 @aervox/api — CR-044/N2b 确定性规则响应 Provider 测试
 */
import { describe, it, expect } from "vitest";
import {
  RuleResponseProvider,
  createRuleResponseProvider,
} from "../src/modules/conversation/rule-response-provider.js";
import type { ModelRequest } from "@aervox/agent-loop";

describe("CR-044 N2b: 对话侧 L2 确定性规则回应 Provider", () => {
  const makeRequest = (userMessage: string): ModelRequest => ({
    context: {
      messages: [{ role: "user", content: userMessage }],
    },
    tools: [],
  });

  it("问候语句触发确定性问候规则回应", async () => {
    const provider = createRuleResponseProvider({ personaName: "小思" });
    const chunks = [];
    for await (const chunk of provider.stream(makeRequest("你好呀"))) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const text = chunks.map((c) => c.text).join("");
    expect(text).toContain("我是小思");
    expect(text).toContain("纯本地确定性离线模式");
    expect(chunks[chunks.length - 1].isFinal).toBe(true);
  });

  it("状态查询触发包含原因的系统离线状态说明", async () => {
    const provider = createRuleResponseProvider({
      personaName: "小思",
      reason: "cloud_timeout_and_local_offline",
    });
    const chunks = [];
    for await (const chunk of provider.stream(makeRequest("当前系统状态怎么样？离线了吗？"))) {
      chunks.push(chunk);
    }

    const text = chunks.map((c) => c.text).join("");
    expect(text).toContain("【思隅本地运行状态】");
    expect(text).toContain("L2（确定性规则兜底）");
    expect(text).toContain("cloud_timeout_and_local_offline");
  });

  it("帮助查询触发离线核心能力引导", async () => {
    const provider = createRuleResponseProvider();
    const chunks = [];
    for await (const chunk of provider.stream(makeRequest("你能帮我做什么？help"))) {
      chunks.push(chunk);
    }

    const text = chunks.map((c) => c.text).join("");
    expect(text).toContain("支持以下核心本地功能");
    expect(text).toContain("间隔复习");
  });

  it("未知问询诚实标记离线兜底与原始文本摘要", async () => {
    const provider = createRuleResponseProvider();
    const chunks = [];
    for await (const chunk of provider.stream(makeRequest("给我写一篇关于量子力学的论文"))) {
      chunks.push(chunk);
    }

    const text = chunks.map((c) => c.text).join("");
    expect(text).toContain("【离线规则回应】");
    expect(text).toContain("给我写一篇关于量子力学的论文");
    expect(text).toContain("L2 级");
  });

  it("provider 携带权威 L2 routingSnapshot 元数据", () => {
    const provider = new RuleResponseProvider();
    expect(provider.routingSnapshot.tier).toBe("L2");
    expect(provider.routingSnapshot.localAttestation).toBe(true);
    expect(provider.routingSnapshot.reason).toBe("rule_offline_deterministic");
  });
});
