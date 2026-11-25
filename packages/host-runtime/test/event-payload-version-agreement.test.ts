import { describe, expect, it } from "vitest";
import {
  EVENT_PAYLOAD_VERSION as CORE_VERSION,
  SUPPORTED_EVENT_PAYLOAD_VERSIONS as CORE_SUPPORTED,
  isSupportedEventPayloadVersion as coreAccepts,
} from "@aervox/core/ports";
import {
  EVENT_PAYLOAD_VERSION as CONTRACTS_VERSION,
  SUPPORTED_EVENT_PAYLOAD_VERSIONS as CONTRACTS_SUPPORTED,
  isSupportedEventPayloadVersion as contractsAccepts,
  turnStreamEventSchema,
} from "@aervox/contracts";

/**
 * 事件信封版本在两侧各有一份源码常量：`@aervox/core` 不能依赖
 * `@aervox/contracts`（ADR-021 零运行时依赖），客户端包 `@aervox/api-client`
 * 又只能依赖 contracts。因此一致性必须由宿主侧锁定——任一侧提升版本而另一侧
 * 未同步，写侧产出的版本就会被读侧拒绝，或反之被放行。
 */
describe("event payload version agreement across packages", () => {
  it("declares the same current version", () => {
    expect(CORE_VERSION).toBe(CONTRACTS_VERSION);
  });

  it("declares the same supported set", () => {
    expect([...CORE_SUPPORTED]).toEqual([...CONTRACTS_SUPPORTED]);
  });

  it("agrees on every version decision", () => {
    const probes = [0, 1, 2, 3, 99, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
      "1", null, undefined, {}, []] as unknown[];
    for (const probe of probes) {
      expect(coreAccepts(probe), `core vs contracts for ${String(probe)}`)
        .toBe(contractsAccepts(probe));
    }
  });

  it("rejects an event whose envelope version is unsupported", () => {
    const base = {
      eventId: "tev_1",
      turnId: "turn_1",
      sequence: 1,
      eventType: "delta",
      occurredAt: "2026-11-26T00:00:00.000Z",
      data: { text: "x" },
    };
    expect(turnStreamEventSchema.safeParse({ ...base, payloadVersion: CONTRACTS_VERSION }).success).toBe(true);
    // A future version must fail schema validation rather than pass through and
    // be rendered with current-version field assumptions.
    const bumped = turnStreamEventSchema.safeParse({ ...base, payloadVersion: CONTRACTS_VERSION + 1 });
    expect(bumped.success).toBe(false);
  });
});
