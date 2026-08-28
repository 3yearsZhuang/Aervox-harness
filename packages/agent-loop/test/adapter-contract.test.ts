/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 6 DSH/pi Adapter 契约测试
 *
 * 覆盖 ADR-010 + reference-design-transfer §1.1：
 * - concludeAdapterBatch：上游 any/every 批次收紧为 Aervox `all-results-conclude`
 *   （空/全结论/全不结论/混合批次一律拒绝并回传声明策略，不静默放行 any）；
 * - verifyAdapterManifest：固定 SHA 复核 + 许可证白名单（AGPL 拒绝）+ 策略白名单；
 * - JSON 行协议编解码（合法/非法）；
 * - createSimAdapterDriver 双实现（dsh-any / pi-every）+ drainAdapterDriver：
 *   事件收集、收紧判定、未声明批次协议缺陷。
 */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_ADAPTER_LICENSES,
  concludeAdapterBatch,
  createSimAdapterDriver,
  decodeAdapterLine,
  drainAdapterDriver,
  encodeAdapterLine,
  verifyAdapterManifest,
} from "../src/index.js";
import type { AdapterManifest } from "../src/index.js";

const dshManifest: AdapterManifest = {
  adapterId: "dsh",
  version: "1.0",
  sha256: "abc123",
  license: "MIT",
  terminationPolicy: "any",
};

const piManifest: AdapterManifest = {
  adapterId: "pi",
  version: "1.0",
  sha256: "def456",
  license: "MIT",
  terminationPolicy: "every",
};

const request = {
  turnId: "turn_1",
  sessionId: "session_1",
  attemptId: "attempt_1",
  userMessage: "帮我总结",
  tools: [{ name: "notes_search", description: "x", readOnly: true }],
};

describe("阶段 6 concludeAdapterBatch（any/every 收紧为 all-results-conclude）", () => {
  it("全结论批次 → concluded（两种上游语义均接受）", () => {
    expect(concludeAdapterBatch("every", { concludes: [true, true] })).toEqual({ concluded: true });
    expect(concludeAdapterBatch("any", { concludes: [true, true] })).toEqual({ concluded: true });
  });

  it("空批次 → empty_batch（无可收敛声明）", () => {
    expect(concludeAdapterBatch("every", { concludes: [] })).toEqual({ concluded: false, reason: "empty_batch" });
  });

  it("全不结论 → none_concluded（host 续跑/预算收敛）", () => {
    expect(concludeAdapterBatch("every", { concludes: [false, false] })).toEqual({
      concluded: false,
      reason: "none_concluded",
    });
  });

  it("混合批次 → 一律拒绝（mixed_batch），不静默放行 any 声明；审计回传声明策略", () => {
    // pi every：混合批次拒绝
    expect(concludeAdapterBatch("every", { concludes: [true, false] })).toEqual({
      concluded: false,
      reason: "mixed_batch",
      declaredPolicy: "every",
    });
    // dsh any：Aervox 严格策略同样拒绝（reference-design-transfer §1.1：必须收紧，不静默放行）
    expect(concludeAdapterBatch("any", { concludes: [true, false] })).toEqual({
      concluded: false,
      reason: "mixed_batch",
      declaredPolicy: "any",
    });
  });
});

describe("阶段 6 verifyAdapterManifest（TC-CONTRACT-STREAM-001 准入复核）", () => {
  it("固定 SHA + 许可证 + 策略均通过 → ok", () => {
    expect(verifyAdapterManifest(dshManifest, { adapterId: "dsh", sha256: "abc123" })).toEqual({
      ok: true,
      manifest: dshManifest,
    });
  });

  it("SHA 失配 → sha_mismatch（版本锁定复核失败，准入拒绝）", () => {
    expect(verifyAdapterManifest(dshManifest, { sha256: "tampered" })).toEqual({
      ok: false,
      error: "sha_mismatch",
    });
  });

  it("adapterId 失配 → adapter_id_mismatch", () => {
    expect(verifyAdapterManifest(piManifest, { adapterId: "dsh" })).toEqual({ ok: false, error: "adapter_id_mismatch" });
  });

  it("许可证白名单：MIT 通过；AGPL 等强 copyleft 拒绝（ADR-010）", () => {
    expect(ALLOWED_ADAPTER_LICENSES).toContain("MIT");
    expect(verifyAdapterManifest({ ...dshManifest, license: "AGPL-3.0" }, {})).toEqual({
      ok: false,
      error: "license_not_allowed",
    });
  });

  it("未知策略 → policy_not_supported", () => {
    expect(
      verifyAdapterManifest({ ...dshManifest, terminationPolicy: "every" as never, }, { adapterId: "dsh" }),
    ).toEqual({ ok: true, manifest: expect.objectContaining({ terminationPolicy: "every" }) });
    expect(verifyAdapterManifest({ ...dshManifest, terminationPolicy: "unknown" as never }, {})).toEqual({
      ok: false,
      error: "policy_not_supported",
    });
  });
});

