import { describe, expect, it } from "vitest";
import { normalizeTurnIntent, renderTurnIntentMessage, turnIntentHash } from "../src/conversation-turn-intent.js";

const input = { sessionId: "session", message: { content: "exact text" } };
const hash = (patch: Partial<Parameters<typeof normalizeTurnIntent>[0]> = {}, actor?: string) =>
  turnIntentHash(normalizeTurnIntent({ ...input, ...patch }, "local-v1", actor));

describe("versioned Turn intent identity", () => {
  it("normalizes omitted effective defaults and JSON object order without changing array order", () => {
    expect(hash()).toBe(hash({ message: { content: "exact text", contentType: "text", attachments: [] }, metadata: {}, references: [], toolApprovalMode: "ask" }));
    expect(hash({ metadata: { b: [1, 2], a: { z: true, x: null } } })).toBe(hash({ metadata: { a: { x: null, z: true }, b: [1, 2] } }));
    expect(hash({ metadata: { b: [1, 2] } })).not.toBe(hash({ metadata: { b: [2, 1] } }));
    expect(hash()).toMatch(/^turn-intent-v1:[a-f0-9]{64}$/);
  });
  it.each([
    { sessionId: "other" }, { message: { content: "changed" } }, { message: { content: "exact text", contentType: "markdown" as const } },
    { message: { content: "exact text", attachments: [{ attachmentId: "a" }] } },
    { references: [{ sourceId: "source", sourceVersion: "2" }] }, { metadata: { mode: "focus" } }, { toolApprovalMode: "full_access" as const },
  ])("distinguishes business inputs: %j", patch => { expect(hash(patch)).not.toBe(hash()); });
  it("binds only the trusted actor and applies Bot policy before computing identity", () => {
    expect(hash({}, "owner")).not.toBe(hash({}, "other"));
    const first = normalizeTurnIntent({ ...input, metadata: { private: "ignored" }, toolApprovalMode: "full_access" }, "bot-group-member-v1");
    expect(first.metadata).toEqual({}); expect(first.toolApprovalMode).toBe("ask");
    expect(turnIntentHash(first)).toBe(turnIntentHash(normalizeTurnIntent(input, "bot-group-member-v1")));
    expect(turnIntentHash(first)).not.toBe(hash());
  });
  it.each([undefined, NaN, Infinity, 1n, () => true, Symbol("bad"), new Date(), new Map(), new Set()])("rejects non-JSON metadata values without lossy fallback: %s", value => {
    expect(() => hash({ metadata: { value } })).toThrow("invalid_turn_intent_json");
  });
  it("rejects cycles, preserves JSON-looking strings and detaches nested caller objects", () => {
    const metadata: Record<string, unknown> = {}; metadata.self = metadata;
    expect(() => hash({ metadata })).toThrow("invalid_turn_intent_json");
    expect(hash({ metadata: { value: "[Circular]" } })).not.toBe(hash({ metadata: {} }));
    const nested = { value: { a: [1] } };
    const normalized = normalizeTurnIntent({ ...input, metadata: nested }, "local-v1");
    const before = turnIntentHash(normalized); nested.value.a.push(2);
    expect(turnIntentHash(normalized)).toBe(before);
  });
  it("keeps structured attachments distinct even when their rendered text collides", () => {
    const first = normalizeTurnIntent({ ...input, message: { content: "hello", attachments: [{ attachmentId: "a", name: "document" }] } }, "local-v1");
    const second = normalizeTurnIntent({ ...input, message: { content: renderTurnIntentMessage(first) } }, "local-v1");
    expect(renderTurnIntentMessage(first)).toBe(renderTurnIntentMessage(second));
    expect(turnIntentHash(first)).not.toBe(turnIntentHash(second));
  });
});