describe("阶段 6 JSON 行协议编解码", () => {
  it("encode/decode 往返（hello/request/event/batch/done/error）", () => {
    const hello = { kind: "hello" as const, manifest: dshManifest };
    expect(decodeAdapterLine(encodeAdapterLine(hello))).toEqual(hello);
    const req = { kind: "request" as const, id: "r1", request };
    expect(decodeAdapterLine(encodeAdapterLine(req))).toEqual(req);
    const ev = { kind: "event" as const, id: "r1", event: { type: "delta" as const, text: "hi" } };
    expect(decodeAdapterLine(encodeAdapterLine(ev))).toEqual(ev);
    const batch = { kind: "batch" as const, id: "r1", concludes: [true, false] };
    expect(decodeAdapterLine(encodeAdapterLine(batch))).toEqual(batch);
    expect(decodeAdapterLine(encodeAdapterLine({ kind: "done" as const, id: "r1" }))).toEqual({ kind: "done", id: "r1" });
    expect(decodeAdapterLine(encodeAdapterLine({ kind: "error" as const, id: "r1", message: "boom" }))).toEqual({
      kind: "error",
      id: "r1",
      message: "boom",
    });
  });

  it("非法行拒绝（缺 kind / shape 错误 / 未知 kind）", () => {
    expect(() => decodeAdapterLine('{"nokind":1}')).toThrow(/missing kind/);
    expect(() => decodeAdapterLine(JSON.stringify({ kind: "hello", manifest: { adapterId: 1 } }))).toThrow(
      /hello.manifest/,
    );
    expect(() => decodeAdapterLine(JSON.stringify({ kind: "batch", id: "r", concludes: [1] }))).toThrow(
      /batch.concludes/,
    );
    expect(() => decodeAdapterLine(JSON.stringify({ kind: "whoops" }))).toThrow(/unknown kind/);
  });
});

describe("阶段 6 createSimAdapterDriver + drainAdapterDriver（双实现 + 收紧）", () => {
  it("pi-every 模拟器：全结论批次 → concluded；事件流含 delta 与 batch", async () => {
    const driver = createSimAdapterDriver({
      manifest: piManifest,
      script: [
        { type: "delta", text: "pi 子代理已执行" },
        { type: "batch", concludes: [true, true] },
      ],
    });
    const outcome = await drainAdapterDriver(driver, request);
    expect(outcome.events.map((e) => e.type)).toEqual(["delta", "batch"]);
    expect(outcome.decision).toEqual({ concluded: true });
    expect(outcome.protocolError).toBeUndefined();
  });

  it("dsh-any 模拟器 + 混合批次：收紧为 mixed_batch 拒绝（不静默放行）", async () => {
    const driver = createSimAdapterDriver({
      manifest: dshManifest,
      script: [
        { type: "delta", text: "dsh 子代理：部分工具已结算" },
        { type: "batch", concludes: [true, false] },
      ],
    });
    const outcome = await drainAdapterDriver(driver, request);
    expect(outcome.decision).toEqual({ concluded: false, reason: "mixed_batch", declaredPolicy: "any" });
  });

  it("未声明批次（协议缺陷）→ batch_not_declared 且按无结论收敛", async () => {
    const driver = createSimAdapterDriver({
      manifest: dshManifest,
      script: [{ type: "delta", text: "无批次声明" }],
    });
    const outcome = await drainAdapterDriver(driver, request);
    expect(outcome.protocolError).toBe("batch_not_declared");
    expect(outcome.decision).toEqual({ concluded: false, reason: "empty_batch" });
  });

  it("dsh-any 与 pi-every 模拟器对同一「全不结论」批次产出同一判定（无结论）", async () => {
    const dsh = await drainAdapterDriver(
      createSimAdapterDriver({ manifest: dshManifest, declaresEnds: [false, false] }),
      request,
    );
    const pi = await drainAdapterDriver(
      createSimAdapterDriver({ manifest: piManifest, declaresEnds: [false, false] }),
      request,
    );
    expect(dsh.decision).toEqual({ concluded: false, reason: "none_concluded" });
    expect(pi.decision).toEqual(dsh.decision);
  });
});